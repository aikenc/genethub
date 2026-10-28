import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const stats = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: sorted.length, p50: Math.round(sorted[Math.ceil(sorted.length * .5)-1] ?? 0), p95: Math.round(sorted[Math.ceil(sorted.length * .95)-1] ?? 0), max: Math.round(sorted.at(-1) ?? 0) };
};
for (const bodies of ["all", "focused", "focused-separate-control", "focused-budgeted-start"] as const) defineSpecialty({
  id: `specialty.team-scale.${bodies}-bodies`,
  title: `10 machines, 200 active Agent members: ${bodies} transcript subscriptions across one shared WAN`,
  oracle: "All 200 real sessions finish, subscribed turns complete once, management RPC p95 stays below 1500ms with no failures during output load",
  catches: ["team overview subscribes every transcript", "per-workspace query amplification", "aggregate pacing fails with many nodes"],
  tags: ["team-scale", "connectivity", "capacity"], llm: { default: "none" },
  expectedDurationMs: 150000, timeoutMs: 360000,
  stages: ["real-fleet", "output-and-control", "verify-every-member"],
  resources: { environments: 1, cpu: 12, memoryMb: 12288, io: 2, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "agent-sdk", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const fleet = await t.stage("real-fleet", () => openScaleFleet(t, 10, 20, bodies === "focused-separate-control"));
  const completions = new Map<string, number>();
  let events = 0;
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const nativeMemory = () => fleet.nodes.reduce((sum, node) => {
    try { return sum + Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${node.pid}/status`, "utf8"))?.[1] ?? 0); } catch { return sum; }
  }, 0);
  const before = fleet.link.stats();
  try {
    for (const node of fleet.nodes) for (const id of bodies === "all" ? node.sessions : node.sessions.slice(0, 1)) {
      completions.set(id, 0);
      await node.client.subscribe(id, { onEvent(event) {
        events++;
        if ((event as { event?: { type?: string } }).event?.type === "turnCompleted") completions.set(id, completions.get(id)! + 1);
      }, onResync() {} });
    }
    fleet.link.setProfile({ bandwidthMbps: 5, rttMs: 200 });
    const batchAt = performance.now();
    let batchBytes = 0;
    await Promise.all(fleet.nodes.map(async node => {
      const reply = await node.control.call({ type: "session.list", payload: { workspaceId: null, includeArchived: false } });
      if (reply?.type !== "sessions" || reply.data.length !== 20) throw new Error("machine-wide batch omitted a member");
      batchBytes += Buffer.byteLength(JSON.stringify(reply));
    }));
    const batchMs = Math.round(performance.now() - batchAt);
    let perMemberMs: number | null = null;
    if (bodies === "all") {
      const start = performance.now();
      // Same 200 rows, one request per member, 10 concurrent machine consumers.
      await Promise.all(fleet.nodes.map(async node => {
        for (const workspaceId of node.workspaces) {
          const reply = await node.client.call({ type: "session.list", payload: { workspaceId, includeArchived: false } });
          if (reply?.type !== "sessions" || reply.data.length !== 1) throw new Error("per-member list omitted or mixed sessions");
        }
      }));
      perMemberMs = Math.round(performance.now() - start);
    }
    t.note(JSON.stringify({ phase: "query-baseline", bodies, batchRequests: 10, batchMs, batchBytes, perMemberRequests: bodies === "all" ? 200 : null, perMemberMs }));
    const startStats = fleet.link.stats();
    const begin = performance.now();
    const budgeted = bodies === "focused-budgeted-start";
    const sends = (async () => {
      const work = Array.from({ length: 20 }, (_, member) => fleet.nodes.map(node => ({ node, id: node.sessions[member]! }))).flat();
      const results: PromiseSettledResult<void>[] = [];
      for (let offset = 0; offset < work.length; offset += budgeted ? 20 : 200) {
        results.push(...await Promise.allSettled(work.slice(offset, offset + (budgeted ? 20 : 200)).map(({ node, id }) =>
          t.flows.main.sendPrompt(node.client, id, `Emit the deterministic scale trace for ${id}.`))));
        if (budgeted && offset + 20 < work.length) await pause(500);
      }
      return results;
    })();
    const samples: number[] = []; let rpcErrors = 0;
    await t.stage("output-and-control", async () => {
      while (performance.now() - begin < 30000) {
        await Promise.all(fleet.nodes.map(async node => {
          const start = performance.now();
          try { const reply = await node.control.call({ type: "workspace.list" }); if (reply?.type !== "workspaces") rpcErrors++; }
          catch { rpcErrors++; }
          samples.push(performance.now() - start);
        }));
        await pause(500);
      }
    });
    const busy = fleet.link.stats();
    fleet.link.setProfile({ bandwidthMbps: 1000, rttMs: 0 });
    const sent = await sends;
    t.note(JSON.stringify({ phase: "loaded", bodies, control: stats(samples), rpcErrors, sent: sent.filter(s => s.status === "fulfilled").length,
      forwardedBytes: busy.forwardedBytes.map((v,i) => v - startStats.forwardedBytes[i]!), peakQueuedBytes: busy.peakQueuedBytes,
      nativeDaemonRssMiB: Math.round(nativeMemory()/1024), workerAndProxyEventLoopMaxMs: Math.round(lag.max/1e6),
      sdkCompleted: fleet.nodes.map(n => readControlledAgentJournal(n.agent).filter(e => e.event === "answered").length),
      observedCompletions: [...completions.values()].reduce((a,b) => a+b,0) }));
    let completed = 0;
    let verificationError = "";
    await t.stage("verify-every-member", () => t.tools.waitUntil(async () => {
      const replies = await Promise.all(fleet.nodes.map(node => node.control.call({ type: "session.list", payload: { workspaceId: null, includeArchived: false } })));
      completed = replies.reduce((sum, reply, i) => sum + (reply?.type === "sessions" ? reply.data.filter(s => fleet.nodes[i]!.sessions.includes(s.id) && s.status === "idle" && !!s.latestReply).length : 0), 0);
      return completed === 200 && [...completions.values()].every(n => n === 1);
    }, 45000)).catch(error => { verificationError = error instanceof Error ? error.message : String(error); });
    const localCheck = await Promise.allSettled(fleet.nodes.map(async node => {
      const start = performance.now(); const reply = await node.opened.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: false } });
      return { ms: Math.round(performance.now() - start), completed: reply?.type === "sessions" ? reply.data.filter(s => s.status === "idle" && !!s.latestReply).length : 0 };
    }));
    t.note(JSON.stringify({ phase: "local-diagnostic", verificationError, nodes: localCheck.map(r => r.status === "fulfilled" ? r.value : { error: "local list timed out" }) }));
    const summary = { bodies, nativeMachines: 10, memberWorkspaces: 200, activeSessions: 200, bodySubscriptions: completions.size,
      dispatch: budgeted ? "20 sends per cohort, await acknowledgement then 500ms; staggered arrival, not 200 simultaneous starts" : "200 starts in one burst",
      independentControlOwners: fleet.nodes.filter(n => n.control.logicalConnectionId !== n.client.logicalConnectionId).length,
      shapedNodeTcpAccepted: busy.accepted,
      bandwidthMbps: 5, rttMs: 200, batchRequests: 10, batchMs, batchBytes, perMemberRequests: bodies === "all" ? 200 : null, perMemberMs,
      sent: sent.filter(s => s.status === "fulfilled").length, sendErrors: sent.filter(s => s.status === "rejected").length,
      control: stats(samples), rpcErrors, completed, subscribedCompletions: stats([...completions.values()]), events,
      loadForwardedBytes: busy.forwardedBytes.map((v,i) => v - startStats.forwardedBytes[i]!),
      totalForwardedBytes: busy.forwardedBytes.map((v,i) => v - before.forwardedBytes[i]!), peakQueuedBytes: busy.peakQueuedBytes,
      lateFrames: (fleet.relay.logTail().match(/lateFrameOverflow/g) ?? []).length };
    t.note(JSON.stringify(summary));
    t.assertions.assert(!verificationError && summary.sent === 200 && completed === 200 && [...completions.values()].every(n => n === 1), "remote completion verification did not establish all members: " + verificationError);
    if (!budgeted) t.note(JSON.stringify({classification:"legacy single-node-channel comparison",productionLatencyQualified:false,control:summary.control,rpcErrors}));
    else t.assertions.assert(samples.length >= 20 && rpcErrors === 0 && summary.control.p95 < 1500, "management interaction exceeded the proposed 1500ms p95 budget under 200 active members");
  } finally { lag.disable(); await fleet.dispose(); }
});

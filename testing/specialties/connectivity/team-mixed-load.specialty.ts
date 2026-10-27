import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0);
  return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};

// These exercise real Client traffic, not the Workbench's selection policy.
// The browser specialty must independently prove lazy loading and cancellation.
for (const [runningPerMachine, watchedPerMachine] of [[5, 5], [8, 8], [20, 8]] as const) defineSpecialty({
  id: `specialty.team-mixed.total200-running${10 * runningPerMachine}-watched${10 * watchedPerMachine}-preview2`,
  title: `200 stored sessions, ${10 * runningPerMachine} running / ${10 * watchedPerMachine} subscribed and two previews on both relay legs`,
  oracle: "All 200 summaries remain visible; only the requested tasks execute, each once; watched tasks deliver completion, every final body is exact, two overlapping 8MiB public previews are exact, and both catalog operations stay available with p95 below 1500ms",
  catches: ["catalog size is confused with body subscriptions", "preview traffic starves control or Agent output", "unwatched running tasks stop or repeat", "preview result is counted without actual load overlap"],
  tags: ["team-mixed", "team-mixed-sustained", "team-scale", "fabric-pool", "preview"], llm: { default: "none" },
  stages: ["fleet", "load", "recover"], expectedDurationMs: 180000, timeoutMs: 360000,
  resources: { environments: 1, cpu: 12, memoryMb: 16384, io: 2, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "agent-sdk", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client", "workspace.list", "session.list", "subscribe", "asset.preview"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  let measuring = false;
  const previewOperations: Array<Record<string, unknown>> = [];
  const started = new Map<string, { machine: number; operation: string; at: number }>();
  const measured: Array<{ machine: number; operation: string; requestId: string; start: number; finish: number; duration: number }> = [];
  const fleet = await t.stage("fleet", () => openScaleFleet(t, 10, 20, false, { automatic: true, bothLegs: true, nodeChannels: 2, floodIntervalMs: 150,
    nativeLog: "warn,diagnostic=debug,genet_daemon::dataplane::preview=debug", onDiagnostic(machine, event) {
      if (event.kind === "operation" && event.detail.operation === "asset.preview" && previewOperations.length < 4) {
        const { requestId, phase, durationMs, firstByteMs, transferMs } = event.detail;
        previewOperations.push({ machine, requestId, phase, at: Date.parse(event.at), durationMs, firstByteMs, transferMs });
      }
      if (!measuring || event.kind !== "operation" || !["workspace.list", "session.list"].includes(String(event.detail.operation)) || typeof event.detail.requestId !== "string") return;
      const id = event.detail.requestId;
      if (event.detail.phase === "start") started.set(id, { machine, operation: String(event.detail.operation), at: Date.parse(event.at) });
      else if (event.detail.phase === "finish") {
        const first = started.get(id); started.delete(id);
        if (first && measured.length < 512) measured.push({ machine, operation: first.operation, requestId: id, start: first.at, finish: Date.parse(event.at), duration: Number(event.detail.durationMs ?? 0) });
      }
    },
  }));
  const previewAbort = new AbortController();
  const previews: Array<Promise<{ bytes: number; firstByteMs: number | null; elapsedMs: number; exact: boolean; error?: string }>> = [];
  const seen = new Set<string>();
  let subscribed = 0;
  try {
    for (const node of fleet.nodes) {
      for (const sessionId of node.sessions.slice(0, watchedPerMachine)) {
        await node.client.subscribe(sessionId, {
          onEvent(event) { if (event.event.type === "turnCompleted") seen.add(sessionId); },
          onResync(snapshot, replayed) {
            const summary = (snapshot as { summary?: { status?: string; latestReply?: unknown } }).summary;
            if ((summary?.status === "idle" && summary.latestReply) || replayed.some(e => e.event.type === "turnCompleted")) seen.add(sessionId);
          },
        });
        subscribed++;
      }
    }
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
    payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const expectedPreview = hash(payload);
    const files = fleet.nodes.slice(0, 2).map((node, i) => {
      const name = `team-mixed-${i}.png`;
      writeFileSync(join(node.opened.workspaceRoot, name), payload);
      return { node, path: `${node.opened.rootHandle}/${name}` };
    });
    const owners = fleet.nodes.map(n => n.client.logicalConnectionId);
    const before = fleet.link.stats();
    fleet.link.setProfile({ bandwidthMbps: 5, rttMs: 200 });
    measuring = true;
    const start = performance.now();
    let previewsInFlight = 0, overlapQueries = 0;
    for (const file of files) {
      previewsInFlight++;
      const began = performance.now();
      previews.push(file.node.client.preview(file.node.opened.workspaceId, file.path, "original", previewAbort.signal).then(
        body => ({ bytes: body.bytes.byteLength, firstByteMs: body.transfer.firstByteMs, headWaitMs: body.transfer.elapsedMs - body.transfer.transferMs, firstBodyWaitMs: body.transfer.firstByteMs === null ? null : body.transfer.firstByteMs - (body.transfer.elapsedMs - body.transfer.transferMs), elapsedMs: Math.round(performance.now() - began), exact: hash(body.bytes) === expectedPreview }),
        error => ({ bytes: 0, firstByteMs: null, elapsedMs: Math.round(performance.now() - began), exact: false, error: error instanceof Error ? error.name : String(error) }),
      ).finally(() => { previewsInFlight--; }));
    }
    const sends = Promise.allSettled(fleet.nodes.flatMap(node => node.sessions.slice(0, runningPerMachine)
      .map(id => t.flows.main.sendPrompt(node.control, id, "Emit the deterministic 200-chunk reply."))));
    const timings = { workspaces: [] as number[], sessions: [] as number[] };
    const replyBytes = { workspaces: [] as number[], sessions: [] as number[] };
    let errors = 0, wrongCatalogs = 0, round = 0, peakRunning = 0;
    const fullConcurrencyAt: number[] = [];
    await t.stage("load", async () => {
      while (performance.now() - start < 30000) {
        const sessions = round++ % 2 === 1;
        const running = await Promise.all(fleet.nodes.map(async node => {
          const began = performance.now(), overlapped = previewsInFlight > 0;
          let running = 0, bytes = 0, elapsed: number;
          try {
            const reply = sessions
              ? await node.control.call({ type: "session.list", payload: { workspaceId: null, includeArchived: false } })
              : await node.control.call({ type: "workspace.list" });
            elapsed = performance.now() - began;
            bytes = Buffer.byteLength(JSON.stringify(reply) ?? "");
            if (sessions) {
              if (reply?.type !== "sessions") errors++;
              else {
                if (reply.data.length !== 20 || node.sessions.some(id => !reply.data.some(s => s.id === id))) wrongCatalogs++;
                running = reply.data.filter(s => s.status === "running").length;
              }
            } else if (reply?.type !== "workspaces") errors++;
          } catch { elapsed = performance.now() - began; errors++; }
          timings[sessions ? "sessions" : "workspaces"].push(elapsed);
          replyBytes[sessions ? "sessions" : "workspaces"].push(bytes);
          if (overlapped) overlapQueries++;
          return running;
        }));
        if (sessions) {
          const total = running.reduce((sum, n) => sum + n, 0);
          peakRunning = Math.max(peakRunning, total);
          if (total === runningPerMachine * 10) fullConcurrencyAt.push(performance.now() - start);
        }
        await pause(500);
      }
    });
    const busy = fleet.link.stats();
    measuring = false;
    t.note(JSON.stringify({ phase: "loaded", total: 200, running: runningPerMachine * 10, subscribed, previewCount: 2,
      rpc: { workspaces: quantiles(timings.workspaces), sessions: quantiles(timings.sessions) }, errors, wrongCatalogs, overlapQueries,
      replyBytes: { workspaces: quantiles(replyBytes.workspaces), sessions: quantiles(replyBytes.sessions) },
      completions: seen.size, peakRunning, fullConcurrencySamples: fullConcurrencyAt.length,
      fullConcurrencySpanMs: Math.round((fullConcurrencyAt.at(-1) ?? 0) - (fullConcurrencyAt[0] ?? 0)),
      bytes: busy.forwardedBytes.map((v, i) => v - before.forwardedBytes[i]!), peakQueuedBytes: busy.peakQueuedBytes }));
    // Preview deadlines apply while the weak profile is still in force.
    const remaining = Math.max(1, 120000 - (performance.now() - start));
    const deadline = setTimeout(() => previewAbort.abort(), remaining);
    let previewResults: Awaited<(typeof previews)[number]>[];
    try { previewResults = await Promise.all(previews); }
    finally { clearTimeout(deadline); }
    fleet.link.setProfile({ bandwidthMbps: 1000, rttMs: 0 });
    const observedPreviews = previewOperations.filter(event => event.phase === "start").slice(0, 2);
    const nativeLogsReady = await t.tools.waitUntil(() => observedPreviews.length === 2 && observedPreviews.every(event => {
      if (typeof event.machine !== "number" || typeof event.requestId !== "string") return false;
      const lines = stripVTControlCharacters(readFileSync(join(fleet.nodes[event.machine]!.lease.data, "logs", "daemon.log"), "utf8")).split("\n").filter(line => line.includes(event.requestId as string));
      return lines.some(line => line.includes("preview_stage_timing")) && lines.some(line => line.includes("data operation completed"));
    }), 3000).then(() => true, () => false);
    const logs = fleet.nodes.map(node => stripVTControlCharacters(readFileSync(join(node.lease.data, "logs", "daemon.log"), "utf8")).split("\n"));
    for (const machine of [0, 1]) {
      const began = previewOperations.find(event => event.machine === machine && event.phase === "start");
      const finished = previewOperations.find(event => event.machine === machine && event.phase === "finish");
      const requestId = typeof began?.requestId === "string" ? began.requestId : null;
      const rows = requestId ? logs[machine]!.filter(line => line.includes(requestId)) : [];
      const complete = rows.find(line => line.includes("data operation completed"));
      const stage = rows.find(line => line.includes("preview_stage_timing"));
      const field = (line: string | undefined, key: string) => {
        const value = new RegExp(`\\b${key}=(\\d+)`).exec(line ?? "")?.[1];
        return value === undefined ? null : Number(value);
      };
      const serverEndAt = complete ? Date.parse(complete.split(" ")[0]!) : null;
      const serverMs = field(complete, "duration_ms");
      const headWaitMs = typeof finished?.durationMs === "number" && typeof finished.transferMs === "number" ? finished.durationMs - finished.transferMs : null;
      const firstBodyWaitMs = typeof finished?.firstByteMs === "number" && headWaitMs !== null ? finished.firstByteMs - headWaitMs : null;
      t.note(JSON.stringify({ phase: "preview-start-causal", machine, nativeLogsReady, headWaitMs, firstBodyWaitMs, serverMs,
        ingressToHandlerMs: serverEndAt !== null && serverMs !== null && typeof began?.at === "number" ? serverEndAt - serverMs - began.at : null,
        native: Object.fromEntries(["worker_wait_us", "scan_us", "send_us", "read_us", "write_credit_us", "write_budget_us", "write_enqueue_us", "write_completion_us", "write_actor_queue_us", "write_actor_send_us", "write_wake_us", "finish_us"].map(key => [key, field(stage, key)])) }));
    }
    for (const operation of ["workspace.list", "session.list"]) {
      const causal = measured.filter(call => call.operation === operation).sort((a, b) => b.duration - a.duration).slice(0, 4).map(call => {
        const lines = logs[call.machine]!.filter(line => line.includes(call.requestId));
        const find = (name: string) => lines.find(line => line.includes(name));
        const decoded = find("RPC request decoded"), prepared = find("RPC response prepared"), completed = find("RPC exchange completed");
        const chunk = find("RPC request chunk received"), credited = find("RPC request credit returned"), dispatched = find("RPC request FIN dispatched");
        const at = (line: string | undefined) => line ? Date.parse(line.split(" ")[0]!) : NaN;
        const end = at(completed), duration = Number(/duration_ms=(\d+)/.exec(completed ?? "")?.[1] ?? NaN);
        return { machine: call.machine, clientMs: call.duration, responseBytes: Number(/response_bytes=(\d+)/.exec(prepared ?? "")?.[1] ?? NaN),
          ingressMs: Math.round(end - duration - call.start), bodyMs: Math.round(at(decoded) - (end - duration)),
          chunkMs: Math.round(at(chunk) - (end - duration)), creditMs: Math.round(at(credited) - at(chunk)),
          finDispatchMs: Math.round(at(dispatched) - at(credited)), finWakeMs: Math.round(at(decoded) - at(dispatched)),
          routerMs: Math.round(at(prepared) - at(decoded)), egressMs: Math.round(call.finish - at(prepared)), serverMs: duration,
          decoded: !!decoded, prepared: !!prepared, completed: !!completed };
      });
      t.note(JSON.stringify({ phase: "causal-catalog", operation, timings: causal }));
    }
    const sent = await sends;
    const expectedBody = hash(Array.from({ length: 200 }, (_, i) => `f${i} `).join(""));
    let exactBodies = 0, idleUntouched = 0, catalogCount = 0;
    await t.stage("recover", async () => {
      await Promise.all(fleet.nodes.map(async node => {
        const catalog = await node.control.call({ type: "session.list", payload: { workspaceId: null, includeArchived: false } });
        if (catalog?.type === "sessions") catalogCount += catalog.data.length;
        for (let i = 0; i < node.sessions.length; i++) {
          const reply = await node.client.call({ type: "session.get", payload: { sessionId: node.sessions[i]!, recentRounds: 1 } });
          if (reply?.type !== "snapshot") continue;
          const text = reply.data.items.filter(item => item.type === "assistantMessage")
            .map(item => item.type === "assistantMessage" ? item.text : "").join("");
          if (i < runningPerMachine) { if (reply.data.summary.status === "idle" && hash(text) === expectedBody) exactBodies++; }
          else if (reply.data.summary.status === "idle" && text === "") idleUntouched++;
        }
      }));
    });
    const sourceCounts = fleet.nodes.map(node => {
      const journal = readControlledAgentJournal(node.agent);
      return { prompts: journal.filter(e => e.event === "prompt").length, answered: journal.filter(e => e.event === "answered").length };
    });
    t.note(JSON.stringify({ phase: "result", catalogCount, exactBodies, idleUntouched, completions: seen.size,
      sends: sent.filter(s => s.status === "fulfilled").length, sourceCounts, previews: previewResults,
      retainedOwners: fleet.nodes.every((node, i) => node.client.logicalConnectionId === owners[i]) }));
    t.assertions.assert(subscribed === watchedPerMachine * 10 && seen.size === subscribed, "watched subscriptions did not deliver all completions");
    t.assertions.assert(peakRunning === runningPerMachine * 10 && fullConcurrencyAt.length >= 2 && fullConcurrencyAt.at(-1)! - fullConcurrencyAt[0]! >= 10000,
      "public summaries did not witness the requested concurrent running population over at least ten seconds");
    t.assertions.assert(catalogCount === 200 && wrongCatalogs === 0 && exactBodies === runningPerMachine * 10 && idleUntouched === 200 - runningPerMachine * 10,
      "stored, running and untouched session populations do not match the workload");
    t.assertions.assert(sent.every(s => s.status === "fulfilled") && sourceCounts.every(s => s.prompts === runningPerMachine && s.answered === runningPerMachine), "source tasks were lost, repeated or unexpectedly started");
    t.assertions.assert(errors === 0 && timings.workspaces.length >= 10 && timings.sessions.length >= 10 && Object.values(timings).every(samples => quantiles(samples).p95 < 1500), "catalog interaction exceeded the 1500ms p95 or availability target");
    t.assertions.assert(overlapQueries >= 10 && previewResults.every(r => r.exact && r.bytes === payload.length && r.firstByteMs !== null && r.firstByteMs <= 3000 && r.elapsedMs <= 120000), "two exact previews did not overlap interaction or meet first-byte/completion deadlines");
    t.assertions.assert(fleet.nodes.every((node, i) => node.client.logicalConnectionId === owners[i]), "weak-link load replaced a logical owner");
  } finally {
    previewAbort.abort();
    await Promise.allSettled(previews);
    await fleet.dispose();
  }
});

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { daemonEndpoint, defineSpecialty, observeFileOpens } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.cached-catalog.stalled-reconciliation",
  title: "Storage delays in a large project do not stall cached history or a different small project",
  oracle: "With 512 idle sessions in one project, one session in a separate small project, and verified 1ms OS open delays, 12 seconds of cached unscoped history and scoped small-project pages retain their IDs with p95<=2s; the slow project still owns its required fresh validation",
  catches: ["foreground expiry waits behind global reconciliation", "idle receipt polling amplifies storage latency", "missed inbox ticks catch up without yielding"],
  tags: ["core", "cached-catalog", "filesystem"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "command", env: "GENEHUB_STRACE", args: ["-h"], contains: "delay_enter" }],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem", "workbench-client"], productInterfaces: ["session.create", "session.page"],
  expectedDurationMs: 25000, timeoutMs: 120000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let observer: Awaited<ReturnType<typeof observeFileOpens>> | undefined;
  try {
    const hostPid = daemonEndpoint(o.daemon).localServerProof.pid;
    mkdirSync(join(t.env.data, "updates", "sessions"), { recursive: true });
    const ids = new Set<string>();
    for (let n = 0; n < 512; n++) ids.add(await t.flows.main.createBuiltinSession(o.client, o.workspaceId));
    const request = { type: "session.page" as const, payload: { requests: [{ workspaceId: o.workspaceId, cursor: null, limit: 20 }], includeArchived: true } };
    await o.client.call(request);
    const smallRoot = join(t.env.root, "small-project"); mkdirSync(smallRoot);
    const opened = await o.client.call({ type: "workspace.open", payload: { root: smallRoot } });
    if (opened?.type !== "workspace") throw new Error("small probe project did not open");
    const smallId = await t.flows.main.createBuiltinSession(o.client, opened.data.id);
    const smallRequest = { type: "session.page" as const, payload: { requests: [{ workspaceId: opened.data.id, cursor: null, limit: 20 }], includeArchived: true } };
    await o.client.call(smallRequest);
    // Unscoped history is the cached projection. A scoped read deliberately
    // validates its own files; exercise that promise on a different home so
    // the large project's physical I/O is not its freshness prerequisite.
    const cachedRequest = { type: "session.page" as const, payload: { requests: [{ workspaceId: null, cursor: null, limit: 20 }], includeArchived: true } };
    const allIds = new Set([...ids, smallId]);
    // Only this isolated Host is shaped. Many short operations model slow
    // storage; a single multi-second syscall would block both implementations.
    observer = await observeFileOpens(process.env.GENEHUB_STRACE!, hostPid,
      join(t.env.root, "storage-latency.trace"), "openat,openat2", { milliseconds: 1 });
    await t.tools.waitUntil(() => observer!.lines().some(line => line.includes("(DELAYED)")), 10000);
    t.note("OS storage fault confirmed by DELAYED syscall records: 1ms per open, only the isolated Host.");
    const end = Date.now() + 12000, cachedSamples: number[] = [], scopedSamples: number[] = [];
    while (Date.now() < end) {
      const at = performance.now();
      const reply = await o.client.call(cachedRequest, { timeoutMs: 30000 }).catch((error:unknown) => {
        const lines=observer!.lines(),opens=new Map<string,number>();
        for(const line of lines){
          const raw=/"([^"]*)"/.exec(line)?.[1]?.split("/").at(-1);
          if(!raw)continue;
          const name=/^s_[0-9a-f]+$/.test(raw)?"<session-directory>":raw;
          opens.set(name,(opens.get(name)??0)+1);
        }
        t.note(JSON.stringify({phase:"foreground-deadline",elapsedMs:Math.round(performance.now()-at),priorSamples:cachedSamples.length,
          delayedOsCalls:lines.filter(line=>line.includes("(DELAYED)")).length,
          topOpenLeaves:[...opens].sort((a,b)=>b[1]-a[1]).slice(0,12)}));
        throw error;
      });
      cachedSamples.push(performance.now() - at);
      t.assertions.assert(reply?.type === "sessionPages" && !reply.data[0]?.error && reply.data[0]?.sessions.length === 20
        && new Set(reply.data[0].sessions.map(s => s.id)).size === 20 && reply.data[0].sessions.every(s => allIds.has(s.id)), "storage load lost or duplicated cached page IDs");
      const smallAt = performance.now();
      const small = await o.client.call(smallRequest, { timeoutMs: 30000 });
      scopedSamples.push(performance.now() - smallAt);
      t.assertions.assert(small?.type === "sessionPages" && !small.data[0]?.error && small.data[0]?.sessions.length === 1 && small.data[0].sessions[0]?.id === smallId, "unrelated storage load lost the small project's row");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await observer.stop();
    const fresh = await o.client.call(request, { timeoutMs: 30000 });
    t.assertions.assert(fresh?.type === "sessionPages" && !fresh.data[0]?.error && fresh.data[0]?.sessions.length === 20 && new Set(fresh.data[0].sessions.map(row => row.id)).size === 20 && fresh.data[0].sessions.every(row => ids.has(row.id)), "the large project's fresh page did not recover after storage shaping");
    const delayed = observer.lines().filter(line => line.includes("(DELAYED)")).length;
    const statistics = (values: number[]) => {
      values.sort((a,b) => a-b);
      return { samples: values.length, p95Ms: values[Math.ceil(values.length * .95)-1]!, maxMs: values.at(-1)! };
    };
    const cached = statistics(cachedSamples), scoped = statistics(scopedSamples);
    t.note(JSON.stringify({ sessions: ids.size, perOpenDelayMs: 1, delayedOsCalls: delayed, cached, scoped }));
    t.assertions.assert(delayed > 0, "OS storage latency was not actually applied");
    t.assertions.assert([cached, scoped].every(result => result.samples >= 10 && result.p95Ms <= 2000), `storage-shaped cached or small-scope foreground exceeded 2s: ${JSON.stringify({ cached, scoped })}`);
  } finally { await observer?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

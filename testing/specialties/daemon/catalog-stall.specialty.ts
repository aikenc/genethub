import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { daemonEndpoint, defineSpecialty, observeFileOpens } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.cached-catalog.stalled-reconciliation",
  title: "Small per-file storage delays do not turn idle history into a foreground stall",
  oracle: "With 512 idle sessions and verified 1ms OS open delays, 12 seconds of real foreground pages retain their IDs with p95<=2s; the test also spans catalog expiry and repeated inbox ticks without introducing one long blocking syscall",
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
    // Only this isolated Host is shaped. Many short operations model slow
    // storage; a single multi-second syscall would block both implementations.
    observer = await observeFileOpens(process.env.GENEHUB_STRACE!, hostPid,
      join(t.env.root, "storage-latency.trace"), "openat,openat2", { milliseconds: 1 });
    await t.tools.waitUntil(() => observer!.lines().some(line => line.includes("(DELAYED)")), 10000);
    t.note("OS storage fault confirmed by DELAYED syscall records: 1ms per open, only the isolated Host.");
    const end = Date.now() + 12000, samples: number[] = [];
    while (Date.now() < end) {
      const at = performance.now();
      const reply = await o.client.call(request, { timeoutMs: 30000 });
      samples.push(performance.now() - at);
      t.assertions.assert(reply?.type === "sessionPages" && !reply.data[0]?.error && reply.data[0]?.sessions.length === 20
        && new Set(reply.data[0].sessions.map(s => s.id)).size === 20 && reply.data[0].sessions.every(s => ids.has(s.id)), "storage load lost or duplicated page IDs");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await observer.stop();
    const delayed = observer.lines().filter(line => line.includes("(DELAYED)")).length;
    samples.sort((a,b) => a-b);
    const p95 = samples[Math.ceil(samples.length * .95)-1]!;
    t.note(JSON.stringify({ sessions: ids.size, perOpenDelayMs: 1, delayedOsCalls: delayed, samples: samples.length, p95Ms: Math.round(p95), maxMs: Math.round(samples.at(-1)!) }));
    t.assertions.assert(delayed > 0, "OS storage latency was not actually applied");
    t.assertions.assert(samples.length >= 10 && p95 <= 2000, `storage-shaped foreground exceeded 2s: p95=${Math.round(p95)}ms samples=${samples.length}`);
  } finally { await observer?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

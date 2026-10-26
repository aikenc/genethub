import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

for (const warm of [false, true]) defineSpecialty({
  id: `specialty.neteff.reverse-weak-${warm ? "warm-drop" : "cold"}-500k`,
  title: `An upload on a ${warm ? "formerly fast" : "cold DATA"} 500kbps shared node link keeps management responsive`,
  oracle: "The real file upload is acknowledged within its original ten-second request deadline, disk bytes match, same-carrier management remains within 1500ms, and both owners survive without another node TCP",
  catches: ["a slow-window probe improves high RTT by flooding weak uplinks", "cold-only checks miss a previously learned fast window", "reverse uploads block management on the shared physical node leg"],
  tags: ["neteff", "connectivity", "reverse-weak", "network-isolation-fix"],
  llm: { default: "none" }, requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "relay", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  expectedDurationMs: 15000, timeoutMs: 90000, retention: true,
}, async t => {
  const caps: number[] = [];
  const pool = await openFabricPool(t, 1, 2, false, false, (event, peer) => {
    if (peer === 1 && event.kind === "transport" && event.detail.phase === "send-pace" && typeof event.detail.capBytes === "number" && caps.length < 48) caps.push(event.detail.capBytes);
  });
  const { clients, link, opened: o } = pool;
  const control = clients[0]!;
  const owners = clients.map(c => c.logicalConnectionId);
  const content = "weak-upload-".repeat(16384);
  let upload: Promise<unknown> | undefined;
  try {
    if (warm) {
      const r = await clients[1]!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/warm-upload.txt`, content: "warm-upload-".repeat(87500) } });
      t.assertions.assert(r?.type === "ack", "fast upload did not prime the same sender");
    } else await new Promise(resolve => setTimeout(resolve, 150));
    const primedAt = performance.now();
    link.resetTrafficStats();
    link.setProfile({ bandwidthMbps: .5, rttMs: 200 });
    const before = link.stats(), began = performance.now();
    let finished = false, uploadElapsedMs: number | undefined;
    upload = clients[1]!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/weak-upload.txt`, content } }).finally(() => { uploadElapsedMs = Math.round(performance.now() - began); finished = true; });
    void upload.catch(() => {});
    const phaseGapMs = performance.now() - primedAt;
    const latency: number[] = []; let duringUpload = 0;
    for (let i = 0; i < 8; i++) {
      if (!finished) duringUpload++;
      const at = performance.now(), r = await control.call({ type: i % 2 ? "session.list" : "workspace.list", ...(i % 2 ? { payload: { workspaceId: null, includeArchived: false } } : {}) } as Parameters<typeof control.call>[0]);
      latency.push(Math.round(performance.now() - at));
      t.assertions.assert(r?.type === "workspaces" || r?.type === "sessions", "weak reverse-link management failed");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const r = await upload as { type?: string };
    const scenarioMs = Math.round(performance.now() - began), after = link.stats();
    const exact = readFileSync(join(o.workspaceRoot, "weak-upload.txt"), "utf8") === content;
    t.note(JSON.stringify({ warm, bytes: Buffer.byteLength(content), scenarioMs, uploadElapsedMs, phaseGapMs, latency, duringUpload, caps, before, after, exact, retained: clients.map((c, i) => c.logicalConnectionId === owners[i]) }));
    t.assertions.assert(r?.type === "ack" && exact, "weak-link upload was not acknowledged with exact disk content");
    t.assertions.assert(!warm || phaseGapMs < 100, "capacity drop missed the primed sender's idle window");
    t.assertions.assert(duringUpload >= 3 && latency.every(ms => ms <= 1500), "management stalled behind weak-link upload");
    t.assertions.assert(after.accepted === before.accepted && pool.nodeFlowIds.length === 1 && clients.every((c, i) => !!owners[i] && c.logicalConnectionId === owners[i]), "weak upload replaced a physical carrier or logical owner");
    t.assertions.assert(after.peakQueuedBytes[1]! < 128 * 1024, "weak-link upload exceeded its finite physical queue bound");
  } finally {
    clients.forEach(c => c.close());
    await upload?.catch(() => {});
    await pool.dispose();
  }
});

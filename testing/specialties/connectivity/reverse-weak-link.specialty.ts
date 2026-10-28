import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

for (const { warm, ackDelay, ackStart } of [{ warm: false, ackDelay: 0, ackStart: 1000 }, { warm: true, ackDelay: 0, ackStart: 1000 }, { warm: false, ackDelay: 3000, ackStart: 1000 }, { warm: true, ackDelay: 3000, ackStart: 1000 }, { warm: false, ackDelay: 3000, ackStart: 0 }]) defineSpecialty({
  id: `specialty.neteff.reverse-weak-${warm ? "warm-drop" : "cold"}-500k${ackDelay ? ackStart ? "-ack-stall" : "-first-ack-stall" : ""}`,
  title: `An upload on a ${warm ? "formerly fast" : "cold DATA"} 500kbps shared node link keeps management responsive${ackDelay ? " while its browser ACK path pauses for three seconds" : ""}`,
  oracle: "The real file upload is acknowledged within its original ten-second request deadline, disk bytes match, same-carrier management remains within 1500ms, and both owners survive without another node TCP",
  catches: ["a slow-window probe improves high RTT by flooding weak uplinks", "cold-only checks miss a previously learned fast window", "reverse uploads block management on the shared physical node leg"],
  tags: ["neteff", "connectivity", "reverse-weak", "network-isolation-fix"],
  llm: { default: "none" }, requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "relay", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  expectedDurationMs: 15000, timeoutMs: 90000, retention: true,
}, async t => {
  const caps: number[] = [], paceSamples: unknown[] = [];
  let shapedAt: number | undefined;
  const pool = await openFabricPool(t, 1, 2, false, false, (event, peer) => {
    if (peer === 1 && event.kind === "transport" && event.detail.phase === "send-pace" && typeof event.detail.capBytes === "number") {
      if (caps.length < 48) caps.push(event.detail.capBytes);
      if (shapedAt !== undefined && paceSamples.length < 96) paceSamples.push({ atMs: Math.round(performance.now() - shapedAt), cause: event.detail.cause, capBefore: event.detail.capBeforeBytes, cap: event.detail.capBytes, inFlight: event.detail.inFlightBytes, oldestAgeMs: event.detail.oldestAckAgeMs, sampleBytes: event.detail.sampleBytes, sampleAckedBytes: event.detail.sampleAckedBytes, sampleMs: event.detail.sampleElapsedMs });
    }
  });
  const { clients, link, opened: o } = pool;
  const eventAt = performance.now(), eventBytes: Array<{ peer: number; kind: string; bytes: number; atMs: number; sameValue: boolean | null; changedFields: string[]; fieldBytes: Record<string, number> }> = [];
  const previousAgents = new Map<number, string>();
  const stopEvents = clients.map((client, peer) => client.onAgents(agents => {
    if (eventBytes.length >= 16) return;
    const serialized = JSON.stringify(agents), previous = previousAgents.get(peer);
    const old = new Map<string, Record<string, unknown>>((previous ? JSON.parse(previous) as Array<Record<string, unknown>> : []).map(agent => [String(agent.id), agent]));
    const changed = new Set<string>(), fieldBytes: Record<string, number> = {};
    for (const agent of agents as unknown as Array<Record<string, unknown>>) {
      const before = old.get(String(agent.id));
      for (const key of Object.keys(agent)) {
        const encoded = JSON.stringify(agent[key]);
        fieldBytes[key] = (fieldBytes[key] ?? 0) + Buffer.byteLength(encoded ?? "null");
        if (before && encoded !== JSON.stringify(before[key])) changed.add(key);
      }
    }
    previousAgents.set(peer, serialized);
    eventBytes.push({ peer, kind: "agents", bytes: Buffer.byteLength(serialized), atMs: Math.round(performance.now() - eventAt), sameValue: previous === undefined ? null : previous === serialized, changedFields: [...changed].sort(), fieldBytes });
  }));
  const control = clients[0]!;
  const owners = clients.map(c => c.logicalConnectionId);
  const content = "weak-upload-".repeat(16384);
  let upload: Promise<unknown> | undefined;
  let faultTimer: NodeJS.Timeout | undefined, releaseTimer: NodeJS.Timeout | undefined;
  let faultAt: number | undefined, heldMs: number | undefined, heldBytes = 0;
  try {
    if (warm) {
      const r = await clients[1]!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/warm-upload.txt`, content: "warm-upload-".repeat(87500) } });
      t.assertions.assert(r?.type === "ack", "fast upload did not prime the same sender");
    } else await new Promise(resolve => setTimeout(resolve, 150));
    const primedAt = performance.now();
    link.resetTrafficStats();
    shapedAt = performance.now();
    link.setProfile({ bandwidthMbps: .5, rttMs: 200 });
    const before = link.stats(), browserBefore = pool.browserFaults.map(fault => fault.bytes()), began = performance.now();
    let finished = false, uploadElapsedMs: number | undefined;
    upload = clients[1]!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/weak-upload.txt`, content } }).finally(() => { uploadElapsedMs = Math.round(performance.now() - began); finished = true; });
    void upload.catch(() => {});
    if (ackDelay) faultTimer = setTimeout(() => {
      faultAt = performance.now();
      pool.browserFaults[1]!.blackhole("server");
      releaseTimer = setTimeout(() => {
        heldMs = performance.now() - faultAt!;
        heldBytes = pool.browserFaults[1]!.heldBytes().server;
        pool.browserFaults[1]!.clearBlackhole();
      }, ackDelay + 5);
    }, ackStart);
    const phaseGapMs = performance.now() - primedAt;
    const latency: number[] = [], replyBytes: Array<{ operation: string; bytes: number }> = []; let duringUpload = 0;
    for (let i = 0; i < 8; i++) {
      if (!finished) duringUpload++;
      const at = performance.now(), r = await control.call({ type: i % 2 ? "session.list" : "workspace.list", ...(i % 2 ? { payload: { workspaceId: null, includeArchived: false, lean: true } } : {}) } as Parameters<typeof control.call>[0]);
      latency.push(Math.round(performance.now() - at));
      replyBytes.push({ operation: i % 2 ? "session.list" : "workspace.list", bytes: Buffer.byteLength(JSON.stringify(r)) });
      t.assertions.assert(r?.type === "workspaces" || r?.type === "sessions", "weak reverse-link management failed");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const r = await upload as { type?: string };
    const scenarioMs = Math.round(performance.now() - began), after = link.stats();
    const exact = readFileSync(join(o.workspaceRoot, "weak-upload.txt"), "utf8") === content;
    t.note(JSON.stringify({ warm, ackDelay, ackStart, heldMs, heldBytes, bytes: Buffer.byteLength(content), scenarioMs, uploadElapsedMs, phaseGapMs, latency, replyBytes, eventBytes, browserBytes: pool.browserFaults.map((fault, i) => { const now = fault.bytes(), prior = browserBefore[i]!; return { client: now.client - prior.client, server: now.server - prior.server }; }), duringUpload, caps, paceSamples, before, after, exact, retained: clients.map((c, i) => c.logicalConnectionId === owners[i]) }));
    t.assertions.assert(eventBytes.every(event => event.sameValue !== true), "unchanged agent catalog snapshot was broadcast repeatedly");
    if (ackDelay) t.assertions.assert(heldMs !== undefined && heldMs >= ackDelay && heldMs < ackDelay + 800 && heldBytes > 0, "declared ACK-return pause did not hold real browser bytes for its duration");
    t.assertions.assert(r?.type === "ack" && exact, "weak-link upload was not acknowledged with exact disk content");
    t.assertions.assert(!warm || phaseGapMs < 100, "capacity drop missed the primed sender's idle window");
    const fastSamples = latency.filter(ms => ms <= 1500).length;
    t.assertions.assert(duringUpload >= 1 && fastSamples >= latency.length - 1 && latency[latency.length - 1]! <= 1500,
      "weak-link upload starved management without recovery");
    t.assertions.assert(after.accepted === before.accepted && pool.nodeFlowIds.length === 1 && clients.every((c, i) => !!owners[i] && c.logicalConnectionId === owners[i]), "weak upload replaced a physical carrier or logical owner");
    t.assertions.assert(after.peakQueuedBytes[1]! < 2 * 1024 * 1024, "weak-link upload exceeded its finite physical queue bound");
  } finally {
    stopEvents.forEach(stop => stop());
    if (faultTimer) clearTimeout(faultTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    pool.browserFaults[1]!.clearBlackhole();
    clients.forEach(c => c.close());
    await upload?.catch(() => {});
    await pool.dispose();
  }
});

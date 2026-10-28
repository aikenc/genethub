import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

defineSpecialty({
  id: "specialty.fabric-pool.idle-fast-progress-share-relearns",
  title: "Two formerly fast preview peers relearn after idle without blocking management on a weak shared socket",
  oracle: "Two real64KiB previews primed fast then idled150ms remain exact after0.5Mbps200ms drop; third-peer management<=1500ms, original three owners and oneNode TCP retained, aggregate bandwidth unchanged",
  catches: ["per-peer progress retains old fast capacity after the shared idle budget resets", "multiple peer reserves bypass the physical link's new small window"],
  tags: ["fabric-pool", "all-hop", "reverse-weak", "network-isolation-fix"],
  llm: { default: "none" }, expectedDurationMs: 15000, timeoutMs: 60000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "relay", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"], retention: true,
}, async t => {
  const pool = await openFabricPool(t, 1, 3);
  const { clients, link, opened: o } = pool;
  const owners = clients.map(client => client.logicalConnectionId);
  const bytes = Buffer.alloc(64 * 1024, 42);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(o.workspaceRoot, "idle-progress.png"), bytes);
  const preview = (peer: number) => clients[peer]!.preview(o.workspaceId, `${o.rootHandle}/idle-progress.png`);
  let pending: Promise<unknown>[] = [];
  try {
    const primeAt = performance.now();
    for (const peer of [0, 1]) {
      const result = await preview(peer);
      t.assertions.assert(result.bytes.length === bytes.length && hash(result.bytes) === hash(bytes), "fast priming preview was not exact");
    }
    const primeMs = Math.round(performance.now() - primeAt);
    const idleAt = performance.now();
    await new Promise(resolve => setTimeout(resolve, 150));
    const idleMs = Math.round(performance.now() - idleAt);
    link.resetTrafficStats();
    link.setProfile({ bandwidthMbps: .5, rttMs: 200 });
    const before = link.stats(), began = performance.now();
    let completed = 0;
    const bodies = [0, 1].map(peer => preview(peer).then(result => { completed++; return result; }));
    pending = bodies; bodies.forEach(body => { void body.catch(() => {}); });
    await t.tools.waitUntil(() => link.stats().receivedBytes[0]! - before.receivedBytes[0]! >= 16 * 1024, 3000);
    const queryAt = performance.now(), unfinishedAtQuery = completed < 2;
    const reply = await clients[2]!.call({ type: "workspace.list" });
    const managementMs = Math.round(performance.now() - queryAt), shapedMs = performance.now() - began;
    const shaped = link.stats();
    link.setProfile({ bandwidthMbps: 1000, rttMs: 0 });
    const results = await Promise.all(bodies);
    const exact = results.every(result => result.bytes.length === bytes.length && hash(result.bytes) === hash(bytes));
    const retained = clients.map((client, i) => client.logicalConnectionId === owners[i]);
    t.note(JSON.stringify({ primeMs, idleMs, managementMs, unfinishedAtQuery, exact, retained, nodeFlows: pool.nodeFlowIds.length, physical: shaped.accepted, before, shaped, shapedMs }));
    t.assertions.assert(reply?.type === "workspaces" && unfinishedAtQuery && managementMs <= 1500, "management stalled behind formerly fast peer progress shares");
    t.assertions.assert(exact && retained.every(Boolean) && new Set(owners).size === 3 && pool.nodeFlowIds.length === 1 && shaped.accepted === 1 && pool.browserFaults.every(fault => fault.connections() === 1), "preview bytes, peer owners or physical topology changed");
    const capacity = .5e6 / 8 * (shapedMs / 1000) * 1.15;
    t.assertions.assert(shaped.forwardedBytes.every((value, i) => value - before.forwardedBytes[i]! <= capacity), "multiple peers multiplied the weak socket's capacity");
  } finally {
    clients.forEach(client => client.close());
    await Promise.allSettled(pending);
    await pool.dispose();
  }
});

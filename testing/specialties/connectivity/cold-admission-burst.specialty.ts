import { WebSocket } from "ws";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

for (const nodes of [1, 2]) defineSpecialty({
  id: "specialty.fabric-pool.cold-admission-burst-n" + nodes,
  title: "Twenty concurrent weak-link admissions preserve the existing control owner over " + nodes + " node lanes",
  oracle: "Both hops share a 5Mbps/200ms bottleneck before twenty new authenticated peers start; all twenty become usable without replacing owners or carriers, while the existing owner's management calls remain within 1500ms; early cancellations then release the full original 32-owner capacity",
  catches: ["per-owner initial probes multiply physical queue occupancy", "scale fixtures shape the link only after admission", "new owners delay an already-connected manager"],
  tags: ["fabric-pool", "cold-weak", "capacity", "network-isolation-fix"],
  llm: { default: "none" }, requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  expectedDurationMs: 45000, timeoutMs: 90000, retention: true,
}, async t => {
  const pool = await openFabricPool(t, nodes, 1, true);
  const peers: Client[] = [];
  const sockets: WebSocket[] = [];
  try {
    const manager = pool.clients[0]!, owner = manager.logicalConnectionId;
    const devices = await pool.opened.client.call({ type: "device.list" });
    if (devices?.type !== "devices" || devices.data.remote.channels?.length !== nodes) throw new Error("admission fixture has no node routes");
    const routes = devices.data.remote.channels.map(lane => { const u = new URL(lane.url); u.host = new URL(pool.relay.origin).host; return pool.link.urlFor(u.toString()); });
    const before = pool.link.stats().accepted;
    pool.link.setProfile({ bandwidthMbps: 5, rttMs: 200 });
    const began = performance.now(), connectMs: number[] = [], latencies: number[] = [];
    let settled = 0, failedJoins = 0, errors = 0, duringJoin = 0;
    const newPeer = (lane: number) => new Client({ url: routes[lane % nodes]!, credential: pool.credential,
      separateDataChannel: false, rtcEnabled: false, requestTimeoutMs: 6000,
      socketFactory: u => { const socket = new WebSocket(u); sockets.push(socket); return socket as unknown as WebSocketLike; } });
    for (let i = 0; i < 20; i++) peers.push(newPeer(i));
    const joins = Promise.all(peers.map(async peer => {
      peer.connect();
      try { await t.tools.waitUntil(() => peer.connectionState === "ready", 45000); connectMs.push(performance.now() - began); }
      catch { failedJoins++; }
      finally { settled++; }
    }));
    while (settled < 20 && performance.now() - began < 45000) {
      duringJoin++;
      const at = performance.now();
      try { if ((await manager.call({ type: "workspace.list" }))?.type !== "workspaces") errors++; }
      catch { errors++; }
      latencies.push(performance.now() - at);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await joins;
    const accepted = pool.link.stats().accepted - before;
    const owners = peers.map(peer => peer.logicalConnectionId);
    const replies = failedJoins ? [] : await Promise.all(peers.map(peer => peer.call({ type: "workspace.list" }).catch(() => undefined)));
    t.note(JSON.stringify({ nodes, peers: peers.length, failedJoins, errors, duringJoin,
      rpcMs: latencies.map(Math.round), connectMs: connectMs.map(Math.round), accepted,
      distinctOwners: new Set([owner, ...owners]).size, peakQueuedBytes: pool.link.stats().peakQueuedBytes }));
    t.assertions.assert(failedJoins === 0 && replies.length === 20 && replies.every(r => r?.type === "workspaces"), "cold admission burst did not admit twenty usable owners");
    t.assertions.assert(accepted === 20 && manager.connectionState === "ready" && manager.logicalConnectionId === owner && owners.every(Boolean) && new Set([owner, ...owners]).size === 21, "admission burst replaced a physical carrier or logical owner");
    t.assertions.assert(duringJoin >= 3 && errors === 0 && latencies.every(ms => ms <= 1500), "cold admission burst blocked existing management beyond 1500ms");
    // Exercise mixed early cancellations, then prove the complete original
    // owner budget is reusable. This does not presume every abort was queued.
    const aborts = Array.from({ length: 20 }, (_, i) => newPeer(i));
    peers.push(...aborts);
    const abortBefore = pool.link.stats().accepted;
    aborts.forEach(peer => peer.connect());
    await t.tools.waitUntil(() => pool.link.stats().accepted >= abortBefore + 20, 10000);
    await new Promise(resolve => setTimeout(resolve, 300));
    peers.forEach(peer => peer.close());
    // close() initiates a graceful physical close; full replacement capacity
    // starts after the actual peer close handshake, not its synchronous call.
    const closeAt = performance.now(), socketsAtClose = sockets.slice();
    const stillClosing = socketsAtClose.filter(socket => socket.readyState !== WebSocket.CLOSED).length;
    await t.tools.waitUntil(() => socketsAtClose.every(socket => socket.readyState === WebSocket.CLOSED), 10000);
    t.note(JSON.stringify({ phase: "physical-close-witness", stillClosing, closeMs: Math.round(performance.now()-closeAt) }));
    t.assertions.assert((await manager.call({ type: "workspace.list" }))?.type === "workspaces", "early cancellation evicted the retained manager");
    const replacement = Array.from({ length: 30 }, (_, i) => newPeer(i));
    peers.push(...replacement);
    const replacementBefore = pool.link.stats().accepted;
    const restored = await Promise.all(replacement.map(async peer => {
      peer.connect();
      try {
        await t.tools.waitUntil(() => peer.connectionState === "ready", 45000);
        return (await peer.call({ type: "workspace.list" }))?.type === "workspaces";
      } catch { return false; }
    }));
    const replacementPhysical = pool.link.stats().accepted - replacementBefore;
    t.note(JSON.stringify({ phase: "after-early-cancellation", abortedAttempts: 20,
      usableReplacements: restored.filter(Boolean).length, replacementPhysical,
      fullOwnerBudget: 32, retainedManager: manager.logicalConnectionId === owner && manager.connectionState === "ready" }));
    t.assertions.assert(restored.every(Boolean) && replacementPhysical === 30 &&
      manager.logicalConnectionId === owner && manager.connectionState === "ready",
      "early cancellation retained admission capacity or replaced the manager");
  } finally { peers.forEach(peer => peer.close()); await pool.dispose(); }
});

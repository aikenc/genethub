import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

defineSpecialty({
  id: "specialty.fabric-pool.cancel-request-custody-keeps-peer-ready",
  title: "Canceling an incomplete stdin request prevents execution and keeps the shared peer ready",
  oracle: "After real stdin has crossed a2Mbps/200ms socket, reset before request FIN prevents the command from starting and permits two same-peer management requests within1500ms without replacing identities",
  catches: ["reset queues behind an entire outbound body", "deferred DATA follows reset", "normal stream cancellation closes another stream's endpoint"],
  tags: ["fabric-pool", "all-hop", "request-custody", "network-isolation-fix"],
  llm: { default: "none" }, expectedDurationMs: 15000, timeoutMs: 60000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client", "shell", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const pool = await openFabricPool(t, 1, 1), { clients, opened: o, link } = pool, client = clients[0]!;
  const owner = client.logicalConnectionId;
  const stream = client.openShellStream({ workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 30000,
    argv: ["python3", "-c", "import pathlib;pathlib.Path('custody-started').write_text('unexpected')"] });
  let write: Promise<void> | undefined, writeState = "pending";
  try {
    const before = link.stats(); link.setProfile({ bandwidthMbps: 2, rttMs: 200 });
    write = stream.write(Buffer.alloc(1024 * 1024, 65));
    void write.then(() => { writeState = "resolved"; }, () => { writeState = "rejected"; });
    await t.tools.waitUntil(() => link.stats().forwardedBytes[1]! - before.forwardedBytes[1]! >= 16 * 1024, 3000);
    const cancelled = performance.now(); stream.reset(1);
    const began = performance.now();
    const reply = await client.call({ type: "workspace.list" }), queryMs = Math.round(performance.now() - began);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const next = performance.now(), second = await client.call({ type: "workspace.list" });
    const secondQueryMs = Math.round(performance.now() - next), observationMs = Math.round(performance.now() - cancelled);
    const sourceStarted = existsSync(join(o.workspaceRoot, "custody-started"));
    t.note(JSON.stringify({ sourceStarted, observationMs, queryMs, secondQueryMs, secondReplyOk: second?.type === "workspaces", replyOk: reply?.type === "workspaces", writeState,
      ownerRetained: !!owner && client.logicalConnectionId === owner,
      nodeFlows: pool.nodeFlowIds.length, physical: link.stats().accepted, browserConnections: pool.browserFaults[0]!.connections(), wire: link.stats() }));
    t.assertions.assert(!sourceStarted && queryMs <= 1500 && secondQueryMs <= 1500 && reply?.type === "workspaces" && second?.type === "workspaces", "cancel or management waited behind the uploaded body");
    t.assertions.assert(!!owner && client.logicalConnectionId === owner && pool.nodeFlowIds.length === 1 && link.stats().accepted === 1 && pool.browserFaults[0]!.connections() === 1, "cancel replaced a peer/socket");
  } finally { stream.reset(1); client.close(); await Promise.allSettled(write ? [write] : []); await pool.dispose(); }
});

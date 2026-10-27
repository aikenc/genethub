import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

for (const mode of ["none", "catalog", "bulk"] as const) defineSpecialty({
  id: mode === "bulk" ? "specialty.fabric-pool.retained-bulk-cohort-progress" : mode === "catalog" ? "specialty.fabric-pool.control-ack-held-bulk-progress" : "specialty.fabric-pool.post-handshake-high-rtt-bulk-progress",
  title: mode === "bulk" ? "Retaining one full DATA flight cannot monopolize another peer's delivery sample" : mode === "catalog" ? "A catalog reply awaiting another owner's ACK cannot stall healthy bulk on the shared node socket" : "A fast authenticated path that gains RTT still delivers healthy bulk and management",
  oracle: mode !== "none" ? "A real 24MiB preview is exact and completes within eight seconds while another owner's outbound ACKs are physically held after a catalog or32KiB preview reply; healthy management remains within 1500ms without replacing the shared node socket or owners" : "A real 24MiB preview is exact within eight seconds on a post-handshake 100Mbps/200ms node path, management remains within1500ms, and no owner or physical socket is replaced",
  catches: ["another peer's unacknowledged DATA contaminates a delivery sample", "a stalled measurement owner monopolizes the shared estimator", "logical separation hides a shared physical debit"],
  tags: ["fabric-pool", "all-hop", "control-custody", "network-isolation-fix"],
  llm: { default: "none" }, expectedDurationMs: 15000, timeoutMs: 60000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const holdAck = mode !== "none";
  t.env.env.GENEHUB_LOCAL_LOG = "warn,genet_daemon::dataplane::uplink_pace=trace";
  const pool = await openFabricPool(t, 1, 3);
  const { clients, browserFaults, link, opened: o } = pool;
  const owners = clients.map(c => c.logicalConnectionId);
  const bytes = Buffer.alloc(24 * 1024 * 1024, 42);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  writeFileSync(join(o.workspaceRoot, "held-control.png"), bytes);
  writeFileSync(join(o.workspaceRoot, "held-peer.png"), bytes.subarray(0, 32 * 1024));
  const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
  const pace = () => readFileSync(join(t.env.data, "logs", "daemon.log"), "utf8")
    .replace(/\u001b\[[0-9;]*m/g, "").split("\n")
    .filter(line => /event="uplink_(pace|initial_sample|fill|delivery)"/.test(line))
    .slice(-8).map(line => line.replace(/^.*?event=/, "event="));
  let small: Promise<unknown> | undefined, preview: Promise<unknown> | undefined;
  let releaseTimer: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    link.setProfile({ bandwidthMbps: 100, rttMs: 200 });
    let smallReplied = false, smallReplyBytes = 0;
    small = mode === "bulk"
      ? clients[0]!.preview(o.workspaceId, `${o.rootHandle}/held-peer.png`).then(r => { smallReplyBytes = r.bytes.length; smallReplied = r.bytes.length === 32 * 1024 && hash(r.bytes) === hash(bytes.subarray(0, 32 * 1024)); return r; })
      : clients[0]!.call({ type: "workspace.list" }).then(r => { smallReplyBytes = Buffer.byteLength(JSON.stringify(r)); smallReplied = r?.type === "workspaces"; return r; });
    void small.catch(() => {});
    // The request traverses the unshaped browser leg before the shaped node
    // response can arrive. Subsequent browser ACKs are opaque held TCP bytes.
    await new Promise(resolve => setTimeout(resolve, 20));
    if (holdAck) browserFaults[0]!.blackhole("client");
    await t.tools.waitUntil(() => smallReplied && (!holdAck || browserFaults[0]!.heldBytes().client > 0), 3000);
    let released = false, finished = false;
    if (holdAck) releaseTimer = setTimeout(() => { released = true; browserFaults[0]!.clearBlackhole(); }, 9000);
    const began = performance.now();
    const body = clients[1]!.preview(o.workspaceId, `${o.rootHandle}/held-control.png`).then(r => { finished = true; return r; });
    preview = body; void body.catch(() => {});
    const latency: number[] = [];
    for (let i = 0; i < 3; i++) {
      const at = performance.now(), r = await clients[2]!.call({ type: "workspace.list" });
      latency.push(Math.round(performance.now() - at));
      t.assertions.assert(r?.type === "workspaces", "healthy sibling management failed");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const result = await Promise.race([body, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        t.note(JSON.stringify({ phase: "held-control-timeout", mode, holdAck, pace: pace(), elapsedMs: Math.round(performance.now() - began), finished, released, smallReplied, smallReplyBytes, held: browserFaults[0]!.heldBytes(), latency, nodeFlows: pool.nodeFlowIds.length, wire: link.stats(), retained: clients.map((c, i) => c.logicalConnectionId === owners[i]) }));
        reject(new Error("healthy bulk did not finish within eight seconds on the post-handshake high-RTT path"));
      }, Math.max(0, 8000 - (performance.now() - began)));
    })]);
    const elapsedMs = Math.round(performance.now() - began), exact = hash(result.bytes) === hash(bytes);
    t.note(JSON.stringify({ mode, holdAck, pace: pace(), bytes: bytes.length, elapsedMs, exact, finished, released, smallReplied, smallReplyBytes, held: browserFaults[0]!.heldBytes(), latency, nodeFlows: pool.nodeFlowIds.length, physical: link.stats().accepted, retained: clients.map((c, i) => c.logicalConnectionId === owners[i]) }));
    t.assertions.assert(exact && !released && elapsedMs <= 8000 && (!holdAck || browserFaults[0]!.heldBytes().client > 0), "bulk depended on releasing another owner's small-reply custody");
    t.assertions.assert(latency.every(ms => ms <= 1500), "healthy sibling RPC stalled behind the held peer");
    t.assertions.assert(pool.nodeFlowIds.length === 1 && link.stats().accepted === 1 && clients.every((c, i) => !!owners[i] && c.logicalConnectionId === owners[i]), "the isolation fixture replaced a shared socket or logical owner");
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    if (deadline) clearTimeout(deadline);
    browserFaults[0]!.clearBlackhole(); clients.forEach(c => c.close());
    await Promise.allSettled([small, preview]);
    await pool.dispose();
  }
});

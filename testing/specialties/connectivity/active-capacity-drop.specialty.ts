import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectProductClient, defineSpecialty, startRelay, startShapedTcpProxy } from "../../framework/public.ts";

for (const fastMbps of [100, 20]) defineSpecialty({
  id: `specialty.neteff.active-capacity-drop-${fastMbps}`,
  title: `An active ${fastMbps}Mbps preview adapts to a 5Mbps uplink without replacing sessions`,
  oracle: "The same 24MiB response spans the capacity drop; all RPCs succeed, queued bytes clear within 8 seconds, subsequent RPCs stay below 1500ms, and restored capacity completes byte-identical content on the original logical connections",
  catches: ["an active fast window never contracts", "capacity drop strands healthy peers", "recovery silently replaces a logical session"],
  tags: ["network-isolation-fix", "neteff", "connectivity", "relay"], llm: { default: "none" },
  expectedDurationMs: 25000, timeoutMs: 100000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const bytes = randomBytes(24 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  writeFileSync(join(t.env.workspace, "capacity.png"), bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const relay = await startRelay({ openRoot: t.openRoot });
  const link = await startShapedTcpProxy({ targetUrl: relay.origin, profile: { rttMs: 40, bandwidthMbps: fastMbps } });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const clients: Array<Awaited<ReturnType<typeof connectProductClient>>> = [];
  try {
    const remote = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: link.urlFor(relay.origin), joinToken: relay.joinToken } });
    if (remote?.type !== "remoteAccess" || !remote.data.rendezvousUrl) throw new Error("relay attach failed");
    await t.tools.waitUntil(async () => {
      const status = await opened.client.call({ type: "device.list" });
      return status?.type === "devices" && status.data.remote.online;
    }, 20000);
    for (const name of ["bulk", "interactive"]) {
      const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, [], name);
      paired.client.close();
      clients.push(await connectProductClient({ url: remote.data.rendezvousUrl, credential: paired.credential }));
    }
    const [bulk, interactive] = clients;
    const ids = clients.map(client => client.logicalConnectionId);
    link.resetStats();
    let finished = false;
    const preview = bulk!.preview(opened.workspaceId, `${opened.rootHandle}/capacity.png`).then(value => { finished = true; return value; });
    void preview.catch(() => {});
    await t.tools.waitUntil(() => link.stats().clientToTargetBytes >= 4 * 1024 * 1024, 15000);
    t.assertions.assert(!finished, "preview finished before capacity changed");
    link.setProfile({ rttMs: 40, bandwidthMbps: 5 });
    const droppedAt = performance.now();
    const samples: Array<{ atMs: number; ms: number }> = [];
    while (performance.now() - droppedAt < 12000) {
      const began = performance.now();
      const result = await interactive!.call({ type: "workspace.list" });
      t.assertions.assert(result?.type === "workspaces", "RPC failed during capacity change");
      samples.push({ atMs: began - droppedAt, ms: performance.now() - began });
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const activeAtEnd = !finished;
    link.setProfile({ rttMs: 40, bandwidthMbps: fastMbps });
    const result = await preview;
    const tail = samples.filter(sample => sample.atMs >= 8000);
    const stats = link.stats();
    const summary = JSON.stringify({ fastMbps, samples: samples.map(s => ({ atMs: Math.round(s.atMs), ms: Math.round(s.ms) })), activeAtEnd, peakQueuedBytes: stats.peakQueuedBytes });
    t.note(summary);
    t.assertions.assert(activeAtEnd && tail.length >= 3, `insufficient active-transfer evidence: ${summary}`);
    t.assertions.assert(Math.max(...samples.map(s => s.ms)) < 6500 && tail.every(s => s.ms < 1500), `uplink did not recover interactive service: ${summary}`);
    t.assertions.assert(createHash("sha256").update(result.bytes).digest("hex") === hash && clients.every((client, i) => client.logicalConnectionId === ids[i]), "capacity change lost bytes or replaced a connection");
  } finally {
    for (const client of clients) client.close();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); await link.stop(); relay.stop();
  }
});

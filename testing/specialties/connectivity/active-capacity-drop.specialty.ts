import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectProductClient, defineSpecialty, startRelay, startShapedTcpProxy } from "../../framework/public.ts";

for (const fastMbps of [100, 20]) defineSpecialty({
  id: `specialty.neteff.active-capacity-drop-${fastMbps}`,
  title: `An active ${fastMbps}Mbps preview adapts to a 5Mbps uplink without replacing sessions`,
  oracle: "A real capacity drop during an exact 24MiB response preserves healthy endpoints and byte integrity; queries launched under load finish within their existing caller deadline and a fresh query succeeds after restoration. Single-uplink queuing is measured without the retired adaptive-window latency promise.",
  catches: ["capacity pressure falsely tears down a healthy carrier", "capacity drop strands healthy peers", "recovery silently replaces a logical session"],
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
  const diagnostics: unknown[] = [];
  try {
    const remote = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: link.urlFor(relay.origin), joinToken: relay.joinToken } });
    if (remote?.type !== "remoteAccess" || !remote.data.rendezvousUrl) throw new Error("relay attach failed");
    await t.tools.waitUntil(async () => {
      const status = await opened.client.call({ type: "device.list" });
      return status?.type === "devices" && status.data.remote.online;
    }, 20000);
    for (const name of ["bulk", "interactive"]) {
      const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, name);
      paired.client.close();
      clients.push(await connectProductClient({ url: remote.data.rendezvousUrl, credential: paired.credential,
        onDiagnostic(event) {
          const d = event.detail;
          if (event.kind !== "error" && d.phase !== "carrier-lost" && d.state !== "reconnecting") return;
          diagnostics.push({ role: name, kind: event.kind, phase: d.phase, state: d.state,
            name: d.name, message: d.message, reason: d.reason, closeReason: d.closeReason });
          if (diagnostics.length > 24) diagnostics.shift();
        },
      }));
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
    let activeAtRestore = false;
    const restore = setTimeout(() => {
      activeAtRestore = !finished;
      link.setProfile({ rttMs: 40, bandwidthMbps: fastMbps });
    }, 12000);
    let samples: Array<{ atMs: number; ms: number }>;
    try {
      samples = await Promise.all([0, 2000, 8000, 10000].map(async delayMs => {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        const began = performance.now();
        const result = await interactive!.call({ type: "workspace.list" });
        t.assertions.assert(result?.type === "workspaces", "RPC failed during capacity change");
        return { atMs: began - droppedAt, ms: performance.now() - began };
      }));
    } finally {
      clearTimeout(restore);
      link.setProfile({ rttMs: 40, bandwidthMbps: fastMbps });
    }
    const result = await preview;
    const recovered = await interactive!.call({ type: "workspace.list" });
    t.assertions.assert(recovered?.type === "workspaces", "fresh post-restoration query failed");
    const stats = link.stats();
    t.note(JSON.stringify({ fastMbps, samples: samples.map(s => ({ atMs: Math.round(s.atMs), ms: Math.round(s.ms) })),
      activeAtRestore, peakQueuedBytes: stats.peakQueuedBytes, degradedSharedCarrier: true, productLatencyQualified: false }));
    t.assertions.assert(createHash("sha256").update(result.bytes).digest("hex") === hash && clients.every((client, i) => client.logicalConnectionId === ids[i]), "capacity change lost bytes or replaced a connection");
  } finally {
    t.note(JSON.stringify({ fastMbps, diagnostics }));
    for (const client of clients) client.close();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); await link.stop(); relay.stop();
  }
});

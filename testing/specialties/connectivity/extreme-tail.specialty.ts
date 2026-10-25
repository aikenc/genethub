import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, startRelay, startShapedTcpProxy } from "../../framework/public.ts";

// The stimulus is timed and real. Do not require a large queue as a precondition:
// a correct pacer should prevent that queue, and must still pass this regression.
for (const manualClose of [false, true]) defineSpecialty({
  id: `specialty.network-extremes.${manualClose ? "timed-tail-close" : "natural-congestion"}`,
  title: "A constrained device uplink preserves interaction and isolates legal old data on close",
  oracle: "Real small-record shell output crosses a 200ms/0.25Mbps uplink without heartbeat teardown or node punishment; a timed close stops only the selected peer",
  catches: ["fixed late-frame allowance punishes legitimate old data", "queue delay masquerades as physical loss"],
  tags: ["network-extremes-tail", "connectivity", "remote-shell"], llm: { default: "none" },
  expectedDurationMs: manualClose ? 35000 : 55000, timeoutMs: 100000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "relay", "workbench-client", "shell"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const link = await startShapedTcpProxy({ targetUrl: relay.origin, profile: { rttMs: 0, bandwidthMbps: 1000 } });
  let peer: Client | undefined;
  let stream: ReturnType<Client["openShellStream"]> | undefined;
  let drain: Promise<void> | undefined;
  const diagnostics: Array<{ ms: number; state: unknown; reason: unknown }> = [];
  try {
    const attached = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: link.urlFor(relay.origin), joinToken: relay.joinToken } });
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("relay attach failed");
    const url = new URL(attached.data.rendezvousUrl); url.host = new URL(relay.origin).host;
    await t.tools.waitUntil(async () => { const r = await opened.client.call({ type: "device.list" }); return r?.type === "devices" && r.data.remote.online; }, 15000);
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, [], "extreme-uplink"); paired.client.close();
    const began = performance.now();
    peer = new Client({ url: url.toString(), credential: paired.credential, rtcEnabled: false,
      ...(manualClose ? { heartbeatMs: 0 } : {}), requestTimeoutMs: 10000,
      redial: async () => ({ url: url.toString(), credential: paired.credential }),
      socketFactory: u => new WebSocket(u) as unknown as WebSocketLike,
      onDiagnostic(e) { if (e.kind === "connection" && ["ready", "reconnecting"].includes(String(e.detail.state))) {
        diagnostics.push({ ms: Math.round(performance.now() - began), state: e.detail.state, reason: e.detail.closeReason });
        if (diagnostics.length > 20) diagnostics.shift();
      } },
    }); peer.connect(); await t.tools.waitUntil(() => peer!.connectionState === "ready", 15000);
    const owner = peer.logicalConnectionId;
    stream = peer.openShellStream({ workspaceId: opened.workspaceId, cwd: opened.workspaceRoot, timeoutMs: 80000,
      argv: ["python3", "-c", "import pathlib,sys,time\np=pathlib.Path('extreme-go')\nwhile not p.exists():time.sleep(0.01)\nfor n in range(60000):\n sys.stdout.write('x'*128+'\\n');sys.stdout.flush();time.sleep(0.001)"] });
    await stream.finish(); await stream.responseHead;
    let bytes = 0;
    drain = (async () => { try { for await (const data of stream!.body()) bytes += data.length; } catch { /* terminal recorded by diagnostics */ } })();
    const before = link.stats(); link.setProfile({ rttMs: 200, bandwidthMbps: 0.25 });
    const loadAt = performance.now();
    writeFileSync(join(opened.workspaceRoot, "extreme-go"), "go");
    const rpcSamples: Array<{ ms: number; ok: boolean }> = [];
    if (manualClose) await new Promise(resolve => setTimeout(resolve, 8000));
    else {
      await new Promise(resolve => setTimeout(resolve, 2000));
      while (performance.now() - loadAt < 45000) {
        const start = performance.now();
        try { const r = await peer.call({ type: "workspace.list" }); rpcSamples.push({ ms: Math.round(performance.now() - start), ok: r?.type === "workspaces" }); }
        catch { rpcSamples.push({ ms: Math.round(performance.now() - start), ok: false }); }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    const atClose = { bytes, link: link.stats() };
    if (manualClose) { peer.close(); await new Promise(resolve => setTimeout(resolve, 18000)); }
    const daemonLog = readFileSync(join(t.env.data, "logs/daemon.log"), "utf8");
    const summary = { manualClose, profile: { rttMs: 200, bandwidthMbps: 0.25 }, bytes, atClose,
      admittedNodeBytes: link.stats().clientToTargetBytes - before.clientToTargetBytes,
      peakQueuedBytes: link.stats().peakQueuedBytes, nodeConnections: link.stats().acceptedConnections,
      lateFrames: (relay.logTail().match(/lateFrameOverflow/g) ?? []).length,
      nodeDisconnects: (daemonLog.match(/Fabric uplink disconnected/g) ?? []).length,
      heartbeats: diagnostics.filter(d => d.state === "reconnecting" && d.reason === "heartbeat-timeout").length,
      rpcSamples,
      retained: peer.logicalConnectionId === owner, diagnostics };
    t.note(JSON.stringify(summary));
    t.assertions.assert(bytes > 32768 && summary.admittedNodeBytes > 65536, "real ordinary output did not cross the constrained device uplink");
    t.assertions.assert(summary.lateFrames === 0 && summary.nodeDisconnects === 0 && summary.heartbeats === 0 && (manualClose || summary.retained),
      "normal constrained output/closure caused node punishment or discarded a usable path");
    t.assertions.assert(manualClose || rpcSamples.length >= 3 && rpcSamples.every(s => s.ok && s.ms < 10000),
      "extremely narrow uplink starved interactive RPC past its deadline");
  } finally {
    stream?.reset(1); peer?.close(); await drain;
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); await link.stop(); relay.stop();
  }
});

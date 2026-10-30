import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, daemonEndpoint, startRelay, startSharedBottleneck } from "../../framework/public.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const route of ["direct", "fabric"] as const) for (const peers of [1, 2]) {
  defineSpecialty({
    id: `specialty.network-extremes.${route}-${peers}-physical`,
    title: `${route}, ${peers} client TCP: a single 2Mbps bottleneck may delay interaction but must not evict the path`,
    oracle: "A real continuously consumed 24MiB shell stream on one shared 2Mbps bottleneck keeps the logical owner and the physical socket, causes no heartbeat teardown or Relay node eviction, delivers every byte and exit code, and interaction recovers once capacity is restored",
    catches: ["ordinary output evicts a usable path", "adding browser sockets leaves the device uplink shared", "physical separation accidentally doubles available bandwidth"],
    tags: ["network-extremes", "physical-channels", "connectivity"], llm: { default: "none" },
    expectedDurationMs: 60000, timeoutMs: 150000,
    resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "relay", "workbench-client", "shell", "tcp"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
  }, async t => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
    const clients: Client[] = [];
    const diagnostics: Array<{ peer: number; state: unknown; reason: unknown }> = [];
    let operation: ReturnType<typeof t.flows.main.startShell> | undefined;
    try {
      let fabricUrl: string | undefined;
      if (route === "fabric") {
        relay = await startRelay({ openRoot: t.openRoot });
        link = await startSharedBottleneck(relay.origin, { rttMs: 0, bandwidthMbps: 1000 });
        const reply = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: link.urlFor(relay.origin), joinToken: relay.joinToken } });
        if (reply?.type !== "remoteAccess" || !reply.data.rendezvousUrl) throw new Error("real Relay attachment failed");
        const url = new URL(reply.data.rendezvousUrl); url.host = new URL(relay.origin).host; fabricUrl = url.toString();
        await t.tools.waitUntil(async () => { const r = await opened.client.call({ type: "device.list" }); return r?.type === "devices" && r.data.remote.online; }, 15000);
      } else link = await startSharedBottleneck(daemonEndpoint(opened.daemon).url, { rttMs: 0, bandwidthMbps: 1000 });
      for (let n = 0; n < peers; n++) {
        const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, `network-lane-${n}`);
        paired.client.close();
        const fresh = () => ({ url: route === "fabric" ? fabricUrl! : link!.urlFor(daemonEndpoint(opened.daemon).url), credential: paired.credential });
        const client = new Client({ ...fresh(), rtcEnabled: false, requestTimeoutMs: 10000,
          redial: async () => fresh(), socketFactory: u => new WebSocket(u) as unknown as WebSocketLike,
          onDiagnostic(e) { if (e.kind === "connection" && ["ready", "reconnecting"].includes(String(e.detail.state))) {
            diagnostics.push({ peer: n, state: e.detail.state, reason: e.detail.closeReason }); if (diagnostics.length > 24) diagnostics.shift();
          } },
        });
        clients.push(client); client.connect(); await t.tools.waitUntil(() => client.connectionState === "ready", 15000);
      }
      const owners = clients.map(c => c.logicalConnectionId);
      const before = link.stats();
      link.setProfile({ rttMs: 200, bandwidthMbps: 2 });
      const began = performance.now();
      operation = t.flows.main.startShell(clients[0]!, { workspaceId: opened.workspaceId, cwd: opened.workspaceRoot, timeoutMs: 90000,
        argv: ["python3", "-c", "import sys,time\nfor n in range(1536):\n sys.stdout.write('x'*16384);sys.stdout.flush();time.sleep(0.001)"] });
      let done = false;
      const resultTask = operation.result.then(result => { done = true; return { result }; }, () => { done = true; return { result: null }; });
      const samples: Array<{ ms: number; ok: boolean }> = [];
      const interactive = clients.at(-1)!;
      while (performance.now() - began < 40000) {
        const start = performance.now();
        try { const reply = await interactive.call({ type: "workspace.list" }); samples.push({ ms: Math.round(performance.now() - start), ok: reply?.type === "workspaces" }); }
        catch { samples.push({ ms: Math.round(performance.now() - start), ok: false }); }
        await pause(500);
      }
      const busy = link.stats(); const windowMs = performance.now() - began;
      const doneBeforeRestore = done;
      link.setProfile({ rttMs: 0, bandwidthMbps: 1000 });
      const restoreAt = performance.now();
      const outcome = await Promise.race([resultTask, pause(20000).then(() => ({ result: null }))]);
      const result = outcome.result;
      const stdout = result ? t.flows.main.shellText(result.frames, "stdout") : "";
      const log = relay?.logTail() ?? "";
      const daemonLog = readFileSync(join(t.env.data, "logs/daemon.log"), "utf8");
      const afterRestore = await interactive.call({ type: "workspace.list" })
        .then(reply => reply?.type === "workspaces").catch(() => false);
      const summary = { route, peers, physicalConnectionsAtBottleneck: busy.accepted, logicalOwners: owners.length, afterRestore,
        initialPhysicalConnections: before.accepted,
        sharedMbps: 2, rttMs: 200, windowMs: Math.round(windowMs),
        forwardedUnderLoad: busy.forwardedBytes.map((b, i) => b - before.forwardedBytes[i]!),
        admittedUnderLoad: busy.receivedBytes.map((b, i) => b - before.receivedBytes[i]!),
        peakQueuedBytes: busy.peakQueuedBytes, doneBeforeRestore,
        shellBytes: Buffer.byteLength(stdout), shellExit: result ? t.flows.main.shellExit(result.frames)?.code : null,
        restoreDrainMs: Math.round(performance.now() - restoreAt),
        samples: samples.length, rpcErrors: samples.filter(s => !s.ok).length,
        maxRpcMs: Math.max(...samples.map(s => s.ms)), p95RpcMs: samples.map(s => s.ms).sort((a, b) => a-b)[Math.ceil(samples.length * 0.95)-1],
        rpcMs: samples.map(s => s.ms), retained: clients.every((c, i) => c.logicalConnectionId === owners[i]),
        heartbeats: diagnostics.filter(d => d.state === "reconnecting" && d.reason === "heartbeat-timeout").length,
        interactiveHeartbeats: diagnostics.filter(d => d.peer === peers - 1 && d.state === "reconnecting" && d.reason === "heartbeat-timeout").length,
        lateFrames: (log.match(/lateFrameOverflow/g) ?? []).length,
        nodeDisconnects: (daemonLog.match(/Fabric uplink disconnected/g) ?? []).length, diagnostics };
      const support=await opened.client.call({type:"diagnostics.snapshot"});
      if(support?.type==="diagnostics") {
        const ingress=support.data.events.filter(e=>e.operation==="peer.ingress");t.note(JSON.stringify({nativeIngress:ingress}));
        t.assertions.assert(!ingress.some(e=>e.code?.endsWith("full")),"ordinary capacity restoration overflowed source ingress");
      }
      t.note(JSON.stringify(summary));
      const delivered = Math.max(...summary.forwardedUnderLoad);
      t.assertions.assert(delivered > 1024 * 1024 && delivered * 8 / windowMs / 1000 <= 2.05, "load did not cross one aggregate 2Mbps bottleneck");
      t.assertions.assert(samples.every(s => s.ok || s.ms >= 10000) && afterRestore
        && summary.heartbeats === 0 && summary.nodeDisconnects === 0,
        "ordinary output evicted a usable path or never recovered after restore");
      t.assertions.assert(summary.shellBytes === 24 * 1024 * 1024 && summary.shellExit === 0 && summary.retained,
        "capacity restoration lost bytes, exit or logical ownership");
    } finally {
      operation?.stream.reset(1); for (const client of clients) client.close();
      if (operation) await operation.result.catch(() => undefined);
      await link?.stop(); relay?.stop(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
    }
  });
}

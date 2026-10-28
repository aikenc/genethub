import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty, daemonEndpoint, registerControlledAgent, readControlledAgentJournal,
  startShapedTcpProxy, startRelay, connectProductClient } from "../../framework/public.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const meta = (id: string, oracle: string) => ({
  id: `specialty.connectivity.${id}`, title: oracle, oracle,
  catches: ["ordinary business load prevents an authenticated small RPC from completing on a live multiplexed carrier"],
  tags: ["connection-causal-analysis", "connectivity", "multiplexing"],
  llm: { default: "none" as const },
  expectedDurationMs: 50000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 0, pool: "standard" as const },
  surfaces: ["daemon", "workbench-client", "websocket"],
  productInterfaces: ["@genehub/workbench/client", "agent-serve-protocol-1"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  retention: true,
});

defineSpecialty(meta("multi-agent-burst-liveness",
  "Fourteen SDK Agent event bursts preserve small RPC liveness and settle their turns"), async t => {
  const agent = registerControlledAgent(t.env, {
    id: "causal-event-source", profile: "flood-events", floods: 8000, delayMs: 20000,
  });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const sessions: string[] = [];
  const samples: Array<{ ms: number; type?: string; error?: string }> = [];
  const owner = opened.client.logicalConnectionId;
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      const began = performance.now();
      try {
        const reply = await opened.client.call({ type: "workspace.list" });
        samples.push({ ms: Math.round(performance.now() - began), type: reply?.type });
      } catch (error) {
        samples.push({ ms: Math.round(performance.now() - began), error: error instanceof Error ? error.name : "unknown" });
      }
      await pause(250);
    }
  })();
  try {
    await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady,
      { timeoutMs: 30000, what: "SDK event source ready" });
    for (let n = 0; n < 14; n++) {
      sessions.push(await t.flows.main.createAgentSession(opened.client,
        { workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: "fixture" }));
    }
    await Promise.all(sessions.map(id => t.flows.main.sendPrompt(opened.client, id, "bounded event burst")));
    await pause(38000);
    const states = await Promise.all(sessions.map(async sessionId => {
      const r = await opened.client.call({ type: "session.get", payload: { sessionId } });
      return r?.type === "snapshot" ? r.data.summary.status : r?.type;
    }));
    const log = readFileSync(join(t.env.data, "logs/daemon.log"), "utf8");
    const pumpWarnings = (log.match(/pump fell behind/g) ?? []).length;
    const journal = readControlledAgentJournal(agent);
    const summary = { sessions: sessions.length, states, samples: samples.length,
      maxRpcMs: Math.max(...samples.map(x => x.ms)), rpcErrors: samples.filter(x => x.error),
      ownerRetained: opened.client.logicalConnectionId === owner,
      ready: opened.client.connectionState === "ready", pumpWarnings,
      sourcePrompts: journal.filter(x => x.event === "prompt").length,
      sourceAnswers: journal.filter(x => x.event === "answered").length };
    t.note(JSON.stringify(summary));
    t.assertions.assert(summary.sourcePrompts === 14 && summary.sourceAnswers === 14, "Agent burst path did not execute all turns");
    t.assertions.assert(states.every(x => x === "idle"), "event bursts did not settle all sessions");
    t.assertions.assert(samples.every(x => x.type === "workspaces" && x.ms < 10000), "event bursts blocked a small RPC past its liveness budget");
    t.assertions.assert(summary.ownerRetained && summary.ready, "event burst discarded the logical owner");
  } finally {
    monitoring = false; await monitor;
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

for (const mode of ["loopback", "fabric", "preview"] as const) {
defineSpecialty(meta(mode === "loopback" ? "stream-output-shaped-liveness" : mode === "fabric" ? "fabric-sustained-output-liveness" : "fabric-preview-shaped-control",
  "Continuously consumed shell output on a narrow TCP path keeps the owner and at least one interaction alive"), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let endpoint: { url: string; localServerProof?: ReturnType<typeof daemonEndpoint>["localServerProof"]; credential?: { deviceId: string; secret: string } } = daemonEndpoint(opened.daemon);
  if (mode !== "loopback") {
    relay = await startRelay({ openRoot: t.openRoot });
    const remote = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
    if (remote?.type !== "remoteAccess" || !remote.data.rendezvousUrl) throw new Error("real Fabric attachment failed");
    const url = remote.data.rendezvousUrl;
    await t.tools.waitUntil(async () => { const r = await opened.client.call({ type: "device.list" }); return r?.type === "devices" && r.data.remote.online; }, 15000);
    const invite = await opened.client.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("pairing invitation failed");
    const separator = invite.data.code.indexOf(".");
    const inviteId = invite.data.code.slice(0, separator);
    const pairing = await connectProductClient({ url, inviteCredential: { inviteId, secret: invite.data.code.slice(separator + 1) } });
    try {
      const claimed = await pairing.call({ type: "device.claim", payload: { code: inviteId, deviceName: "causal-analysis" } });
      if (claimed?.type !== "claimed") throw new Error("pairing claim failed");
      endpoint = { url, credential: claimed.data };
    } finally { pairing.close(); }
  }
  const proxy = await startShapedTcpProxy({ targetUrl: endpoint.url, profile: { rttMs: 200, bandwidthMbps: 2 } });
  const diagnostics: Array<{ atMs: number; kind: string; detail: Record<string, unknown> }> = [];
  const began = performance.now();
  const input = () => { const e = mode !== "loopback" ? endpoint : daemonEndpoint(opened.daemon); return { ...e, url: proxy.urlFor(e.url) }; };
  const peer = new Client({ ...input(), rtcEnabled: false, requestTimeoutMs: 10000,
    socketFactory: url => new WebSocket(url) as unknown as WebSocketLike, redial: async () => input(),
    onDiagnostic(e) {
      if (!["connection", "error"].includes(e.kind)) return;
      diagnostics.push({ atMs: Math.round(performance.now() - began), kind: e.kind,
        detail: Object.fromEntries(Object.entries(e.detail).filter(([k]) => ["state", "phase", "closeReason", "errorName"].includes(k))) });
      if (diagnostics.length > 50) diagnostics.shift();
    },
  });
  let stream: ReturnType<Client["openShellStream"]> | undefined;
  let drain: Promise<void> | undefined;
  let responseBytes = 0, streamError: string | null = null;
  const abort = new AbortController();
  const samples: Array<{ ms: number; type?: string; error?: string }> = [];
  try {
    peer.connect(); await t.tools.waitUntil(() => peer.connectionState === "ready", 15000);
    const owner = peer.logicalConnectionId;
    if (mode === "preview") {
      const bytes = randomBytes(24 * 1024 * 1024);
      Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
      writeFileSync(join(opened.workspaceRoot, "causal-control.png"), bytes);
      drain = peer.preview(opened.workspaceId, `${opened.rootHandle}/causal-control.png`, "original", abort.signal)
        .then(r => { responseBytes = r.bytes.length; }, e => { streamError = e instanceof Error ? e.name : "unknown"; });
    } else {
      stream = peer.openShellStream({ workspaceId: opened.workspaceId, cwd: opened.workspaceRoot, timeoutMs: 80000,
      argv: ["python3", "-c", `import sys,time\nfor n in range(${mode === "fabric" ? 1536 : 512}):\n sys.stdout.write('x'*16384+'\\n');sys.stdout.flush();time.sleep(0.001)`] });
    await stream.finish(); await stream.responseHead;
    const body = stream.body();
    drain = (async () => {
      try { for await (const chunk of body) responseBytes += chunk.length; }
      catch (e) { streamError = e instanceof Error ? e.name : "unknown"; }
    })();
    }
    const until = performance.now() + 38000;
    while (performance.now() < until) {
      const start = performance.now();
      try { const r = await peer.call({ type: "workspace.list" }); samples.push({ ms: Math.round(performance.now() - start), type: r?.type }); }
      catch (e) { samples.push({ ms: Math.round(performance.now() - start), error: e instanceof Error ? e.name : "unknown" }); }
      await pause(500);
    }
    abort.abort(); stream?.reset(1);
    await new Promise(resolve => setTimeout(resolve, 500));
    const afterStop = await peer.call({ type: "workspace.list" })
      .then(reply => reply?.type === "workspaces").catch(() => false);
    const relayCounts = relay ? { lateFrameOverflow: (relay.logTail().match(/lateFrameOverflow/g) ?? []).length,
      unknownStream: (relay.logTail().match(/unknownStream/g) ?? []).length } : null;
    const summary = { mode, profile: { rttMs: 200, bandwidthMbps: 2 }, responseBytes, streamError, relayCounts,
      ownerRetained: peer.logicalConnectionId === owner, state: peer.connectionState, afterStop,
      maxRpcMs: Math.max(...samples.map(x => x.ms)), samples, proxy: proxy.stats(), diagnostics };
    t.note(JSON.stringify(summary));
    t.assertions.assert(mode === "preview" ? proxy.stats().targetToClientBytes > 2 * 1024 * 1024 : responseBytes > 65536,
      "real producer bytes did not cross the shaped path");
    // A 2Mbps single path is the documented degraded case: sustained bulk may
    // consume the 10s request budget, but the path must stay owned and usable.
    t.assertions.assert(samples.some(x => x.type === "workspaces") || afterStop,
      "stream output never completed an interactive request, before or after stop");
    t.assertions.assert(summary.ownerRetained && summary.state === "ready", "stream output discarded the logical owner");
  } finally {
    abort.abort(); stream?.reset(1); peer.close(); await drain; await proxy.stop();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); relay?.stop();
  }
});
}

for (const queuedKiB of [0, 16, 256]) {
defineSpecialty(meta(queuedKiB === 0 ? "fabric-congestion-heartbeat-eviction" : queuedKiB === 256 ? "fabric-legitimate-tail-isolation" : "fabric-small-tail-control",
  "Closing a real peer with queued ordinary output does not evict the node for late frames"), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const nodeLink = await startShapedTcpProxy({ targetUrl: relay.origin, profile: { rttMs: 0, bandwidthMbps: 1000 } });
  let peer: Client | undefined;
  let stream: ReturnType<Client["openShellStream"]> | undefined;
  let drain: Promise<void> | undefined;
  const diagnostics: Array<{ atMs: number; state?: unknown; closeReason?: unknown }> = [];
  const began = performance.now();
  try {
    const remote = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: nodeLink.urlFor(relay.origin), joinToken: relay.joinToken } });
    if (remote?.type !== "remoteAccess" || !remote.data.rendezvousUrl) throw new Error("node attachment failed");
    await t.tools.waitUntil(async () => { const r = await opened.client.call({ type: "device.list" }); return r?.type === "devices" && r.data.remote.online; }, 15000);
    // Only the daemon uplink is shaped. Keep the browser's independent leg
    // at the actual Relay address, preserving its issued path and ticket.
    const url = new URL(remote.data.rendezvousUrl);
    const real = new URL(relay.origin); url.host = real.host;
    const invite = await opened.client.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("invite failed");
    const split = invite.data.code.indexOf("."); const inviteId = invite.data.code.slice(0, split);
    const pairing = await connectProductClient({ url: url.toString(), inviteCredential: { inviteId, secret: invite.data.code.slice(split + 1) } });
    let credential: { deviceId: string; secret: string };
    try {
      const claimed = await pairing.call({ type: "device.claim", payload: { code: inviteId, deviceName: "queued-tail-source" } });
      if (claimed?.type !== "claimed") throw new Error("claim failed");
      credential = claimed.data;
    } finally { pairing.close(); }
    peer = new Client({ url: url.toString(), credential, rtcEnabled: false,
      ...(queuedKiB === 0 ? {} : { heartbeatMs: 0 }),
      redial: async () => ({ url: url.toString(), credential }),
      onDiagnostic(e) { if (e.kind === "connection") { diagnostics.push({ atMs: Math.round(performance.now() - began), state: e.detail.state, closeReason: e.detail.closeReason }); if (diagnostics.length > 30) diagnostics.shift(); } },
      socketFactory: u => new WebSocket(u) as unknown as WebSocketLike });
    peer.connect(); await t.tools.waitUntil(() => peer!.connectionState === "ready", 15000);
    stream = peer.openShellStream({ workspaceId: opened.workspaceId, cwd: opened.workspaceRoot, timeoutMs: 70000,
      argv: ["python3", "-c", "import pathlib,sys,time\np=pathlib.Path('tail-go')\nwhile not p.exists():time.sleep(0.01)\nfor n in range(50000):\n sys.stdout.write('x'*128+'\\n');sys.stdout.flush();time.sleep(0.001)"] });
    await stream.finish(); await stream.responseHead;
    let responseBytes = 0;
    const body = stream.body();
    drain = (async () => { try { for await (const x of body) responseBytes += x.length; } catch { /* peer closure is intentional */ } })();
    const beforeBytes = nodeLink.stats().clientToTargetBytes;
    nodeLink.setProfile({ rttMs: 200, bandwidthMbps: 0.25 });
    writeFileSync(join(opened.workspaceRoot, "tail-go"), "go");
    // A corrected pacer may prevent the historical large queue entirely.
    // Require actual producer traffic, then hold the same narrow-link stimulus
    // for a measured interval; never require the removed bug as a precondition.
    await t.tools.waitUntil(() => nodeLink.stats().clientToTargetBytes - beforeBytes > 16 * 1024, 12000);
    await pause(queuedKiB === 256 ? 8000 : 2000);
    const beforeClose = { receivedBytes: responseBytes, link: nodeLink.stats() };
    if (queuedKiB !== 0) peer.close();
    await pause(queuedKiB === 0 ? 45000 : 18000);
    const log = relay.logTail();
    const daemonLog = readFileSync(join(t.env.data, "logs/daemon.log"), "utf8");
    const summary = { queuedKiB, manualClose: queuedKiB !== 0, diagnostics, beforeClose, finalReceivedBytes: responseBytes, link: nodeLink.stats(),
      lateFrameOverflow: (log.match(/lateFrameOverflow/g) ?? []).length,
      unknownStream: (log.match(/unknownStream/g) ?? []).length,
      nodeDisconnects: (daemonLog.match(/Fabric uplink disconnected/g) ?? []).length,
      nodeEstablished: (daemonLog.match(/Fabric v2 uplink established/g) ?? []).length };
    t.note(JSON.stringify(summary));
    t.assertions.assert(summary.lateFrameOverflow === 0 && summary.nodeDisconnects === 0,
      "legitimate queued output after peer close triggered node-wide Relay punishment");
    t.assertions.assert(!diagnostics.some(x => x.state === "reconnecting" && x.closeReason === "heartbeat-timeout"),
      "live output congestion triggered a heartbeat path teardown");
  } finally {
    stream?.reset(1); peer?.close(); await drain;
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); await nodeLink.stop(); relay.stop();
  }
});
}

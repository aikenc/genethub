import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty, daemonEndpoint } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.connectivity.paused-consumers-preserve-liveness",
  title: "Two paused output consumers apply backpressure without discarding a live connection",
  oracle: "Two real stdout producers stop progressing while their bodies remain unconsumed; no physical fault is injected, application heartbeat must not replace the owner, and cancelling both streams restores a public workspace RPC",
  catches: ["shared receive custody exhaustion makes an application heartbeat discard an otherwise live multiplexed carrier"],
  tags: ["network-review-experiment", "connectivity", "multiplexing", "backpressure"],
  llm: { default: "none" },
  expectedDurationMs: 50000,
  timeoutMs: 100000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "workbench-client", "websocket"],
  productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  retention: true,
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const diagnostics: Array<{ atMs: number; kind: string; detail: Record<string, unknown> }> = [];
  const started = performance.now();
  const input = () => daemonEndpoint(opened.daemon);
  const peer = new Client({
    ...input(),
    rtcEnabled: false,
    requestTimeoutMs: 5000,
    socketFactory: url => new WebSocket(url) as unknown as WebSocketLike,
    redial: async () => input(),
    onDiagnostic(event) {
      if (event.kind !== "connection" && event.kind !== "transport" && event.kind !== "error") return;
      diagnostics.push({ atMs: Math.round(performance.now() - started), kind: event.kind,
        detail: Object.fromEntries(Object.entries(event.detail).filter(([key]) =>
          ["state", "phase", "closeReason", "errorName", "connectionEpoch", "attempt"].includes(key))) });
      if (diagnostics.length > 40) diagnostics.shift();
    },
  });
  const streams: ReturnType<Client["openShellStream"]>[] = [];
  const progress = (n: number) => {
    try { return Number(readFileSync(join(opened.workspaceRoot, `paused-${n}`), "utf8")); }
    catch { return 0; }
  };
  try {
    peer.connect();
    await t.tools.waitUntil(() => peer.connectionState === "ready", 10000);
    const owner = peer.logicalConnectionId;
    for (let n = 0; n < 2; n++) {
      const stream = peer.openShellStream({ workspaceId: opened.workspaceId, cwd: opened.workspaceRoot,
        timeoutMs: 70000, argv: ["python3", "-c",
          `import pathlib,sys,time\np=pathlib.Path('paused-${n}'); n=0\nwhile True:\n sys.stdout.write('x'*16384+'\\n'); sys.stdout.flush(); n+=1; p.write_text(str(n)); time.sleep(0.001)`] });
      streams.push(stream);
      await stream.finish();
      await stream.responseHead;
      await t.tools.waitUntil(() => existsSync(join(opened.workspaceRoot, `paused-${n}`)), 5000);
    }
    let last = "", stableSince = performance.now();
    await t.tools.waitUntil(() => {
      const counts = [progress(0), progress(1)];
      const next = counts.join(",");
      if (next !== last || counts.some(count => count === 0)) { last = next; stableSince = performance.now(); }
      return counts.every(count => count > 0) && performance.now() - stableSince >= 1000;
    }, 15000);
    const paused = [progress(0), progress(1)];
    // Use the production 25s heartbeat interval and 10s timeout. The opaque
    // transport is never cut, paused or replaced by this test.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 38000 - (performance.now() - started))));
    const heartbeats = diagnostics.filter(event => event.detail.state === "reconnecting" &&
      event.detail.closeReason === "heartbeat-timeout");
    const beforeCancel = { state: peer.connectionState, ownerRetained: peer.logicalConnectionId === owner,
      progress: [progress(0), progress(1)], heartbeats: heartbeats.length };
    for (const stream of streams) stream.reset(1);
    const recoveryStarted = performance.now();
    const reply = await peer.call({ type: "workspace.list" }).then(
      value => ({ type: value?.type, error: null }),
      error => ({ type: null, error: error instanceof Error ? error.name : "unknown" }),
    );
    t.note(JSON.stringify({ paused, beforeCancel, reply,
      recoveryMs: Math.round(performance.now() - recoveryStarted), diagnostics }));
    t.assertions.assert(reply.type === "workspaces", "cancelling the paused streams did not restore RPC");
    t.assertions.assert(beforeCancel.ownerRetained && heartbeats.length === 0,
      "paused consumers caused heartbeat-timeout recovery without an injected physical failure");
  } finally {
    for (const stream of streams) stream.reset(1);
    peer.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

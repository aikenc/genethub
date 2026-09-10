import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocketLike } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

// Fault fb_XR0qEbstIxjW/fb_dr_jQLe1lL3t: physical loss used to destroy the
// stream owner. A real process provides an independent exactly-once oracle.
defineSpecialty({
  id: "specialty.connectivity.logical-resume",
  title: "A running shell stream survives a physical socket loss without restarting its process",
  oracle: "The same public DataStream completes with before/after stdout, one exit and one append to a real file after a real WebSocket terminate and fresh admission",
  catches: ["carrier abort destroys handler", "recovery replays business request", "FIN lost across resume", "client opens a replacement event stream"],
  tags: ["core", "connectivity", "logical-resume"],
  llm: { default: "none" },
  expectedDurationMs: 20000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0 },
  surfaces: ["genehub-host", "daemon", "workbench-client", "websocket"],
  productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async (t) => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const sockets: WebSocket[] = [];
  let client: typeof opened.client | null = null;
  try {
    client = await t.flows.main.openSecondClient(opened, "resume-peer", {
      socketFactory(url) {
        const socket = new WebSocket(url); sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
    });
    const logicalId = client.logicalConnectionId;
    const marker = join(opened.workspaceRoot, "logical-resume-once.txt");
    const operation = t.flows.main.startShell(client, {
      workspaceId: opened.workspaceId,
      argv: ["python3", "-c", "import pathlib,time; p=pathlib.Path('logical-resume-once.txt'); f=p.open('a'); f.write('started\\n'); f.close(); print('before',flush=True); time.sleep(6); print('after',flush=True)"],
      cwd: opened.workspaceRoot,
      timeoutMs: 20000,
    });
    const streamId = operation.stream.id;
    // Observe the process's own disk side effect before breaking the socket.
    await t.tools.waitUntil(() => existsSync(marker), 10000);
    t.assertions.assert(sockets.length === 1, "unexpected pre-fault redial");
    sockets[0]!.terminate();
    const result = await operation.result;
    await t.tools.waitUntil(() => client!.connectionState === "ready", 15000);
    t.assertions.assert(sockets.length === 2, "unexpected redial beyond the injected socket loss and channel probe");
    t.assertions.assert(client.logicalConnectionId === logicalId, "probe or recovery replaced the logical owner");
    t.assertions.assert(operation.stream.id === streamId, "the application stream was replaced");
    t.assertions.assert(t.flows.main.shellText(result.frames, "stdout") === "before\nafter\n", "stream bytes were lost or repeated across reconnect");
    t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "the retained process did not exit successfully");
    t.assertions.assert(readFileSync(marker, "utf8") === "started\n", "recovery restarted the business operation");
    const listed = await client.call({ type: "workspace.list" });
    t.assertions.assert(listed?.type === "workspaces", "the resumed connection could not serve a new RPC");
    t.note("Real socket termination; one process start, complete retained stream, and successful post-resume RPC.");
  } finally {
    client?.close();
    for (const socket of sockets) socket.close();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

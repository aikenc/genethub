import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocketLike } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

// The historical catalog ID is retained; byte resume is intentionally removed.
// A real process append proves reconnect does not repeat the command.
defineSpecialty({
  id: "specialty.connectivity.logical-resume",
  title: "A lost shell stream ends explicitly and new requests use a fresh connection",
  oracle: "After a real WebSocket is terminated, the old shell stream rejects, a fresh authenticated connection serves new RPCs, and the source process append proves no automatic re-execution",
  catches: ["carrier loss leaves a stream pending", "reconnect replays a business request", "new requests use a closed owner"],
  tags: ["network-risk-v2", "multichannel","core", "connectivity", "logical-resume"],
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
    // Observe the process's own disk side effect before breaking the socket.
    await t.tools.waitUntil(() => existsSync(marker), 10000);
    t.assertions.assert(sockets.length === 1, "unexpected pre-fault redial");
    sockets[0]!.terminate();
    const outcome = await operation.result.then(() => ({ failed: false }), () => ({ failed: true }));
    t.assertions.assert(outcome.failed, "the lost stream did not report its incomplete result");
    await t.tools.waitUntil(() => client!.connectionState === "ready", 15000);
    t.assertions.assert(sockets.length === 2, "unexpected redial beyond the injected socket loss");
    t.assertions.assert(client.logicalConnectionId !== logicalId, "the new carrier retained the closed endpoint owner");
    const terminated = await operation.stream.done.then(() => false, () => true);
    t.assertions.assert(terminated, "the old stream remained successful after an incomplete body was lost");
    t.assertions.assert(readFileSync(marker, "utf8") === "started\n", "reconnect restarted the business operation");
    const listed = await client.call({ type: "workspace.list" });
    t.assertions.assert(listed?.type === "workspaces", "the new connection could not serve a new RPC");
    t.note("Real socket termination; explicit old-stream failure, one source start, and successful RPC on a new connection.");
  } finally {
    client?.close();
    for (const socket of sockets) socket.close();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

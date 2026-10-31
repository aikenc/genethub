import { spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

const echoServer = `import os, sys
from aiohttp import web, WSMsgType
async def ws(request):
    socket = web.WebSocketResponse(); await socket.prepare(request)
    async for message in socket:
        if message.type == WSMsgType.TEXT: await socket.send_str(message.data)
    return socket
app = web.Application(); app.router.add_get("/health", lambda r: web.Response(text="ok")); app.router.add_get("/ws", ws)
web.run_app(app, host="127.0.0.1", port=int(os.environ["PORT"]), print=None)
`;
// A process-only backend (no origin) is how an offscreen app such as a game is
// started beside its signalling service. The viewer limit is what keeps a second
// person from driving the same instance.
defineSpecialty(
  {
    id: "specialty.preview.offscreen-runner-viewer-limit",
    title: "A runner starts origin-less app processes and admits one viewer per limited route",
    oracle:
      "the origin-less process runs and is stopped with the runner; the first WS echoes; a second WS is closed with viewer_limit while the first stays usable; after the first closes a new viewer is admitted",
    catches: [
      "an app process with no HTTP port cannot be declared",
      "a second viewer reaches an instance that allows one",
      "the viewer slot leaks after a disconnect",
      "the app process outlives the runner",
    ],
    tags: ["network-risk-v2", "core", "service-preview"],
    llm: { default: "none" },
    expectedDurationMs: 20000,
    timeoutMs: 120000,
    requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] }],
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "workbench", "service-preview"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredRepos: ["cloud"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    const python = process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
    if (!python) throw new BlockedError("GENEHUB_PREVIEW_MEDIA_PYTHON must point to Python 3.11+ with aiohttp");
    const example = join(t.env.workspace, "service-example");
    cpSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub-preview/assets/python-adapter"), join(example, "python-adapter"), { recursive: true });
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const entry = join(t.env.workspace, "index.html"),
      config = join(t.env.workspace, "application.json"),
      marker = join(t.env.workspace, "app-process.pid"),
      appScript = join(t.env.workspace, "app_process.py"), echoScript = join(t.env.workspace, "echo_backend.py");
    await writeFile(entry, "<!doctype html><title>Offscreen app</title>");
    await writeFile(appScript, `import os, time\nopen(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\ntime.sleep(3600)\n`);
    await writeFile(echoScript, echoServer);
    await writeFile(config, JSON.stringify({
      entry: "index.html",
      backends: [
        {
          command: [python, echoScript],
          origin: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
          health: "/health",
          routes: [{ prefix: "/api/demo/", websocket: true, maxViewers: 1 }],
        },
        { command: [python, appScript] },
      ],
    }));
    const runner = spawn(python, [join(example, "python-adapter/run.py"), "--config", config, "--daemon-root", t.env.data], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [runner.stdout, runner.stderr]) stream.on("data", (b) => { output = (output + b).slice(-4096); });
    let service: ServicePreviewClient | null = null;
    let appPid = 0;
    try {
      await t.tools.waitUntil(async () => {
        if (runner.exitCode !== null) throw new Error(`runner exited: ${output}`);
        service = await ServicePreviewClient.discover(opened.client, opened.workspaceId, `${opened.rootHandle}/index.html`);
        return service !== null;
      }, 20000);
      const active = service as unknown as ServicePreviewClient;
      await t.tools.waitUntil(() => existsSync(marker), 5000);
      appPid = Number(await readFile(marker, "utf8"));
      t.assertions.assert(appPid > 0, "origin-less app process did not start");
      const inventory = await opened.client.call({ type: "process.workspaceList", payload: { workspaceId: opened.workspaceId } });
      t.assertions.assert(inventory?.type === "processes" && inventory.data.some(p => p.pid === appPid), "origin-less app process missing from the runner process tree");

      const open = async () => {
        const received: Uint8Array[] = [];
        const socket = await active.websocket("/api/demo/ws", async (packet) => { received.push(packet); });
        return { socket, received };
      };
      const text = (p: Uint8Array) => new TextDecoder().decode(p.slice(1));
      const first = await open();
      await t.tools.waitUntil(() => first.received.some(p => p[0] === 0 && text(p).includes('"open"')), 5000);
      const second = await open();
      await t.tools.waitUntil(() => second.received.some(p => p[0] === 0 && text(p).includes("viewer_limit")), 5000);
      t.assertions.assert(!second.received.some(p => p[0] === 0 && text(p).includes('"open"')), "the second viewer was admitted");
      await first.socket.send({ kind: "text", text: "still mine" });
      await t.tools.waitUntil(() => first.received.some(p => text(p).includes("still mine")), 5000);
      second.socket.close();
      first.socket.close();
      // The slot is released when the first viewer's bridge closes.
      let admitted = false;
      await t.tools.waitUntil(async () => {
        const next = await open();
        admitted = await t.tools.waitUntil(() => next.received.some(p => p[0] === 0 && text(p).includes('"open"')), 1500).then(() => true, () => false);
        next.socket.close();
        return admitted;
      }, 15000);
      t.assertions.assert(admitted, "the viewer slot was not released after disconnect");

      await opened.client.call({ type: "process.serviceStop", payload: { workspaceId: opened.workspaceId, entryPath: `${opened.rootHandle}/index.html`, runId: active.descriptor.runId } });
      await t.tools.waitUntil(() => runner.exitCode !== null, 10000);
      await t.tools.waitUntil(() => { try { process.kill(appPid, 0); return false; } catch { return true; } }, 10000);
      t.assertions.assert(readdirSync(join(t.env.data, "service-previews")).length === 0, "a normal stop left the registration behind");
    } finally {
      (service as ServicePreviewClient | null)?.close();
      runner.kill("SIGTERM");
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

// The UE 5.4 signalling server shipped for the runner (Python, no Node): a stand-in streamer
// and player speak the real message flow.
defineSpecialty(
  {
    id: "specialty.preview.pixel-streaming-signalling",
    title: "The shipped Python signalling server pairs a streamer with a player and relays the WebRTC handshake",
    oracle:
      "the streamer gets config+identify and registers; a player hands over the platform ICE servers, lists and subscribes; the streamer gets a config naming exactly those servers before playerConnected with the player id; offer/answer/iceCandidate cross in both directions with the player id added toward the streamer and removed toward the player; a malformed ICE list closes that player; losing the streamer closes the player",
    catches: [
      "the signalling server stops speaking the UE 5.4 message flow",
      "player ids leak to the browser or are missing toward Unreal",
      "a lost streamer leaves players attached",
      "Unreal never learns the platform STUN/TURN servers, so a game on another network offers only LAN candidates",
    ],
    tags: ["network-risk-v2", "service-preview"],
    llm: { default: "none" },
    requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] }],
    expectedDurationMs: 10000,
    timeoutMs: 60000,
    resources: { environments: 1, cpu: 1, memoryMb: 256, io: 1, browser: 0, pool: "standard" },
    surfaces: ["os-process", "service-preview"],
  },
  async (t) => {
    const python = process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
    if (!python) throw new BlockedError("GENEHUB_PREVIEW_MEDIA_PYTHON must point to Python 3.11+ with aiohttp");
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      ports.push((reservation.address() as { port: number }).port);
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
    }
    const server = spawn(python, [join(t.openRoot, "apps/daemon/builtin-skills/genehub-preview/assets/unreal/signalling.py"), "--http-port", String(ports[0]), "--streamer-port", String(ports[1])], { stdio: "ignore" });
    const connect = async (url: string) => {
      const inbox: Record<string, unknown>[] = [];
      const socket = new WebSocket(url);
      socket.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
      const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code); });
      await t.tools.waitUntil(async () => socket.readyState === WebSocket.OPEN, 10000);
      const next = async (type: string) => {
        await t.tools.waitUntil(async () => inbox.some((m) => m.type === type), 5000);
        return inbox.splice(inbox.findIndex((m) => m.type === type), 1)[0]!;
      };
      return { socket, next, closed };
    };
    try {
      await t.tools.waitUntil(async () => (await fetch(`http://127.0.0.1:${ports[0]}/`).catch(() => null))?.ok === true, 10000);
      const streamer = await connect(`ws://127.0.0.1:${ports[1]}`);
      await streamer.next("config");
      await streamer.next("identify");
      streamer.socket.send(JSON.stringify({ type: "endpointId", id: "DefaultStreamer" }));
      const player = await connect(`ws://127.0.0.1:${ports[0]}/ws`);
      await player.next("config");
      const ice = [{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:turn.example:3478?transport=udp"], username: "u", credential: "p" }];
      player.socket.send(JSON.stringify({ type: "iceServers", iceServers: ice }));
      player.socket.send(JSON.stringify({ type: "listStreamers" }));
      t.assertions.assert(JSON.stringify((await player.next("streamerList")).ids) === '["DefaultStreamer"]', "the registered streamer was not listed");
      player.socket.send(JSON.stringify({ type: "subscribe", streamerId: "DefaultStreamer" }));
      const reconfigured = await streamer.next("config");
      t.assertions.assert(JSON.stringify((reconfigured.peerConnectionOptions as { iceServers?: unknown })?.iceServers) === JSON.stringify(ice), `Unreal did not get the page's ICE servers: ${JSON.stringify(reconfigured)}`);
      const connected = await streamer.next("playerConnected");
      t.assertions.assert(typeof connected.playerId === "string" && connected.sendOffer === true, `unexpected playerConnected: ${JSON.stringify(connected)}`);
      streamer.socket.send(JSON.stringify({ type: "offer", playerId: connected.playerId, sdp: "v=0" }));
      const offer = await player.next("offer");
      t.assertions.assert(offer.sdp === "v=0" && !("playerId" in offer), "the offer reached the player with a player id or without its body");
      player.socket.send(JSON.stringify({ type: "answer", sdp: "v=1" }));
      const answer = await streamer.next("answer");
      t.assertions.assert(answer.sdp === "v=1" && answer.playerId === connected.playerId, "the answer did not reach Unreal tagged with the player id");
      player.socket.send(JSON.stringify({ type: "iceCandidate", candidate: { candidate: "c" } }));
      t.assertions.assert((await streamer.next("iceCandidate")).playerId === connected.playerId, "the ICE candidate was not tagged with the player id");
      const bad = await connect(`ws://127.0.0.1:${ports[0]}/ws`);
      bad.socket.send(JSON.stringify({ type: "iceServers", iceServers: [{ urls: ["http://not-ice"] }] }));
      t.assertions.assert(await Promise.race([bad.closed, new Promise<number>((resolve) => setTimeout(() => resolve(0), 5000))]) === 1008, "a malformed ICE list was accepted");
      streamer.socket.close();
      await Promise.race([player.closed, t.tools.waitUntil(async () => false, 5000).then(() => Promise.reject(new Error("the player stayed attached after the streamer was lost")))]);
    } finally {
      server.kill("SIGTERM");
    }
  },
);

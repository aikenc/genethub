import { spawn } from "node:child_process";
import { cpSync } from "node:fs";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import { BlockedError, daemonEndpoint, defineSpecialty, openPreviewBrowser } from "../../framework/public.ts";

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
// The engine-streaming page mode (`pixel-streaming/1`) through the real Preview page:
// the sandbox allows pointer lock, the page gets scoped describe()/ice(), the signalling
// route admits one viewer, and revoking the service closes it. A plain echo backend
// stands in for the signalling server; no game or WebRTC peer is claimed here.
defineSpecialty(
  {
    id: "specialty.preview.engine-streaming-page-mode",
    title: "Engine-streaming pages get pointer lock and ICE, one viewer per route, and lose the stream on revoke",
    oracle:
      "the real Preview iframe allows pointer lock; the page API reports pixel-streaming/1 and ICE; a second WS is closed with viewer_limit while the first echoes; stopping the service closes the first and refuses a new one; re-enabling admits a viewer again; no control-takeover button is offered",
    catches: [
      "the new page mode is rejected or loses the sandbox pointer-lock permission",
      "a second viewer reaches an instance that allows one",
      "revoking the service leaves the stream open or reconnectable",
      "an engine page is shown a Capture-only control toggle",
    ],
    tags: ["network-risk-v2", "page-experience", "service-preview"],
    runner: "playwright",
    llm: { default: "none" },
    expectedDurationMs: 30000,
    timeoutMs: 120000,
    requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] }],
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
    surfaces: ["browser", "daemon", "service-preview"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredRepos: ["cloud"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    if (!t.browser) throw new BlockedError("real browser required");
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
    const entry = join(t.env.workspace, "index.html"), config = join(t.env.workspace, "application.json");
    const echoScript = join(t.env.workspace, "echo_backend.py");
    await writeFile(echoScript, echoServer);
    await writeFile(entry, "<!doctype html><title>Engine page</title><body>engine page</body>");
    await writeFile(config, JSON.stringify({
      entry: "index.html",
      media: { offerPath: "/api/demo/ws", microphone: "none", client: "html", protocol: "pixel-streaming/1", sessionPath: "/api/demo/ws" },
      backends: [{
        command: [python, echoScript],
        origin: `http://127.0.0.1:${port}`,
        env: { PORT: String(port) },
        health: "/health",
        routes: [{ prefix: "/api/demo/", websocket: true, maxViewers: 1 }],
      }],
    }));
    const runner = spawn(python, [join(example, "python-adapter/run.py"), "--config", config, "--daemon-root", t.env.data], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [runner.stdout, runner.stderr]) stream.on("data", (b) => { output = (output + b).slice(-4096); });
    let service: ServicePreviewClient | null = null;
    const page = await t.browser.newPage();
    let consumer: Awaited<ReturnType<typeof openPreviewBrowser>> | undefined;
    try {
      await t.tools.waitUntil(async () => {
        if (runner.exitCode !== null) throw new Error(`runner exited: ${output}`);
        service = await ServicePreviewClient.discover(opened.client, opened.workspaceId, `${opened.rootHandle}/index.html`);
        return service !== null;
      }, 20000);
      t.assertions.assert((service as unknown as ServicePreviewClient).descriptor.media?.protocol === "pixel-streaming/1", "descriptor lost the page mode");
      consumer = await openPreviewBrowser({ openRoot: t.openRoot, lease: t.env, page, endpoint: daemonEndpoint(opened.daemon), refreshEndpoint: () => daemonEndpoint(opened.daemon), workspaceId: opened.workspaceId, entryPath: `${opened.rootHandle}/index.html` });
      const enable = async () => {
        await page.getByRole("button", { name: "预览信息", exact: true }).click({ timeout: 30000 });
        await page.getByRole("button", { name: "允许本次预览访问登记服务", exact: true }).click({ timeout: 30000 });
        await page.getByRole("button", { name: "关闭信息", exact: true }).click();
      };
      await enable();
      const frame = page.frameLocator("iframe").first();
      const sandbox = await page.locator("iframe").first().getAttribute("sandbox");
      t.assertions.assert(!!sandbox?.includes("allow-pointer-lock"), `engine page iframe lacks pointer lock: ${sandbox}`);
      t.assertions.assert(await page.getByRole("button", { name: "停止观看", exact: true }).isVisible(), "no stop control for the engine page");
      t.assertions.assert(!(await page.getByRole("button", { name: "允许本页接管" }).count()), "engine page was offered the Capture takeover toggle");
      const api = await frame.locator("body").evaluate(async (body) => {
        const host = body.ownerDocument.defaultView as unknown as { genehubServicePreview: { describe(): Promise<{ descriptor: { media: { protocol: string } } }>; ice(): Promise<{ iceServers: unknown[] }> } };
        return { protocol: (await host.genehubServicePreview.describe()).descriptor.media.protocol, ice: Array.isArray((await host.genehubServicePreview.ice()).iceServers) };
      });
      t.assertions.assert(api.protocol === "pixel-streaming/1" && api.ice, "page API was not scoped to the engine mode");
      // Page-side sockets over the exact bridge an engine front end would use.
      const bounded = { timeout: 20000 };
      const install = () => frame.locator("body").evaluate((body) => {
        const host = body.ownerDocument.defaultView as unknown as { probe: Record<string, unknown>; openProbe: (name: string) => Promise<void>; WebSocket: typeof WebSocket };
        host.probe = {};
        host.openProbe = (name: string) => new Promise<void>((resolve) => {
          const ws = new host.WebSocket("wss://preview.invalid/api/demo/ws");
          const state = { opened: false, closed: null as null | { code: number; reason: string }, echoed: "" };
          host.probe[name] = Object.assign(state, { ws });
          ws.onopen = () => { state.opened = true; resolve(); };
          ws.onmessage = (event) => { state.echoed = String(event.data); };
          ws.onclose = (event) => { state.closed = { code: event.code, reason: event.reason }; resolve(); };
        });
      }, undefined, bounded);
      type Probe = { opened: boolean; closed: null | { code: number; reason: string }; echoed: string; ws: WebSocket };
      const probe = (name: string) => frame.locator("body").evaluate((body, key) => {
        const state = (body.ownerDocument.defaultView as unknown as { probe: Record<string, Probe> }).probe[key];
        return state ? { opened: state.opened, closed: state.closed, echoed: state.echoed } : null;
      }, name, bounded);
      const open = (name: string) => frame.locator("body").evaluate((body, key) => (body.ownerDocument.defaultView as unknown as { openProbe(n: string): Promise<void> }).openProbe(key), name, bounded);
      await install();
      await open("first");
      t.assertions.assert((await probe("first"))?.opened === true, "first viewer was not admitted");
      await open("second");
      const second = await probe("second");
      t.assertions.assert(second?.opened === false && second.closed?.code === 1013 && second.closed.reason === "viewer_limit", `second viewer was not refused: ${JSON.stringify(second)}`);
      await frame.locator("body").evaluate((body) => (body.ownerDocument.defaultView as unknown as { probe: Record<string, Probe> }).probe.first!.ws.send("still mine"));
      await t.tools.waitUntil(async () => (await probe("first"))?.echoed === "still mine", 5000);
      // Revoke from the trusted toolbar, then allow again. The route admits one viewer, so a new
      // viewer can only get in if the revoked stream was really closed on the runner's side.
      await page.getByRole("button", { name: "停止观看", exact: true }).click();
      await enable();
      // The page reloads when the service is allowed again; wait until its bridge answers.
      await t.tools.waitUntil(() => frame.locator("body").evaluate(async (body) => {
        try { await (body.ownerDocument.defaultView as unknown as { genehubServicePreview: { describe(): Promise<unknown> } }).genehubServicePreview.describe(); return true; } catch { return false; }
      }, undefined, { timeout: 20000 }).catch(() => false), 40000);
      await install();
      await open("after");
      t.assertions.assert((await probe("after"))?.opened === true, `re-enabling did not admit a viewer (the revoked stream still held the slot?): ${JSON.stringify(await probe("after"))}`);
    } finally {
      (service as ServicePreviewClient | null)?.close();
      runner.kill("SIGTERM");
      await page.close();
      await consumer?.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

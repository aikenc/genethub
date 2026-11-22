import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";

import { allocatePort, BlockedError, daemonEndpoint, defineSpecialty, startHub, startRelay, type CaseContext } from "../../framework/public.ts";

const run = promisify(execFile);
const suffix = "preview.test";

const staticSpec: Parameters<typeof defineSpecialty>[0] = {
  id: "specialty.page-experience.independent-preview",
  title: "The two external preview choices keep their original authorization",
  oracle: "The old preview works. A resident worker is connected before the first open and serves multiple origins after idling. The same worker reconnects after loss of the preview transport. Anonymous shares remain scoped and revocable.",
  catches: ["legacy preview replaced", "on-demand or duplicate workers", "idle worker exits", "worker does not reconnect", "share inherits account authority", "copying the resource URL gives access", "TLS terminates before the source"],
  tags: ["page-experience", "authorization", "preview-feedback"],
  runner: "playwright", requiredRepos: ["cloud"], requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"], llm: { default: "mock" },
  expectedDurationMs: 110_000, timeoutMs: 210_000,
  resources: { environments: 1, cpu: 2, memoryMb: 3072, io: 1, browser: 1, pool: "browser" },
  surfaces: ["cloud-console", "cloud-server", "relay", "daemon", "asset-preview"],
  productInterfaces: ["@genehub/workbench", "hub-http", "preview.feedback", "asset.preview"],
};

defineSpecialty(staticSpec, exercise);

defineSpecialty({
  ...staticSpec,
  id: "specialty.page-experience.independent-preview-service",
  title: "Authorized preview origins carry registered HTTP, streaming and WSS",
  expectedDurationMs: 70_000, timeoutMs: 180_000,
  oracle: "A Chromium page reaches the registered runner after confirmation. A static view, scoped share, and sibling origin lack service access.",
  catches: ["registered service unavailable on the new origin", "cross-origin service access", "scope escapes registered routes", "different run receives requests"],
  productInterfaces: [...(staticSpec.productInterfaces ?? []), "service.preview"],
  requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] }],
}, t => exercise(t, "service"));

defineSpecialty({
  ...staticSpec,
  id: "specialty.page-experience.independent-preview-review",
  title: "Independent preview content can be reviewed from the trusted workbench",
  expectedDurationMs: 70_000, timeoutMs: 180_000,
  oracle: "Paired and shared browsers retain isolation. The visitor reports an element, console logs and a DOM snapshot and the owner retrieves the receipt.",
  catches: ["review disables SharedArrayBuffer", "review grants workbench context to content", "annotation or feedback cannot be submitted on the isolated origin"],
}, t => exercise(t, "review"));

defineSpecialty({
  ...staticSpec,
  id: "specialty.page-experience.independent-preview-media",
  title: "Trusted independent review renders registered audio and video",
  expectedDurationMs: 70_000, timeoutMs: 180_000,
  oracle: "The trusted Workbench receives real media, stops the source session, and keeps media routes outside the preview origin.",
  catches: ["explicit media cannot be opened in the independent review", "the content iframe can call media signalling", "a stopped view leaks the source media session"],
  productInterfaces: [...(staticSpec.productInterfaces ?? []), "service.preview"],
  requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp", "aiortc", "av", "numpy"] }],
}, t => exercise(t, "media"));

defineSpecialty({
  ...staticSpec,
  id: "specialty.page-experience.independent-preview-player",
  title: "The engine player streams and accepts input on independent preview origins",
  expectedDurationMs: 70_000, timeoutMs: 180_000,
  oracle: "The shipped player opens through both authorized browser menus, decodes a changing WebRTC video, sends a real key press to the peer, and closes that peer on stop. Static previews cannot obtain ICE.",
  catches: ["engine player requires the old iframe bridge", "engine video plays but input is dropped", "an ordinary view can borrow media access", "stopping leaves the engine player connected"],
  productInterfaces: [...(staticSpec.productInterfaces ?? []), "service.preview"],
  requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] }],
}, t => exercise(t, "player"));

async function exercise(t: CaseContext, mode?: "service" | "review" | "media" | "player") {
  const withService = mode === "service";
  const withReview = mode === "review";
  const withMedia = mode === "media";
  const withPlayer = mode === "player";

  const [edgePort, publicPort, relayPort] = await Promise.all([allocatePort(), allocatePort(), allocatePort()]);
  const workbenchHost = withReview || withMedia ? "workbench.workbench.test" : `workbench.${suffix}`;
  const origin = `https://${workbenchHost}:${publicPort}`;
  const token = randomBytes(32).toString("base64url");
  const relayToken = randomBytes(32).toString("base64url");
  const cloudRoot = process.env.TESTCTL_CLOUD_ROOT!;
  const consoleRoot = path.join(cloudRoot, "console");
  const consoleDir = path.join(t.env.root, "console");
  const cert = path.join(t.env.root, "preview-cert.pem");
  const key = path.join(t.env.root, "preview-key.pem");
  const databasePath = path.join(t.env.root, "hub.sqlite");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=*.${suffix}`, "-addext", `subjectAltName=DNS:*.${suffix},DNS:${workbenchHost}`, "-keyout", key, "-out", cert]);
  const { stdout: publicKey } = await run("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]);
  const publicDer = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  const pin = createHash("sha256").update(publicDer).digest("base64");
  await run(process.execPath, [
    path.join(consoleRoot, "node_modules/vite/bin/vite.js"), "build", "--base", "/", "--outDir", consoleDir,
  ], { cwd: consoleRoot, env: { ...process.env, VITE_GENEHUB_SUBPATH: "" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  process.env.HUB_PUBLIC_ORIGIN = origin;
  process.env.HUB_PREVIEW_EDGE_TOKEN = token;
  process.env.HUB_PREVIEW_PUBLIC_PORT = String(edgePort);
  const hub = await startHub({ databasePath,
    relayOrigin: `http://127.0.0.1:${relayPort}`, relayToken, consoleDir });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let opened: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let edge: ChildProcess | undefined;
  let front: ReturnType<typeof createServer> | undefined;
  let service: ChildProcess | undefined;
  let mediaHealth: string | undefined;
  let streamerPort: number | undefined;
  try {
    relay = await startRelay({ openRoot: t.openRoot, port: relayPort, control: { origin: hub.origin, token: relayToken } });
    edge = spawn(process.execPath, ["--import", "tsx", "src/preview-edge.ts"], {
      cwd: path.join(cloudRoot, "server"),
      stdio: "ignore",
      env: { ...process.env, HUB_PREVIEW_CONTROL_ORIGIN: hub.origin,
        HUB_PREVIEW_LISTEN_HOST: "127.0.0.1", HUB_PREVIEW_LISTEN_PORT: String(edgePort) },
    });
    await once(edge, "spawn");
    front = createServer({ cert: await readFile(cert), key: await readFile(key) }, (incoming, outgoing) => {
      const upstream = request(new URL(incoming.url ?? "/", hub.origin), { method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    }).listen(publicPort, "127.0.0.1");
    await once(front, "listening");
    await writeFile(path.join(t.env.workspace, "index.html"), `<!doctype html><meta charset="utf-8"><p>独立预览样本</p>
      <p id="data">loading</p><script>console.log('preview started before load'); fetch('./data.json').then(r=>r.json()).then(x=>document.querySelector('#data').textContent=x.message)</script>`);
    await writeFile(path.join(t.env.workspace, "data.json"), '{"message":"Shared resource loaded"}');
    await writeFile(path.join(t.env.workspace, "private.txt"), "outside share");
    opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env, launchEnv: {
      GENEHUB_PREVIEW_ENABLED: "1", GENEHUB_PREVIEW_TLS_CERT: cert, GENEHUB_PREVIEW_TLS_KEY: key,
    } });
    if (withService || withMedia || withPlayer) {
      const python = process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
      if (!python) throw new BlockedError("Python with aiohttp is required by the preview runner");
      const example = path.join(t.openRoot, "apps/daemon/builtin-skills/genehub-preview/assets");
      let args = [path.join(example, "python-adapter/app.py"), "--entry", path.join(t.env.workspace, "index.html")];
      if (withPlayer) {
        const httpPort = await allocatePort();
        streamerPort = await allocatePort();
        const engine = path.join(example, "unreal");
        const config = path.join(t.env.workspace, "player.json");
        await copyFile(path.join(engine, "index.html"), path.join(t.env.workspace, "player.html"));
        await copyFile(path.join(engine, "pixelstreaming.esm.js"), path.join(t.env.workspace, "pixelstreaming.esm.js"));
        await writeFile(config, JSON.stringify({
          entry: "player.html",
          backends: [{
            command: [python, path.join(engine, "signalling.py"), "--http-port", String(httpPort), "--streamer-port", String(streamerPort)],
            origin: `http://127.0.0.1:${httpPort}`, health: "/", routes: [{ prefix: "/api/ue/", websocket: true, maxViewers: 1 }],
          }],
          media: { offerPath: "/api/ue/ws", sessionPath: "/api/ue/ws", client: "html", protocol: "pixel-streaming/1" },
        }));
        args = [path.join(example, "python-adapter/run.py"), "--config", config];
      }
      if (withMedia) {
        const [demoPort, mediaPort] = await Promise.all([allocatePort(), allocatePort()]);
        const config = path.join(t.env.workspace, "media.json");
        mediaHealth = `http://127.0.0.1:${mediaPort}/health`;
        await writeFile(config, JSON.stringify({
          entry: "index.html",
          backends: [
            { command: [python, path.join(example, "demo/backend.py")], origin: `http://127.0.0.1:${demoPort}`,
              env: { PREVIEW_DEMO_PORT: String(demoPort) }, health: "/health", routes: [{ prefix: "/api/demo/" }] },
            { command: [python, path.join(example, "demo/media.py")], origin: `http://127.0.0.1:${mediaPort}`,
              env: { PREVIEW_MEDIA_PORT: String(mediaPort) }, health: "/health", routes: [{ prefix: "/api/media/" }] },
          ],
          media: { offerPath: "/api/media/offer", stopPath: "/api/media/stop", microphone: "none" },
        }));
        args = [path.join(example, "python-adapter/run.py"), "--config", config];
      }
      service = spawn(python, [...args, "--daemon-root", t.env.data], { stdio: ["ignore", "ignore", "inherit"] });
      const registration = path.join(t.env.data, "service-previews", createHash("sha256")
        .update(path.join(t.env.workspace, withPlayer ? "player.html" : "index.html")).digest("hex") + ".json");
      await t.tools.waitUntil(async () => {
        if (service?.exitCode != null) throw new Error(`runner exited with code ${service.exitCode}`);
        return access(registration).then(() => true, () => false);
      }, 10_000);
    }
    const device = opened.client.identity?.machineId;
    t.assertions.assert(!!device, "source identity missing");
    t.assertions.assert(opened.client.identity?.features?.includes("asset.preview.independent.v1"),
      "the opted-in daemon did not advertise independent preview");
    if (!device) throw new Error("source identity missing");
    process.env.HUB_PREVIEW_PILOT_MACHINES = `${device}=${suffix}`;
    const account = hub.browser();
    const secureAccount = {
      cookie: account.cookie,
      fetch(target: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers);
        if (init.method === "POST") {
          headers.set("Origin", origin);
          headers.set("Sec-Fetch-Site", "same-origin");
        }
        return account.fetch(target, { ...init, headers });
      },
      async json<T>(target: string, init?: RequestInit) {
        return await (await this.fetch(target, init)).json() as T;
      },
    };
    await hub.signInOwner(secureAccount);
    const paired = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "Preview test source" } });
    if (paired?.type !== "hubStatus" || paired.data.state !== "pairing") throw new Error("source pairing failed");
    await hub.approvePairing(secureAccount, paired.data.userCode);
    await t.tools.waitUntil(async () => {
      const status = await opened!.client.call({ type: "hub.status" });
      return status?.type === "hubStatus" && status.data.state === "paired" && status.data.online;
    }, 45_000);
    // The Hub's relay presence is an independent readiness witness. Do not open
    // a preview to find out whether the supervisor has already connected.
    const initialPresence = await waitForPreviewPresence(t, databasePath, device);
    const daemonPid = daemonEndpoint(opened.daemon).localServerProof.pid;
    const resident = mode === undefined ? await previewThreads(daemonPid) : [];
    if (mode === undefined) {
      if (process.platform === "linux") {
        t.assertions.assert(resident.length === 1, "expected one WASM thread before the first preview");
      }
      t.assertions.assert((await previewWorkerPids(cert)).length === 0, "the daemon spawned a preview subprocess");
    }
    const idleSince = Date.now();
    browser = await chromium.launch({ args: [
      "--no-proxy-server", `--host-resolver-rules=MAP *.${suffix} 127.0.0.1, MAP ${workbenchHost} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${pin}`,
    ] });
    const owner = await browser.newContext();
    const visitor = await browser.newContext();
    const cookie = account.cookie();
    if (!cookie) throw new Error("missing owner session");
    await owner.addCookies(cookie.split("; ").map(part => {
      const at = part.indexOf("=");
      return { name: part.slice(0, at), value: part.slice(at + 1), url: origin, secure: true };
    }));
    const creator = await owner.newPage();
    const locator = [device, opened.workspaceId, opened.rootHandle, "index.html"].map(encodeURIComponent).join("/");
    const legacy = `${origin}/assets/preview/v2/${locator}`;
    await creator.goto(legacy);
    const old = creator.frameLocator('iframe[title="HTML 文件预览"]');
    await old.getByText("Shared resource loaded").waitFor();
    if (mode === undefined) {
      await sleep(Math.max(0, 65_000 - (Date.now() - idleSince)));
      t.assertions.assert((await previewThreads(daemonPid)).join() === resident.join(), "the idle worker was replaced or stopped");
    }
    const menu = creator.getByText("独立预览", { exact: true });
    await menu.click();
    const ownPopup = creator.waitForEvent("popup");
    await creator.getByRole("link", { name: "用已有权限打开" }).click();
    const ownPage = await ownPopup;
    await ownPage.getByText("Shared resource loaded").waitFor();
    if (!await ownPage.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === "function" && window.opener === null)) {
      throw new Error("external preview origin or opener isolation failed");
    }
    if (withPlayer) {
      if (!streamerPort) throw new Error("missing signalling port");
      t.assertions.assert(await ownPage.evaluate(async () =>
        (await fetch("/.well-known/genehub/preview-player-ice")).status) === 403, "static preview gained ICE access");
      const streamer = await owner.newPage();
      await startEnginePeer(streamer, streamerPort);
      const playerLauncher = legacy.replace(/index\.html$/, "player.html");
      await creator.goto(playerLauncher);
      await creator.getByText("引擎串流", { exact: true }).waitFor();
      await exerciseEngineInput(t, old.locator("video"), streamer, 1);
      const stop = creator.getByRole("button", { name: "停止观看" });
      await stop.click();
      await t.tools.waitUntil(() => stop.isDisabled(), 5_000);
      await streamer.locator('body[data-closed="1"]').waitFor({ state: "attached", timeout: 10_000 });

      await menu.click();
      const playerPopup = creator.waitForEvent("popup");
      await creator.getByRole("link", { name: "打开并启用本地服务" }).click();
      const player = await playerPopup;
      await player.getByRole("button", { name: "启用服务并打开预览" }).click();
      await exerciseEngineInput(t, player.locator("video"), streamer, 2);
      await player.close();
      await streamer.locator('body[data-closed="2"]').waitFor({ state: "attached", timeout: 10_000 });

      await menu.click();
      const reviewPopup = creator.waitForEvent("popup");
      await creator.getByRole("link", { name: "打开批注和运行日志" }).click();
      const review = await reviewPopup;
      await review.getByRole("link", { name: "启用本地服务", exact: true }).click();
      await review.getByRole("button", { name: "启用服务并打开预览" }).click();
      const iframe = review.locator('iframe[title="独立 HTML 预览"]');
      await exerciseEngineInput(t, iframe.contentFrame().locator("video"), streamer, 3);
      t.assertions.assert((await iframe.getAttribute("sandbox"))?.includes("allow-pointer-lock"), "engine review blocked mouse capture");
      await review.getByRole("link", { name: "停止引擎串流" }).click();
      await streamer.locator('body[data-closed="3"]').waitFor({ state: "attached", timeout: 10_000 });
      await review.close();
      await streamer.close();
      await creator.goto(legacy);
      await old.getByText("Shared resource loaded").waitFor();
    }
    if (withService) {
      await menu.click();
      const servicePopup = creator.waitForEvent("popup");
      await creator.getByRole("link", { name: "打开并启用本地服务" }).click();
      const page = await servicePopup;
      await page.getByRole("button", { name: "启用服务并打开预览" }).click();
      const ready = page.getByText("Shared resource loaded");
      const failed = page.getByRole("alert");
      await ready.or(failed).waitFor();
      if (await failed.isVisible()) throw new Error(await failed.innerText());
      const executingThreads = await previewThreads(daemonPid);
      if (process.platform === "linux") {
        const staticCount = Number(process.env.GENEHUB_PREVIEW_THREADS ?? "1");
        const serviceCount = process.env.GENEHUB_PREVIEW_SERVICE_THREADS === "0" ? 0
          : Number(staticCount > 0 || process.env.GENEHUB_PREVIEW_SERVICE_THREADS === "1");
        t.assertions.assert(executingThreads.length === staticCount + serviceCount,
          "expected the configured static workers and one worker for the registered service");
      }
      const result = await page.evaluate(async () => {
        const payload = new Uint8Array([0, 255, 1, 34]);
        const echo = await fetch("/api/demo/echo", {
          method: "POST", headers: { "content-type": "application/octet-stream" }, body: payload,
        });
        const data = [...new Uint8Array(await echo.arrayBuffer())];
        const denied = await fetch("/api/unregistered/echo");
        const progress = await fetch("/api/demo/stream");
        const stream = progress.body!.getReader();
        const first = await stream.read();
        const remaining = [];
        while (true) {
          const chunk = await stream.read();
          if (chunk.done) break;
          remaining.push(new TextDecoder().decode(chunk.value));
        }
        const echoed = await new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(new URL("/api/demo/ws", location.href.replace(/^https:/, "wss:")));
          socket.binaryType = "arraybuffer";
          socket.onerror = () => reject(new Error("Could not open WSS"));
          socket.onopen = () => socket.send("preview echo");
          socket.onmessage = event => {
            if (typeof event.data === "string") {
              if (event.data === "preview echo") socket.send(payload);
              else reject(new Error("WebSocket text changed"));
            } else {
              socket.close();
              resolve([...new Uint8Array(event.data)].join(","));
            }
          };
        });
        return { status: echo.status, data, denied: denied.status, progress: new TextDecoder().decode(first.value) + remaining.join(""), echoed };
      });
      t.assertions.assert(result.status === 201 && result.data.join(",") === "0,255,1,34", "HTTP body or status changed");
      t.assertions.assert(result.denied === 403 && result.progress === "data: 0\n\ndata: 1\n\ndata: 2\n\n", "service path restriction or streaming failed");
      t.assertions.assert(result.echoed === "0,255,1,34", "WSS binary was not echoed");
      const endpoint = new URL("/api/demo/echo", page.url());
      const lease = (await owner.cookies(endpoint.href)).find(cookie => cookie.name === "__Host-genehub-preview");
      if (!lease) throw new Error("service view is missing its host-only cookie");
      const certificate = await readFile(cert);
      const foreign = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpsRequest({
          host: "127.0.0.1", port: endpoint.port, servername: endpoint.hostname, ca: certificate,
          path: endpoint.pathname, method: "POST", headers: {
            Host: endpoint.host, Origin: new URL(ownPage.url()).origin, "Sec-Fetch-Site": "same-site",
            Cookie: `${lease.name}=${lease.value}`,
          },
        }, response => { response.resume(); resolve(response.statusCode); });
        request.on("error", reject);
        request.end();
      });
      t.assertions.assert(foreign === 403, "another preview origin was able to invoke the runner");
      const staticStatus = await ownPage.evaluate(async () => (await fetch("/api/demo/echo", { method: "POST" })).status);
      t.assertions.assert(staticStatus === 405, "opening a static preview also granted service access");
      await menu.click();
      const reviewPopup = creator.waitForEvent("popup");
      await creator.getByRole("link", { name: "打开批注和运行日志" }).click();
      const review = await reviewPopup;
      const reviewFrame = review.frameLocator('iframe[title="独立 HTML 预览"]');
      await reviewFrame.getByText("Shared resource loaded").waitFor();
      await review.getByRole("link", { name: "启用本地服务", exact: true }).click();
      await review.getByRole("button", { name: "启用服务并打开预览" }).click();
      const loadedInReview = reviewFrame.getByText("Shared resource loaded");
      await loadedInReview.waitFor();
      const combined = await loadedInReview.evaluate(async () => {
        const response = await fetch("/api/demo/status");
        return crossOriginIsolated && response.ok && (await response.json()).ready === true;
      });
      t.assertions.assert(combined, "review mode cannot access the confirmed service");
      t.assertions.assert((await previewThreads(daemonPid)).join() === executingThreads.join(),
        "two viewers of the same run did not share its preview worker");
      await review.close();
      service?.kill();
      await t.tools.waitUntil(async () => (await page.evaluate(async () => (await fetch("/api/demo/stream")).status)) === 502, 5_000);
      await page.close();
    }
    if (withMedia) {
      await menu.click();
      const popup = creator.waitForEvent("popup");
      await creator.getByRole("link", { name: "打开批注和运行日志" }).click();
      const review = await popup;
      const content = review.frameLocator('iframe[title="独立 HTML 预览"]');
      await content.getByText("Shared resource loaded").waitFor();
      await review.getByRole("link", { name: "启用本地服务", exact: true }).click();
      await review.getByRole("button", { name: "启用服务并打开预览" }).click();
      const loaded = content.getByText("Shared resource loaded");
      await loaded.waitFor();
      const panel = review.getByRole("region", { name: "服务音视频" });
      await panel.getByLabel("仅直连").check();
      await panel.getByRole("button", { name: "连接音视频" }).click();
      const element = panel.locator("video");
      await t.tools.waitUntil(() => element.evaluate((node: HTMLVideoElement) => {
        const stream = node.srcObject;
        return stream instanceof MediaStream && stream.getAudioTracks().some(track => track.readyState === "live")
          && node.videoWidth > 0 && node.readyState >= node.HAVE_CURRENT_DATA;
      }), 25_000);
      const paths = await loaded.evaluate(async () => {
        const ordinary = await fetch("/api/demo/health");
        const offer = await fetch("/api/media/offer", { method: "POST" });
        const stop = await fetch("/api/media/stop", { method: "POST" });
        return [ordinary.status, offer.status, stop.status];
      });
      t.assertions.assert(paths.join() === "200,403,403", "media signalling escaped the trusted panel or ordinary APIs were lost");
      const active = await (await fetch(mediaHealth!)).json();
      t.assertions.assert(active.sessions === 1, "source did not have exactly one live session");
      await panel.getByRole("button", { name: "停止", exact: true }).click();
      await t.tools.waitUntil(async () => (await (await fetch(mediaHealth!)).json()).sessions === 0, 5000);
      t.assertions.assert(await element.evaluate((node: HTMLVideoElement) => node.srcObject === null), "stopped media remained attached");
      await review.close();
    }
    if (withReview) {
      await menu.click();
      const popup = creator.waitForEvent("popup");
      await creator.getByRole("link", { name: "打开批注和运行日志" }).click();
      const review = await popup;
      const frame = review.frameLocator('iframe[title="独立 HTML 预览"]');
      const loaded = frame.getByText("Shared resource loaded");
      await loaded.waitFor();
      t.assertions.assert(await review.evaluate(() => crossOriginIsolated), "trusted host lost isolation");
      t.assertions.assert(await loaded.evaluate(() => {
        try { void parent.document; return false; } catch {
          return crossOriginIsolated && typeof SharedArrayBuffer === "function" && parent !== window;
        }
      }), "content lost isolation or can read its parent");
      await review.close();
    }
    const anonymous = await visitor.newPage();
    const plain = new URL(`${origin}/assets/independent-preview/v2/${locator}`);
    const launch = await anonymous.goto(plain.href);
    const contentPolicy = launch?.headers()["content-security-policy"];
    t.assertions.assert(contentPolicy?.includes(`form-action https://*.${suffix}:${edgePort}`),
      "the trusted launcher did not restrict token delivery to the preview domain");
    await anonymous.getByRole("alert").getByText("请使用已经获准连接目标设备的浏览器打开").waitFor();
    await menu.click();
    await creator.getByRole("button", { name: "创建限时分享" }).click();
    const reviewOption = creator.getByLabel("打开批注和运行日志", { exact: true });
    if (await reviewOption.isVisible()) await reviewOption.uncheck();
    await creator.getByLabel("分享授权时间").selectOption("3600");
    await creator.getByRole("button", { name: "生成链接" }).click();
    const shareLink = creator.getByRole("textbox", { name: "预览分享链接" });
    await shareLink.waitFor();
    await anonymous.goto(await shareLink.inputValue()).catch(() => {
      throw new Error("could not navigate to the scoped share");
    });
    await anonymous.getByText("Shared resource loaded").waitFor();
    const denied = await anonymous.evaluate(async () => (await fetch("./private.txt")).status);
    t.assertions.assert(denied === 403, "shared viewer obtained a sibling outside the manifest");
    const sharedService = await anonymous.evaluate(async () => (await fetch("/api/demo/echo", { method: "POST" })).status);
    t.assertions.assert(sharedService === 405, "a scoped file share granted service access");
    t.assertions.assert((await visitor.cookies(origin)).length === 0, "a share required an account cookie");
    const copied = await (await browser.newContext()).newPage();
    const copiedResponse = await copied.goto(anonymous.url());
    t.assertions.assert(copiedResponse?.status() === 403, "opening the resource URL without the view cookie gave access");
    if (withReview) {
      await creator.getByLabel("打开批注和运行日志", { exact: true }).check();
      const review = await visitor.newPage();
      await review.addInitScript(() => {
        Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: undefined });
      });
      await review.goto(await shareLink.inputValue());
      const subdomain = review.frameLocator('iframe[title="独立 HTML 预览"]');
      await subdomain.getByText("Shared resource loaded").waitFor();
      const privateStatus = await subdomain.locator("body").evaluate(async () => (await fetch("/private.txt")).status);
      t.assertions.assert(privateStatus === 403, "review changed the share's allowed files");
      await review.getByRole("button", { name: "反馈", exact: true }).click();
      await review.getByRole("button", { name: "点选批注", exact: true }).click();
      await subdomain.locator("#data").click();
      await review.getByRole("textbox", { name: "批注", exact: true }).fill("Independent visitor annotation");
      await review.getByRole("button", { name: "添加批注", exact: true }).click();
      await review.getByRole("button", { name: "完成批注", exact: true }).click();
      await review.getByLabel("采集", { exact: true }).click();
      await review.getByRole("button", { name: "截图", exact: true }).click();
      await review.getByText(/已截取 Preview 画面 .* 和 DOM 状态/).waitFor();
      await review.getByRole("button", { name: "保存运行产物", exact: true }).click();
      await review.getByText("已保存到文件反馈草稿，请在反馈中选择并提交").waitFor();
      await review.keyboard.press("Escape");
      await review.getByRole("button", { name: "反馈", exact: true }).click();
      await review.getByRole("button", { name: "写反馈", exact: true }).click();
      await review.getByRole("textbox", { name: "反馈说明" }).fill("Private origin feedback");
      await review.getByRole("button", { name: "提交反馈", exact: true }).click();
      const receipt = review.getByRole("textbox", { name: "可复制的预览反馈", exact: true });
      await receipt.waitFor();
      const id = (await receipt.inputValue()).match(/pf_[a-f0-9]{32}/)?.[0];
      if (!id) throw new Error("review did not return a feedback receipt");
      const stored = await opened.client.call({ type: "preview.feedback", payload: { workspaceId: opened.workspaceId, operation: { kind: "read", id } } });
      if (stored?.type !== "previewFeedback" || stored.data.kind !== "receipt") throw new Error("owner cannot retrieve the review");
      const { annotations, bundles } = stored.data.data;
      t.assertions.assert(annotations[0]?.comment === "Independent visitor annotation" && bundles.length === 1, "review did not persist annotations and evidence");
      const log = await readFile(path.join(bundles[0]!.workspacePath, "events.jsonl"), "utf8");
      const dom = await readFile(path.join(bundles[0]!.workspacePath, "dom.jsonl"), "utf8");
      t.assertions.assert(log.includes("preview started before load") && dom.includes("Shared resource loaded"), "source startup or DOM evidence was lost");
      t.assertions.assert(bundles[0]!.files.some(file => file.name.endsWith(".webp")), "screenshot was not retained with feedback");
      const authorReview = await owner.newPage();
      await authorReview.goto(legacy);
      await authorReview.getByRole("button", { name: "反馈", exact: true }).click();
      await authorReview.getByText("收到的反馈", { exact: true }).click();
      await authorReview.getByRole("button", { name: /Private origin feedback/ }).click();
      const authorReceipt = await authorReview.getByRole("textbox", { name: "收到的反馈内容" }).inputValue();
      t.assertions.assert(authorReceipt.includes(id) && authorReceipt.includes("Independent visitor annotation"),
        "the author could not read the same visitor receipt from the product UI");
      await authorReview.close();
      await review.close();
    }
    await creator.getByRole("button", { name: "撤销分享" }).click();
    await creator.getByText("分享已撤销").waitFor();
    const afterRevoke = await anonymous.evaluate(async () => {
      try { return (await fetch("./data.json")).ok; } catch { return false; }
    });
    t.assertions.assert(!afterRevoke, "a revoked view continued to read");
    if (withReview) {
      await creator.getByLabel("仅观看", { exact: true }).check();
      await creator.getByRole("button", { name: "生成链接", exact: true }).click();
      await shareLink.waitFor();
      const viewer = await visitor.newPage();
      await viewer.goto(await shareLink.inputValue());
      await viewer.frameLocator('iframe[title="独立 HTML 预览"]').getByText("Shared resource loaded").waitFor();
      await viewer.getByRole("button", { name: "日志", exact: true }).click();
      await viewer.getByRole("searchbox", { name: "搜索运行日志" }).waitFor();
      t.assertions.assert(await viewer.getByRole("button", { name: "点选批注" }).count() === 0
        && await viewer.getByLabel("采集", { exact: true }).count() === 0, "the viewing-only share displayed write tools");
      await creator.getByRole("button", { name: "撤销分享" }).click();
      await viewer.close();
    }
    await old.getByText("Shared resource loaded").waitFor();
    const ordinary = await owner.newPage();
    await ordinary.goto(plain.href);
    await ordinary.getByText("Shared resource loaded").waitFor();
    if (mode === undefined) {
      t.assertions.assert(new URL(ordinary.url()).host !== new URL(ownPage.url()).host, "two views reused an origin");
      t.assertions.assert(await ownPage.evaluate(async () => (await fetch("./data.json")).ok), "opening another view interrupted the first");
      t.assertions.assert((await previewThreads(daemonPid)).join() === resident.join(), "separate views did not share the resident WASM thread");

      await relay.stop();
      relay = await startRelay({ openRoot: t.openRoot, port: relayPort, control: { origin: hub.origin, token: relayToken } });
      await waitForPreviewPresence(t, databasePath, device, initialPresence);
      t.assertions.assert((await previewThreads(daemonPid)).join() === resident.join(), "relay reconnect replaced the source thread");
      await creator.reload();
      await old.getByText("Shared resource loaded").waitFor();
      const recovered = await owner.newPage();
      await recovered.goto(plain.href);
      await recovered.getByText("Shared resource loaded").waitFor();
    }
  } finally {
    if (service && service.exitCode === null && service.signalCode === null) {
      const done = once(service, "exit");
      service.kill();
      await done;
    }
    await browser?.close();
    if (opened) {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
    if (edge && edge.exitCode === null && edge.signalCode === null) {
      const done = once(edge, "exit");
      edge.kill();
      await done;
    }
    if (front) await new Promise<void>(resolve => front!.close(() => resolve()));
    await relay?.stop();
    await hub.stop();
  }
  if (mode === undefined) {
    await t.tools.waitUntil(async () => (await previewWorkerPids(cert)).length === 0, 5_000);
  }
}

// A browser is the external engine peer. It uses the shipped signal server,
// collects the real Epic player's input bytes and renders a moving canvas.
async function startEnginePeer(page: Page, port: number) {
  await page.evaluate(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const peers = new Map<string, RTCPeerConnection>();
    const pending = new Map<string, RTCIceCandidateInit[]>();
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const graphics = canvas.getContext("2d")!;
    let frame = 0;
    setInterval(() => {
      graphics.fillStyle = frame++ % 2 ? "#1d9c36" : "#714ddd";
      graphics.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    const video = canvas.captureStream(10);
    let keyDowns = 0;
    let opened = 0;
    let closed = 0;
    let queue = Promise.resolve();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const id: string = message.playerId;
      queue = queue.then(async () => {
        switch (message.type) {
          case "identify":
            ws.send(JSON.stringify({ type: "endpointId", id: "Preview test engine" }));
            document.body.dataset.registered = "true";
            break;
          case "playerConnected": {
            if (!message.sendOffer) throw new Error("player did not request an offer");
            const peer = new RTCPeerConnection({ iceServers: [] });
            peers.set(id, peer);
            peer.addTrack(video.getVideoTracks()[0]!, video);
            const channel = peer.createDataChannel("datachannel");
            channel.binaryType = "arraybuffer";
            channel.onopen = () => { document.body.dataset.opened = String(++opened); };
            channel.onmessage = event => {
              const bytes = new Uint8Array(event.data);
              if (bytes[0] === 60 && bytes[1] === 87) document.body.dataset.keys = String(++keyDowns);
            };
            peer.onicecandidate = ({ candidate }) => {
              if (candidate && peers.has(id)) ws.send(JSON.stringify({ type: "iceCandidate", playerId: id, candidate }));
            };
            await peer.setLocalDescription(await peer.createOffer());
            ws.send(JSON.stringify({ type: "offer", playerId: id, sdp: peer.localDescription!.sdp }));
            break;
          }
          case "answer": {
            const peer = peers.get(id);
            if (!peer) break;
            await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
            for (const candidate of pending.get(id) ?? []) await peer.addIceCandidate(candidate);
            pending.delete(id);
            break;
          }
          case "iceCandidate": {
            const peer = peers.get(id);
            if (!peer) break;
            if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
            else pending.set(id, [...(pending.get(id) ?? []), message.candidate]);
            break;
          }
          case "playerDisconnected":
            if (peers.get(id)) {
              peers.get(id)!.close();
              peers.delete(id);
              pending.delete(id);
              document.body.dataset.closed = String(++closed);
            }
            break;
        }
      }).catch(error => { document.body.dataset.error = String(error); });
    };
  }, port);
  await page.locator('body[data-registered="true"]').waitFor();
}

async function exerciseEngineInput(t: CaseContext, video: ReturnType<Page["locator"]>, streamer: Page, expected: number) {
  await t.tools.waitUntil(async () => {
    const problem = await streamer.locator("body").getAttribute("data-error");
    if (problem) throw new Error(problem);
    if (!await video.count()) return false;
    return await video.evaluate((node: HTMLVideoElement) =>
      node.videoWidth === 160 && node.currentTime > 0 && node.readyState >= node.HAVE_CURRENT_DATA);
  }, 25_000);
  await streamer.locator(`body[data-opened="${expected}"]`).waitFor({ state: "attached", timeout: 10_000 });
  await video.click();
  await video.press("w");
  await streamer.locator(`body[data-keys="${expected}"]`).waitFor({ state: "attached", timeout: 10_000 });
  // The browser sends clicks to the game while it has captured the mouse.
  await video.evaluate(node => node.ownerDocument.exitPointerLock());
  await t.tools.waitUntil(() => video.evaluate(node => node.ownerDocument.pointerLockElement === null), 5_000);
}

async function waitForPreviewPresence(t: CaseContext, databasePath: string, device: string, previous?: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const query = db.prepare(`SELECT e.connected_at AS connectedAt FROM preview_relay_nodes n
      JOIN machines m ON m.id = n.machine_id JOIN fabric_endpoints e ON e.handle = n.endpoint_handle
      WHERE m.daemon_id = ? AND e.presence_expires_at > ?`);
    let presence = "";
    await t.tools.waitUntil(() => {
      const value = query.get(device, new Date().toISOString())?.connectedAt;
      if (typeof value !== "string" || value === previous) return false;
      presence = value;
      return true;
    }, 20_000);
    return presence;
  } finally {
    db.close();
  }
}

async function previewThreads(pid: number): Promise<string[]> {
  if (process.platform !== "linux") return [];
  const directory = `/proc/${pid}/task`;
  const tasks = await readdir(directory);
  const threads = await Promise.all(tasks.map(async tid => {
    const name = await readFile(path.join(directory, tid, "comm"), "utf8").catch(() => "");
    return name.startsWith("genehub-wasm-wo") ? tid : null;
  }));
  return threads.filter(tid => tid !== null).sort();
}

async function previewWorkerPids(cert: string): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command",
      "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine) -Compress"]);
    const processes = JSON.parse(stdout) as { ProcessId: number; CommandLine?: string }[];
    return processes.filter(item => item.CommandLine?.includes("static-preview-worker")
      && item.CommandLine.includes(cert)).map(item => item.ProcessId);
  }
  const { stdout } = await run("ps", ["-axww", "-o", "pid=,args="]);
  return stdout.split("\n").filter(line => line.includes("static-preview-worker") && line.includes(cert))
    .map(line => Number(line.trim().split(/\s+/, 1)[0]));
}

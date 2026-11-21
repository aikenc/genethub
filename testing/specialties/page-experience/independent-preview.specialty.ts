import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

import { allocatePort, defineSpecialty, startHub, startRelay } from "../../framework/public.ts";

const run = promisify(execFile);
const suffix = "preview.test";

defineSpecialty({
  id: "specialty.page-experience.independent-preview",
  title: "The two external preview choices keep their original authorization",
  oracle: "The old preview works. A paired account opens a separate TLS origin without making a share. An anonymous browser can open a scoped share until it is revoked.",
  catches: ["legacy preview replaced", "share inherits account authority", "copying the resource URL gives access", "TLS terminates before the source"],
  tags: ["page-experience", "authorization", "preview-feedback"],
  runner: "playwright", requiredRepos: ["cloud"], llm: { default: "mock" },
  expectedDurationMs: 70_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 3072, io: 1, browser: 1, pool: "browser" },
  surfaces: ["cloud-console", "cloud-server", "relay", "daemon", "asset-preview"],
  productInterfaces: ["@genehub/workbench", "hub-http", "preview.feedback", "asset.preview"],
}, async t => {
  const [edgePort, publicPort, relayPort] = await Promise.all([allocatePort(), allocatePort(), allocatePort()]);
  const origin = `https://workbench.${suffix}:${publicPort}`;
  const token = randomBytes(32).toString("base64url");
  const relayToken = randomBytes(32).toString("base64url");
  const cloudRoot = process.env.TESTCTL_CLOUD_ROOT!;
  const consoleRoot = path.join(cloudRoot, "console");
  const consoleDir = path.join(t.env.root, "console");
  const cert = path.join(t.env.root, "preview-cert.pem");
  const key = path.join(t.env.root, "preview-key.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=*.${suffix}`, "-addext", `subjectAltName=DNS:*.${suffix}`, "-keyout", key, "-out", cert]);
  const { stdout: publicKey } = await run("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]);
  const publicDer = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  const pin = createHash("sha256").update(publicDer).digest("base64");
  await run(process.execPath, [
    path.join(consoleRoot, "node_modules/vite/bin/vite.js"), "build", "--base", "/", "--outDir", consoleDir,
  ], { cwd: consoleRoot, env: { ...process.env, VITE_GENEHUB_SUBPATH: "" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  process.env.HUB_PUBLIC_ORIGIN = origin;
  process.env.HUB_PREVIEW_EDGE_TOKEN = token;
  process.env.HUB_PREVIEW_PUBLIC_PORT = String(edgePort);
  const hub = await startHub({ databasePath: path.join(t.env.root, "hub.sqlite"),
    relayOrigin: `http://127.0.0.1:${relayPort}`, relayToken, consoleDir });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let opened: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let edge: ChildProcess | undefined;
  let front: ReturnType<typeof createServer> | undefined;
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
      <p id="data">loading</p><script>fetch('./data.json').then(r=>r.json()).then(x=>document.querySelector('#data').textContent=x.message)</script>`);
    await writeFile(path.join(t.env.workspace, "data.json"), '{"message":"Shared resource loaded"}');
    await writeFile(path.join(t.env.workspace, "private.txt"), "outside share");
    opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env, launchEnv: {
      GENEHUB_PREVIEW_ENABLED: "1", GENEHUB_PREVIEW_TLS_CERT: cert, GENEHUB_PREVIEW_TLS_KEY: key,
    } });
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
    browser = await chromium.launch({ args: [
      "--no-proxy-server", `--host-resolver-rules=MAP *.${suffix} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${pin}`,
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
    const menu = creator.getByText("独立预览", { exact: true });
    await menu.click();
    const ownPopup = creator.waitForEvent("popup");
    await creator.getByRole("link", { name: "用已有权限打开" }).click();
    const ownPage = await ownPopup;
    await ownPage.getByText("Shared resource loaded").waitFor();
    if (!await ownPage.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === "function" && window.opener === null)) {
      throw new Error("external preview origin or opener isolation failed");
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
    t.assertions.assert((await visitor.cookies(origin)).length === 0, "a share required an account cookie");
    const copied = await (await browser.newContext()).newPage();
    const copiedResponse = await copied.goto(anonymous.url());
    t.assertions.assert(copiedResponse?.status() === 403, "opening the resource URL without the view cookie gave access");
    await creator.getByRole("button", { name: "撤销分享" }).click();
    await creator.getByText("分享已撤销").waitFor();
    const afterRevoke = await anonymous.evaluate(async () => {
      try { return (await fetch("./data.json")).ok; } catch { return false; }
    });
    t.assertions.assert(!afterRevoke, "a revoked view continued to read");
    await old.getByText("Shared resource loaded").waitFor();
    const ordinary = await owner.newPage();
    await ordinary.goto(plain.href);
    await ordinary.getByText("Shared resource loaded").waitFor();
  } finally {
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
});

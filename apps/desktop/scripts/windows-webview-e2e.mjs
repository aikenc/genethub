#!/usr/bin/env node
// Launch the real Windows Tauri/WebView2 executable with the website offline
// and assert the bundled boot page stays. On a local build it then launches
// once more against the loopback website; stamped release builds carry their
// channel's real WEB_APP_URL, so that leg is local-only. CDP is enabled only
// for this external test process and is not a product capability.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("the WebView2 E2E runs only on Windows");

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const identity = readChannelIdentity();
const executable = join(repo, "apps/desktop/src-tauri/target/release", `${identity.desktopBinary}.exe`);
if (!existsSync(executable)) throw new Error(`Desktop executable does not exist: ${executable}`);

const isolated = mkdtempSync(join(tmpdir(), "genehub-webview-e2e-"));
let child;
let website;

try {
  await assertPortAvailable(5173);

  let cdpPort = await availablePort();
  child = launch(cdpPort);
  const boot = await inspectPage(
    cdpPort,
    (target) => target.url.startsWith("http://tauri.localhost") || target.url.startsWith("tauri://"),
  );
  assert(
    !boot.url.startsWith("http://127.0.0.1:5173") && !boot.url.startsWith("chrome-error://"),
    `offline launch left the bundled boot page: ${boot.url}`,
  );
  const bootState = await evaluateUntil(
    boot,
    `({
      status: document.getElementById("status")?.textContent ?? "",
      hasGlobalTauri: Boolean(globalThis.__TAURI__)
    })`,
    (state) => state.status !== "",
  );
  assert(/官网暂时无法访问|启动/.test(bootState.status), `boot status is visible: ${bootState.status}`);
  assert(bootState.hasGlobalTauri === false, "the boot surface has no globally exposed Tauri API");
  stopTree(child);
  child = undefined;

  // The loopback remote leg only exists on a local build: a stamped release
  // build carries its channel's real WEB_APP_URL as a constant, so the shell
  // navigates to the live hub and no environment override can point it at
  // 127.0.0.1. Privilege isolation of remote origins is asserted there.
  if (identity.channel === "local") {
    website = createServer((request, response) => {
      if (request.url !== "/app") {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Remote GeneHub E2E</title><main id="remote">remote</main>`);
    });
    await listen(website, 5173);

    cdpPort = await availablePort();
    child = launch(cdpPort);
    const remote = await inspectPage(cdpPort, (target) => target.url === "http://127.0.0.1:5173/app");
    const remoteState = await evaluateUntil(
      remote,
      `({
        url: location.href,
        marker: document.getElementById("remote")?.textContent ?? "",
        hasGlobalTauri: Boolean(globalThis.__TAURI__)
      })`,
      (state) => state.marker !== "",
    );
    assert(remoteState.url === "http://127.0.0.1:5173/app", `remote URL loaded: ${remoteState.url}`);
    assert(remoteState.marker === "remote", "the real remote document rendered in WebView2");
    assert(remoteState.hasGlobalTauri === false, "the remote origin has no globally exposed Tauri API");
    process.stdout.write("Windows WebView2 kept the offline boot page and loaded the unprivileged remote site\n");
  } else {
    process.stdout.write(
      `Windows WebView2 kept the offline boot page (channel ${identity.channel}: remote leg is local-only)\n`,
    );
  }
} finally {
  if (child) stopTree(child);
  if (website) await new Promise((resolveClose) => website.close(resolveClose));
  rmSync(isolated, { recursive: true, force: true });
}

function readChannelIdentity() {
  const env = readFileSync(join(repo, "scripts/channel.env"), "utf8");
  const entries = new Map(
    env.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/^([A-Z_]+)="?(.*?)"?$/u);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
  const desktopBinary = entries.get("DESKTOP_BINARY");
  if (!desktopBinary) throw new Error("scripts/channel.env has no DESKTOP_BINARY");
  return { desktopBinary, channel: entries.get("CHANNEL") ?? "local" };
}

function launch(cdpPort) {
  return spawn(executable, [], {
    cwd: repo,
    env: {
      ...process.env,
      APPDATA: join(isolated, "appdata"),
      LOCALAPPDATA: join(isolated, "localappdata"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
}

function stopTree(processHandle) {
  if (processHandle.exitCode !== null) return;
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(processHandle.pid)], { stdio: "ignore" });
  } catch {
    // The app may have finished between exitCode observation and taskkill.
  }
}

async function inspectPage(port, predicate) {
  const deadline = Date.now() + 45_000;
  let last = "CDP did not answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1_000) });
      const targets = await response.json();
      const match = targets.find((target) => target.type === "page" && predicate(target));
      if (match) return match;
      last = `targets: ${targets.map((target) => target.url).join(", ")}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for WebView2 page (${last})`);
}

// A CDP target is listed as soon as navigation starts, before the document
// has parsed far enough to hold the element the assertion reads. Poll the
// expression until the page has rendered (10s ceiling), then return the last
// value so the caller's assertion still decides pass/fail.
async function evaluateUntil(target, expression, accept, { attempts = 40, intervalMs = 250 } = {}) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt++) {
    value = await evaluate(target, expression);
    if (accept(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return value;
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  const id = 1;
  const result = await new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => rejectMessage(new Error("CDP Runtime.evaluate timed out")), 5_000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) rejectMessage(new Error(JSON.stringify(message.error)));
      else resolveMessage(message.result.result.value);
    });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  socket.close();
  return result;
}

async function availablePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("could not allocate a CDP port");
  return port;
}

async function assertPortAvailable(port) {
  const server = createTcpServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function listen(server, port) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

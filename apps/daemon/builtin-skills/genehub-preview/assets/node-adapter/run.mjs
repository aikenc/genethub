#!/usr/bin/env node
/** Local, authenticated run adapter. One socket carries one HTTP or WS operation.
 * The daemon verifies possession of the run secret before sending application data.
 * Backend commands are owned by this process; any exit retires the whole run. */
import { createServer, request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  link,
  unlink,
  lstat,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const MAX_PACKET = 256 * 1024;
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--config") || !args.includes("--daemon-root")) {
  throw new Error(
    "Usage: node run.mjs --config <application.json> --daemon-root <daemon data directory>",
  );
}
const configPath = await realpath(flag("--config"));
const spec = JSON.parse(await readFile(configPath, "utf8"));
const entry = await realpath(resolve(dirname(configPath), spec.entry));
if (!["auto", "direct-only"].includes(spec.dataPolicy ?? "auto"))
  throw new Error("invalid dataPolicy");
if (!/\.html?$/i.test(entry)) throw new Error("entry must be an HTML file");
if (
  !Array.isArray(spec.backends) ||
  spec.backends.length < 1 ||
  spec.backends.length > 8
)
  throw new Error("1–8 backends required");
const registry = join(
  await realpath(flag("--daemon-root")),
  "service-previews",
);
await mkdir(registry, { recursive: true, mode: 0o700 });
if ((await lstat(registry)).isSymbolicLink())
  throw new Error("registry cannot be a symlink");
const key = createHash("sha256")
  .update(process.platform === "win32" ? entry.replaceAll("\\", "/") : entry)
  .digest("hex");
const recordPath = join(registry, `${key}.json`);
// Do not replace a running registration. Stale records can be explicitly removed by the owner.
try {
  await lstat(recordPath);
  throw new Error(
    "entry already registered; stop its runner or remove the stale record explicitly",
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const secret = randomBytes(32).toString("hex");
const runId = randomBytes(16).toString("hex");
const mac = (value) => createHmac("sha256", secret).update(value).digest("hex");
const peers = new Set();
const children = [];
const routes = [];
let stopping = false;
let registered = false;
const server = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PACKET,
  perMessageDeflate: false,
});
const fail = (error) => {
  console.error(
    "Service Preview stopped:",
    error instanceof Error ? error.message : "a backend exited",
  );
  void stop(1);
};
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const peer of peers) peer.terminate();
  for (const child of children) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else if (child.exitCode === null && child.signalCode === null)
        spawnSync(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", timeout: 5000 },
        );
    } catch {}
  }
  if (registered) {
    try {
      if (JSON.parse(await readFile(recordPath, "utf8")).runId === runId)
        await unlink(recordPath);
    } catch {}
  }
  wss.close();
  server.close();
  const timer = setTimeout(() => {
    for (const child of children) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }
    process.exit(code);
  }, 1500);
  timer.unref();
  process.exitCode = code;
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function localBase(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("backend must be an http://127.0.0.1:port origin");
  return url;
}
for (const backend of spec.backends) {
  const base = localBase(backend.origin);
  if (
    !Array.isArray(backend.command) ||
    !backend.command.length ||
    !backend.command.every((x) => typeof x === "string")
  )
    throw new Error("backend command must be argv");
  if (!Array.isArray(backend.routes))
    throw new Error("backend routes required");
  for (const route of backend.routes) {
    if (
      !/^\/api\/[a-z0-9/-]+\/$/.test(route.prefix) ||
      routes.some((x) => x.prefix === route.prefix)
    )
      throw new Error("unique /api/.../ prefixes ending in / required");
    routes.push({
      prefix: route.prefix,
      base: base.href,
      websocket: route.websocket === true,
    });
  }
  // Refuse a previously occupied origin before launching. Application processes
  // are trusted to obey this manifest; this is not an OS sandbox for backend code.
  await new Promise((resolve_, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(Number(base.port || 80), "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve_())),
    );
  });
  // The application must stay in the foreground and bind only its configured loopback port.
  const child = spawn(backend.command[0], backend.command.slice(1), {
    cwd: resolve(dirname(configPath), backend.cwd ?? "."),
    env: { ...process.env, ...backend.env },
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.once("error", fail);
  child.once("exit", fail);
}
// Readiness is separate from process existence. Never follow an upstream redirect.
for (const backend of spec.backends) {
  const health = new URL(backend.health ?? "/", localBase(backend.origin));
  if (health.origin !== new URL(backend.origin).origin)
    throw new Error("health must remain on backend origin");
  const deadline = Date.now() + Math.min(spec.readyTimeoutMs ?? 120000, 300000);
  while (!stopping) {
    try {
      const r = await fetch(health, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      await r.body?.cancel();
      if (r.ok) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error("backend readiness timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (stopping) process.exit(1);

function packet(value) {
  return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value))]);
}
function send(ws, bytes) {
  if (bytes.length > MAX_PACKET || ws.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error("bridge closed or packet exceeds limit"));
  return new Promise((yes, no) =>
    ws.send(bytes, { binary: true }, (e) => (e ? no(e) : yes())),
  );
}
function safePath(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > 4096 ||
    !raw.startsWith("/api/") ||
    /[\\\r\n#]/.test(raw)
  )
    throw new Error("invalid service path");
  const path = raw.split("?")[0];
  if (
    /%(?:2f|5c|2e|00)/i.test(path) ||
    path.split("/").some((x) => x === ".." || x === ".")
  )
    throw new Error("invalid path encoding");
  const route = routes
    .filter((r) => path.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!route) throw new Error("route not registered");
  const url = new URL("/" + raw.slice(route.prefix.length), route.base);
  if (url.origin !== new URL(route.base).origin)
    throw new Error("route escaped origin");
  return { route, url };
}
const allowedHeaders = new Set([
  "accept",
  "content-type",
  "range",
  "if-none-match",
  "last-event-id",
]);
const responseHeaders = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
]);
wss.on("connection", (socket, request) => {
  if (request.headers.origin || request.url !== "/") {
    socket.terminate();
    return;
  }
  if (peers.size >= 32) {
    socket.terminate();
    return;
  }
  peers.add(socket);
  let upstream = null,
    request_ = null,
    responded = false,
    bodyBytes = 0;
  let phase = "challenge",
    nonce = "",
    ack = null;
  let serial = Promise.resolve();
  let queued = 0;
  const deadline = setTimeout(() => socket.terminate(), 5000);
  const lifetime = setTimeout(() => socket.terminate(), 60 * 60 * 1000);
  const cleanup = () => {
    clearTimeout(deadline);
    clearTimeout(lifetime);
    peers.delete(socket);
    upstream?.terminate();
    request_?.destroy();
    ack?.reject(new Error("closed"));
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
  const deliver = async (bytes) => {
    if (ack) throw new Error("unconsumed bridge packet");
    const pending = new Promise((resolve_, reject) => {
      ack = { resolve: resolve_, reject };
    });
    const timer = setTimeout(() => socket.terminate(), 30000);
    try {
      await send(socket, bytes);
      await pending;
    } finally {
      clearTimeout(timer);
    }
  };
  socket.on("message", (data, binary) => {
    if (!binary || !data.length || data.length > MAX_PACKET) {
      socket.terminate();
      return;
    }
    // ACK is consumed outside the request serial queue to avoid blocking response progress.
    if (data.length === 1 && data[0] === 2) {
      const a = ack;
      ack = null;
      a?.resolve();
      return;
    }
    queued += data.length;
    if (queued > MAX_PACKET * 4) {
      socket.terminate();
      return;
    }
    socket.pause();
    serial = serial
      .then(async () => {
        if (data[0] !== 0 && data[0] !== 1) throw new Error("bad packet");
        const message =
          data[0] === 0 ? JSON.parse(data.subarray(1).toString()) : null;
        if (phase === "challenge") {
          if (!message || !/^[a-f0-9]{64}$/.test(message.nonce))
            throw new Error("invalid challenge");
          nonce = message.nonce;
          await send(
            socket,
            packet({ proof: mac("server:" + nonce + ":" + runId) }),
          );
          phase = "auth";
          return;
        }
        if (phase === "auth") {
          const proof = Buffer.from(message?.proof ?? "", "hex");
          const expected = Buffer.from(
            mac("client:" + nonce + ":" + runId),
            "hex",
          );
          if (
            proof.length !== expected.length ||
            !timingSafeEqual(proof, expected)
          )
            throw new Error("authentication failed");
          clearTimeout(deadline);
          phase = "open";
          await send(socket, packet({ kind: "ready" }));
          return;
        }
        if (phase === "open") {
          if (message?.kind === "shutdown") {
            await send(socket, packet({kind:"stopping"}));
            void stop();
            return;
          }
          const { route, url } = safePath(message?.path);
          if (message.kind === "ws") {
            if (!route.websocket) throw new Error("WS route not allowed");
            url.protocol = "ws:";
            upstream = new WebSocket(url, {
              maxPayload: MAX_PACKET - 1,
              perMessageDeflate: false,
              followRedirects: false,
            });
            upstream.once("error", () => socket.terminate());
            let inbound = Promise.resolve();
            let buffered = 0;
            upstream.once("open", () => {
              phase = "ws";
              inbound = inbound.then(() => deliver(packet({ kind: "open" })));
              inbound.catch(() => socket.terminate());
            });
            upstream.on("message", (bytes, isBinary) => {
              upstream.pause();
              buffered += bytes.length;
              if (buffered > MAX_PACKET * 4) {
                socket.terminate();
                return;
              }
              const b = isBinary
                ? Buffer.concat([Buffer.from([1]), bytes])
                : packet({ kind: "text", text: bytes.toString() });
              inbound = inbound
                .then(() => deliver(b))
                .then(() => {
                  buffered -= bytes.length;
                  upstream?.resume();
                })
                .catch(() => socket.terminate());
            });
            upstream.on("close", (code, reason) => {
              void inbound
                .then(() =>
                  deliver(
                    packet({
                      kind: "close",
                      code,
                      reason: reason.toString().slice(0, 120),
                    }),
                  ),
                )
                .finally(() => socket.close())
                .catch(() => {});
            });
            phase = "connecting";
            return;
          }
          if (
            message.kind !== "http" ||
            ![
              "GET",
              "HEAD",
              "POST",
              "PUT",
              "PATCH",
              "DELETE",
              "OPTIONS",
            ].includes(message.method)
          )
            throw new Error("invalid HTTP operation");
          const headers = {};
          for (const [k, v] of Object.entries(message.headers ?? {})) {
            if (
              !allowedHeaders.has(k.toLowerCase()) ||
              typeof v !== "string" ||
              v.length > 2048 ||
              /[\r\n]/.test(v)
            )
              throw new Error("header not allowed");
            headers[k.toLowerCase()] = v;
          }
          request_ = httpRequest(
            url,
            { method: message.method, headers },
            (response) => {
              responded = true;
              void (async () => {
                const filtered = {};
                for (const [k, v] of Object.entries(response.headers))
                  if (responseHeaders.has(k) && typeof v === "string")
                    filtered[k] = v;
                await deliver(
                  packet({
                    kind: "head",
                    status: response.statusCode,
                    headers: filtered,
                  }),
                );
                for await (const chunk of response) {
                  for (let i = 0; i < chunk.length; i += 32 * 1024)
                    await deliver(
                      Buffer.concat([
                        Buffer.from([1]),
                        chunk.subarray(i, i + 32 * 1024),
                      ]),
                    );
                }
                await deliver(packet({ kind: "end" }));
                socket.close();
              })().catch(() => socket.terminate());
            },
          );
          request_.setTimeout(120000, () => request_.destroy());
          request_.once("error", () => {
            void (async () => {
              if (!responded)
                await deliver(
                  packet({ kind: "head", status: 502, headers: {} }),
                );
              await deliver(packet({ kind: "end" }));
              socket.close();
            })().catch(() => socket.terminate());
          });
          phase = "http";
          return;
        }
        if (phase === "http") {
          if (data[0] === 1) {
            bodyBytes += data.length - 1;
            if (bodyBytes > 8 * 1024 * 1024)
              throw new Error("request too large");
            await new Promise((yes, no) =>
              request_.write(data.subarray(1), (e) => (e ? no(e) : yes())),
            );
          } else if (message.kind === "end") {
            request_.end();
            phase = "response";
          } else throw new Error("invalid HTTP packet");
        } else if (phase === "ws") {
          if (data[0] === 1 || message?.kind === "text")
            await new Promise((yes, no) =>
              upstream.send(
                data[0] === 1 ? data.subarray(1) : message.text,
                { binary: data[0] === 1 },
                (e) => (e ? no(e) : yes()),
              ),
            );
          else if (message?.kind === "close") upstream.close(1000);
          else throw new Error("invalid WS packet");
        } else throw new Error("invalid run state");
      })
      .catch(() => socket.terminate())
      .finally(() => {
        queued -= data.length;
        if (!queued) socket.resume();
      });
  });
});
await new Promise((yes, no) => {
  server.once("error", no);
  server.listen(0, "127.0.0.1", yes);
});
const media = spec.media ?? null;
if (media) {
  safePath(media.offerPath);
  if (media.stopPath) safePath(media.stopPath);
  if (!["webrtc", "none"].includes(media.microphone ?? "none"))
    throw new Error("microphone must be webrtc or none");
}
const record = {
  version: 1,
  pid: process.pid,
  control: true,
  entry,
  runId,
  secret,
  port: server.address().port,
  name: String(spec.name ?? "Service Preview").slice(0, 120),
  routes: routes.map(({ prefix, websocket }) => ({ prefix, websocket })),
  media,
  iceServers: spec.iceServers ?? [],
  dataPolicy: spec.dataPolicy ?? "auto",
};
await writeFile(recordPath + "." + runId, JSON.stringify(record), {
  mode: 0o600,
  flag: "wx",
});
try {
  await link(recordPath + "." + runId, recordPath);
  registered = true;
} finally {
  await unlink(recordPath + "." + runId);
}
console.log(
  `Service Preview ready: ${record.name}; open the registered entry HTML in GeneHub.`,
);

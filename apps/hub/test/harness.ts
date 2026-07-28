import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { startHub, type Hub } from "../src/main.js";
import type { Role } from "../src/shared/config.js";

export interface TestHub {
  hub: Hub;
  origin: string;
  wsOrigin: string;
  /** Cookie jar for one browser-ish caller. */
  session: string | null;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  stop(): Promise<void>;
}

export async function startTestHub(
  options: { roles?: Role[]; internalToken?: string } = {},
): Promise<TestHub> {
  const dir = mkdtempSync(path.join(tmpdir(), "genehub-hub-"));
  const hub = await startHub({
    roles: new Set(options.roles ?? ["control", "forward"]),
    port: 0,
    host: "127.0.0.1",
    databasePath: path.join(dir, "hub.sqlite"),
    ...(options.internalToken ? { internalToken: options.internalToken } : {}),
  });

  const origin = `http://127.0.0.1:${hub.port}`;
  const test: TestHub = {
    hub,
    origin,
    wsOrigin: `ws://127.0.0.1:${hub.port}`,
    session: null,
    async fetch(target, init = {}) {
      const headers = new Headers(init.headers);
      if (test.session) headers.set("cookie", test.session);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const response = await fetch(new URL(target, origin), { ...init, headers, redirect: "manual" });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) test.session = setCookie.split(";")[0]!;
      return response;
    },
    async json(target, init) {
      const response = await test.fetch(target, init);
      return (await response.json()) as never;
    },
    async stop() {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return test;
}

/** Signs in as a temporary user, the way a first-time visitor does. */
export async function signIn(hub: TestHub): Promise<{ userId: string }> {
  const body = await hub.json<{ user: { id: string } }>("/app/auth/temp", {
    method: "POST",
    body: JSON.stringify({ deviceName: "test" }),
  });
  return { userId: body.user.id };
}

export interface EnrolledMachine {
  machineId: string;
  daemonId: string;
  /** What the daemon puts in the uplink `Authorization` header. */
  uplinkTicket: string;
  uplinkUrl: string;
}

/**
 * Runs the whole pairing flow the way a real machine does: ask for a code, have
 * the signed-in browser approve it, poll, enroll.
 */
export async function enrollMachine(
  hub: TestHub,
  options: { name?: string; daemonId?: string } = {},
): Promise<EnrolledMachine> {
  const daemonId = options.daemonId ?? `dmn_${Math.random().toString(36).slice(2, 10)}`;
  const secret = `secret-${Math.random().toString(36).slice(2)}`;
  const { createHash } = await import("node:crypto");
  const verifier = createHash("sha256").update(secret).digest("base64url");

  const started = await hub.json<{ deviceCode: string; userCode: string }>(
    "/api/device-authorizations",
    { method: "POST", body: JSON.stringify({ displayName: options.name ?? "测试电脑" }) },
  );

  const approved = await hub.fetch(`/app/activations/${started.userCode}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve" }),
  });
  if (!approved.ok) throw new Error(`approval failed: ${approved.status}`);

  const polled = await hub.json<{ status: string; enrollmentToken?: string }>(
    "/api/device-authorizations/poll",
    { method: "POST", body: JSON.stringify({ deviceCode: started.deviceCode }) },
  );
  if (polled.status !== "approved" || !polled.enrollmentToken) {
    throw new Error(`unexpected poll status: ${polled.status}`);
  }

  const enrolled = await hub.json<{ machineId: string; uplinkUrl: string }>("/api/machines/enroll", {
    method: "POST",
    headers: { authorization: `Bearer ${polled.enrollmentToken}` },
    body: JSON.stringify({
      daemonId,
      publicKey: Buffer.from(`key-${daemonId}`).toString("base64"),
      credentialVerifier: verifier,
      platform: "linux",
    }),
  });

  return {
    machineId: enrolled.machineId,
    daemonId,
    uplinkTicket: `${daemonId}.${secret}`,
    uplinkUrl: enrolled.uplinkUrl,
  };
}

/**
 * Close codes seen so far. Recorded eagerly because a socket the server hangs
 * up on may well be closed before the test gets around to asking, and a helper
 * that misses that is a helper that produces flaky timeouts.
 */
const closeCodes = new WeakMap<WebSocket, number>();

/** Opens a socket and resolves once it is either open or refused. */
export function connect(
  url: string,
  init: { headers?: Record<string, string> } = {},
): Promise<{ socket: WebSocket } | { error: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, init);
    socket.on("close", (code) => closeCodes.set(socket, code));
    socket.once("open", () => resolve({ socket }));
    socket.once("unexpected-response", (_request, response) => {
      socket.terminate();
      resolve({ error: `${response.statusCode}` });
    });
    socket.once("error", (error) => resolve({ error: String(error) }));
  });
}

export function opened(result: { socket: WebSocket } | { error: string }): WebSocket {
  if ("error" in result) throw new Error(`expected the socket to open, got ${result.error}`);
  return result.socket;
}

/** Waits for one message, or throws so a hang shows up as a failure. */
export function nextMessage(socket: WebSocket, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
  });
}

export function closed(socket: WebSocket, timeoutMs = 3000): Promise<number> {
  const already = closeCodes.get(socket);
  if (already !== undefined) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a close")), timeoutMs);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

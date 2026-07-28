import { WebSocket } from "ws";

import type {
  ChannelAuthority,
  ClientGrant,
  DaemonGrant,
  PresenceState,
  Revocation,
} from "../src/contract/index.js";
import { startRelay, type Relay } from "../src/main.js";

/**
 * A control plane, as far as the relay is concerned.
 *
 * The real one is a separate service in a separate repository, which is the
 * point: if the relay's tests needed it, the two would be joined at the hip
 * again and "you can run your own relay" would be a claim nobody had checked.
 * Everything here is a ticket table and a log.
 */
export class FakeAuthority implements ChannelAuthority {
  readonly daemonTickets = new Map<string, DaemonGrant>();
  readonly clientTickets = new Map<string, ClientGrant>();
  readonly presence: Array<{ machineId: string; state: PresenceState }> = [];
  readonly calls: string[] = [];
  private revoke: ((revocation: Revocation) => void) | null = null;

  grantDaemon(ticket: string, grant: DaemonGrant): void {
    this.daemonTickets.set(ticket, grant);
  }

  /** Single use, mirroring the real ticket: redeeming removes it. */
  grantClient(ticket: string, grant: ClientGrant): void {
    this.clientTickets.set(ticket, grant);
  }

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    this.calls.push("authorizeDaemon");
    return this.daemonTickets.get(ticket) ?? null;
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    this.calls.push("authorizeClient");
    const grant = this.clientTickets.get(ticket);
    if (grant) this.clientTickets.delete(ticket);
    return grant ?? null;
  }

  async reportPresence(machineId: string, state: PresenceState): Promise<void> {
    this.calls.push("reportPresence");
    this.presence.push({ machineId, state });
  }

  onRevoked(handler: (revocation: Revocation) => void): void {
    this.revoke = handler;
  }

  /** Stands in for the control plane pushing a revocation. */
  revokeMachine(machineId: string, reason = "revoked by the owner"): void {
    this.revoke?.({ machineId, reason });
  }
}

export interface TestRelay {
  relay: Relay;
  authority: FakeAuthority;
  origin: string;
  wsOrigin: string;
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  stop(): Promise<void>;
}

export async function startTestRelay(
  authority: ChannelAuthority = new FakeAuthority(),
): Promise<TestRelay> {
  const relay = await startRelay({ port: 0, host: "127.0.0.1", authority });
  const origin = `http://127.0.0.1:${relay.port}`;
  return {
    relay,
    authority: authority as FakeAuthority,
    origin,
    wsOrigin: `ws://127.0.0.1:${relay.port}`,
    async json(target, init) {
      const response = await fetch(new URL(target, origin), init);
      return (await response.json()) as never;
    },
    async stop() {
      await relay.close();
    },
  };
}

/**
 * Close codes seen so far. Recorded eagerly because a socket the relay hangs up
 * on may well be closed before the test gets around to asking, and a helper
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

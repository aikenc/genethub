import { WebSocket } from "ws";

import type {
  FabricAuthority,
  FabricEndpointGrant,
  FabricPresenceState,
  FabricRevocation,
  FabricRouteGrant,
} from "../src/contract/fabric.js";
import { startRelay, type Relay } from "../src/main.js";

/** Endpoint-neutral Control stand-in used by Fabric integration tests. */
export class FakeFabricAuthority implements FabricAuthority {
  readonly endpointTickets = new Map<string, FabricEndpointGrant>();
  readonly routeTickets = new Map<string, FabricRouteGrant>();
  readonly presence: Array<{
    endpointHandle: string;
    connectionGeneration: number;
    state: FabricPresenceState;
  }> = [];
  readonly calls: string[] = [];
  private revokeHandler: ((revocation: FabricRevocation) => void) | null = null;
  private readonly endpointAuthorizationGates = new Map<
    string,
    { started: () => void; released: Promise<void> }
  >();

  holdEndpointAuthorization(credential: string): {
    started: Promise<void>;
    release(): void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.endpointAuthorizationGates.set(credential, {
      started: markStarted,
      released,
    });
    return { started, release };
  }

  grantEndpoint(
    credential: string,
    endpointHandle: string,
    options: {
      revocationHandle?: string;
      expiresAt?: string | null;
      connectionGeneration?: number;
      presenceLeaseSeconds?: number;
    } = {},
  ): void {
    this.endpointTickets.set(credential, {
      endpointHandle,
      revocationHandle: options.revocationHandle ?? `revoke:${endpointHandle}`,
      expiresAt: options.expiresAt ?? null,
      connectionGeneration: options.connectionGeneration ?? 1,
      presenceLeaseSeconds: options.presenceLeaseSeconds ?? 90,
    });
  }

  grantRoute(
    ticket: string,
    targetEndpointHandle: string,
    options: { routeHandle?: string; expiresAt?: string } = {},
  ): void {
    this.routeTickets.set(ticket, {
      targetEndpointHandle,
      routeHandle: options.routeHandle ?? `route:${ticket}`,
      expiresAt: options.expiresAt ?? "2099-01-01T00:00:00.000Z",
    });
  }

  async authorizeEndpoint(credential: string): Promise<FabricEndpointGrant | null> {
    this.calls.push("authorizeEndpoint");
    const grant = this.endpointTickets.get(credential) ?? null;
    this.endpointTickets.delete(credential);
    const gate = this.endpointAuthorizationGates.get(credential);
    if (gate) {
      gate.started();
      await gate.released;
      this.endpointAuthorizationGates.delete(credential);
    }
    return grant;
  }

  async authorizeRoute(
    sourceEndpointHandle: string,
    routeTicket: string,
  ): Promise<FabricRouteGrant | null> {
    this.calls.push(`authorizeRoute:${sourceEndpointHandle}`);
    const grant = this.routeTickets.get(routeTicket) ?? null;
    this.routeTickets.delete(routeTicket);
    return grant;
  }

  async reportEndpointPresence(
    endpointHandle: string,
    connectionGeneration: number,
    state: FabricPresenceState,
  ): Promise<void> {
    this.calls.push("reportEndpointPresence");
    this.presence.push({ endpointHandle, connectionGeneration, state });
  }

  onFabricRevoked(handler: (revocation: FabricRevocation) => void): void {
    this.revokeHandler = handler;
  }

  revoke(revocation: FabricRevocation): void {
    this.revokeHandler?.(revocation);
  }
}

export interface TestRelay {
  relay: Relay;
  fabricAuthority: FabricAuthority;
  origin: string;
  wsOrigin: string;
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  stop(): Promise<void>;
}

export async function startTestRelay(
  fabricAuthority: FabricAuthority = new FakeFabricAuthority(),
): Promise<TestRelay> {
  const relay = await startRelay({
    port: 0,
    host: "127.0.0.1",
    fabricAuthority,
  });
  const origin = `http://127.0.0.1:${relay.port}`;
  return {
    relay,
    fabricAuthority,
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

const closeCodes = new WeakMap<WebSocket, number>();

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
  if ("error" in result) {
    throw new Error(`expected the socket to open, got ${result.error}`);
  }
  return result.socket;
}

export function nextMessage(socket: WebSocket, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for a frame")),
      timeoutMs,
    );
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
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for a close")),
      timeoutMs,
    );
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

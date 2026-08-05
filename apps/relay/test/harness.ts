import { WebSocket } from "ws";

import type {
  ChannelAuthority,
  ClientGrant,
  DaemonGrant,
  PresenceState,
  Revocation,
} from "../src/contract/index.js";
import type {
  FabricAuthority,
  FabricEndpointGrant,
  FabricPresenceState,
  FabricRevocation,
  FabricRouteGrant,
} from "../src/contract/fabric.js";
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
  readonly presence: Array<{
    machineId: string;
    connectionGeneration: number;
    state: PresenceState;
  }> = [];
  readonly calls: string[] = [];
  private revoke: ((revocation: Revocation) => void) | null = null;
  private readonly clientAuthorizationGates = new Map<
    string,
    { started: () => void; released: Promise<void> }
  >();
  private readonly daemonAuthorizationGates = new Map<
    string,
    { started: () => void; released: Promise<void> }
  >();
  private presenceGate: { started: () => void; released: Promise<void> } | null = null;
  private failDaemon = false;
  private failClientInspect = false;
  private failClientAuthorize = false;
  private failPresence = false;
  private nextDaemonGeneration = 1;

  failNextDaemonAuthorization(): void {
    this.failDaemon = true;
  }

  failNextClientInspection(): void {
    this.failClientInspect = true;
  }

  failNextClientAuthorization(): void {
    this.failClientAuthorize = true;
  }

  failNextPresenceReport(): void {
    this.failPresence = true;
  }

  holdNextPresenceReport(): { started: Promise<void>; release(): void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.presenceGate = { started: markStarted, released };
    return { started, release };
  }

  /** Delays one daemon grant so a machine revocation can race its response. */
  holdDaemonAuthorization(ticket: string): { started: Promise<void>; release(): void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.daemonAuthorizationGates.set(ticket, { started: markStarted, released });
    return { started, release };
  }

  /** Delays one redeemed client grant so a revocation can race its response. */
  holdClientAuthorization(ticket: string): { started: Promise<void>; release(): void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.clientAuthorizationGates.set(ticket, { started: markStarted, released });
    return { started, release };
  }

  grantDaemon(
    ticket: string,
    grant: Omit<DaemonGrant, "connectionGeneration" | "presenceLeaseSeconds"> & {
      connectionGeneration?: number;
      presenceLeaseSeconds?: number;
    },
  ): void {
    this.daemonTickets.set(ticket, {
      ...grant,
      connectionGeneration:
        grant.connectionGeneration ?? this.nextDaemonGeneration++,
      presenceLeaseSeconds: grant.presenceLeaseSeconds ?? 90,
    });
  }

  /** Single use, mirroring the real ticket: redeeming removes it. */
  grantClient(
    ticket: string,
    grant: ClientGrant | { machineId: string; clientId: string },
  ): void {
    this.clientTickets.set(ticket, {
      ...grant,
      channelCapability:
        "channelCapability" in grant
          ? grant.channelCapability
          : `cap_${grant.clientId}`,
    });
  }

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    this.calls.push("authorizeDaemon");
    if (this.failDaemon) {
      this.failDaemon = false;
      throw new Error("temporary daemon authority failure");
    }
    const grant = this.daemonTickets.get(ticket) ?? null;
    const gate = this.daemonAuthorizationGates.get(ticket);
    if (gate) {
      gate.started();
      await gate.released;
      this.daemonAuthorizationGates.delete(ticket);
    }
    return grant;
  }

  async inspectClient(ticket: string): Promise<ClientGrant | null> {
    this.calls.push("inspectClient");
    if (this.failClientInspect) {
      this.failClientInspect = false;
      throw new Error("temporary client inspection failure");
    }
    return this.clientTickets.get(ticket) ?? null;
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    this.calls.push("authorizeClient");
    if (this.failClientAuthorize) {
      this.failClientAuthorize = false;
      throw new Error("temporary client authorization failure");
    }
    const grant = this.clientTickets.get(ticket);
    if (grant) this.clientTickets.delete(ticket);
    const gate = this.clientAuthorizationGates.get(ticket);
    if (gate) {
      gate.started();
      await gate.released;
      this.clientAuthorizationGates.delete(ticket);
    }
    return grant ?? null;
  }

  async reportPresence(
    machineId: string,
    connectionGeneration: number,
    state: PresenceState,
  ): Promise<void> {
    this.calls.push("reportPresence");
    const gate = this.presenceGate;
    if (gate) {
      this.presenceGate = null;
      gate.started();
      await gate.released;
    }
    if (this.failPresence) {
      this.failPresence = false;
      throw new Error("temporary presence failure");
    }
    this.presence.push({ machineId, connectionGeneration, state });
  }

  onRevoked(handler: (revocation: Revocation) => void): void {
    this.revoke = handler;
  }

  /** Stands in for the control plane pushing a revocation. */
  revokeMachine(machineId: string, reason = "revoked by the owner"): void {
    this.revoke?.({ target: "machine", machineId, reason });
  }

  /** Stands in for one signed-in session losing every live channel it opened. */
  revokeClient(clientId: string, reason = "session revoked by the owner"): void {
    this.revoke?.({ target: "client", clientId, reason });
  }
}

/** The endpoint-neutral control-plane half used by Fabric integration tests. */
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

  /** Delays one already-redeemed response to model network reordering. */
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
    this.endpointAuthorizationGates.set(credential, { started: markStarted, released });
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
  authority: FakeAuthority;
  fabricAuthority: FakeFabricAuthority | null;
  origin: string;
  wsOrigin: string;
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  stop(): Promise<void>;
}

export async function startTestRelay(
  authority: ChannelAuthority = new FakeAuthority(),
  fabricAuthority: FabricAuthority | null = null,
): Promise<TestRelay> {
  const relay = await startRelay({
    port: 0,
    host: "127.0.0.1",
    authority,
    fabricAuthority,
  });
  const origin = `http://127.0.0.1:${relay.port}`;
  return {
    relay,
    authority: authority as FakeAuthority,
    fabricAuthority: fabricAuthority as FakeFabricAuthority | null,
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

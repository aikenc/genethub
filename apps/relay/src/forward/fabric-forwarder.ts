import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { FabricAuthority } from "../contract/fabric.js";
import { FABRIC_PATH } from "../contract/fabric-wire.js";
import { config } from "../shared/config.js";
import { log } from "../shared/log.js";
import {
  FabricCore,
  type FabricEndpointConnection,
  type FabricEndpointContext,
} from "./fabric-core.js";
import { decodeFabricFrame, encodeFabricFrame, FabricReset } from "./fabric-frame.js";

interface SocketPeer {
  readonly socket: WebSocket;
  readonly connection: FabricEndpointConnection;
  alive: boolean;
  presenceOnline: boolean;
}

function credentialOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const credential = header.slice(7).trim();
    if (credential) return credential;
  }

  // The browser WebSocket API cannot set Authorization. This credential is
  // therefore short-lived and single-use when it travels in the query string.
  const url = new URL(request.url ?? "/", "http://localhost");
  const ticket = url.searchParams.get("ticket");
  return ticket && ticket.length > 0 ? ticket : null;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function parseExpiry(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One endpoint-neutral WebSocket fabric.
 *
 * Browsers, CLIs and nodes all enter through the same path and run the same
 * state machine. The only per-connection identity is an opaque authority
 * handle plus a relay-generated epoch; OPEN chooses an operation route, never
 * a second physical connection.
 */
export class FabricForwarder {
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly peers = new Set<SocketPeer>();
  private readonly pendingSockets = new Set<Duplex>();
  private readonly presenceReports = new Map<string, Promise<void>>();
  private readonly core: FabricCore;
  private heartbeat: NodeJS.Timeout | null = null;
  private closing = false;
  private authorityReady: boolean;
  /** Invalidates every admission that crossed an authority outage. */
  private authorityEpoch = 0;

  constructor(
    private readonly authority: FabricAuthority,
    options: { authorityReady?: boolean } = {},
  ) {
    this.core = new FabricCore(authority, {
      maxStrikes: config.limits.maxFabricStrikes,
      maxConnectionGenerations: config.limits.maxFabricGenerationFences,
    });
    this.authorityReady = options.authorityReady ?? true;
    authority.onFabricRevoked((revocation) => this.core.revoke(revocation));
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === FABRIC_PATH) {
        void this.upgrade(request, socket, head);
      }
    });

    this.heartbeat = setInterval(() => {
      this.core.sweepExpired();
      for (const peer of this.peers) {
        if (!peer.alive) {
          peer.socket.terminate();
          continue;
        }
        peer.alive = false;
        peer.socket.ping();
        this.reportPresence(
          peer.connection.context.endpointHandle,
          peer.connection.context.connectionGeneration,
          "online",
        );
      }
    }, config.limits.heartbeatSeconds * 1000);
    this.heartbeat.unref?.();
  }

  stats(): { endpoints: number; streams: number; pendingOpens: number } {
    return this.core.stats();
  }

  authorityAvailable(): boolean {
    return this.authorityReady && !this.closing;
  }

  /** Reasserts only the endpoint sockets this relay currently owns. */
  resyncPresence(): void {
    for (const peer of this.peers) {
      if (
        peer.presenceOnline &&
        this.core.current(peer.connection.context.endpointHandle) === peer.connection
      ) {
        this.reportPresence(
          peer.connection.context.endpointHandle,
          peer.connection.context.connectionGeneration,
          "online",
        );
      }
    }
  }

  /** Opens admission only after the authority installed its initial sync. */
  authoritySynchronized(): void {
    if (this.closing) return;
    this.authorityReady = true;
    this.resyncPresence();
  }

  /** Drops every binding when revocations can no longer be observed. */
  authorityDisconnected(): void {
    this.authorityReady = false;
    this.authorityEpoch += 1;
    // Do not leave already-started authorization requests attached to raw
    // sockets. The epoch check below is the second line of defence in case a
    // custom Duplex cannot be destroyed synchronously.
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    for (const peer of [...this.peers]) {
      if (!this.peers.delete(peer)) continue;
      const wasOnline = peer.presenceOnline;
      peer.presenceOnline = false;
      this.core.unregister(peer.connection, FabricReset.Revoked);
      if (wasOnline) {
        this.reportPresence(
          peer.connection.context.endpointHandle,
          peer.connection.context.connectionGeneration,
          "offline",
        );
      }
      peer.socket.close(1012, "authority disconnected");
    }
  }

  close(): void {
    this.closing = true;
    this.authorityReady = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    for (const peer of [...this.peers]) {
      const wasOnline = peer.presenceOnline;
      peer.presenceOnline = false;
      this.core.unregister(peer.connection);
      if (wasOnline) {
        this.reportPresence(
          peer.connection.context.endpointHandle,
          peer.connection.context.connectionGeneration,
          "offline",
        );
      }
      peer.socket.close(1001, "relay shutting down");
    }
    this.peers.clear();
  }

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (this.closing || !this.authorityReady) {
      return reject(socket, 503, "Service Unavailable");
    }
    const credential = credentialOf(request);
    if (!credential) return reject(socket, 401, "Unauthorized");
    if (this.pendingSockets.size >= config.limits.maxFabricPendingUpgrades) {
      return reject(socket, 503, "Service Unavailable");
    }

    const admissionEpoch = this.authorityEpoch;
    this.pendingSockets.add(socket);
    const grant = await this.authority
      .authorizeEndpoint(credential)
      .catch((error: unknown) => {
        log.warn("fabric: the control plane could not be reached", { error: String(error) });
        return null;
      })
      .finally(() => this.pendingSockets.delete(socket));
    if (this.closing || socket.destroyed) {
      socket.destroy();
      return;
    }
    // The revocation stream may have dropped while endpoint admission was in
    // flight. Never install that response into an unsynchronized forwarder.
    if (!this.authorityReady || this.authorityEpoch !== admissionEpoch) {
      return reject(socket, 503, "Service Unavailable");
    }
    if (!grant) return reject(socket, 403, "Forbidden");

    const expiresAt = parseExpiry(grant.expiresAt);
    if (
      !grant.endpointHandle ||
      !grant.revocationHandle ||
      !Number.isSafeInteger(grant.connectionGeneration) ||
      grant.connectionGeneration < 1 ||
      (grant.expiresAt !== null && (expiresAt === null || expiresAt <= Date.now()))
    ) {
      return reject(socket, 403, "Forbidden");
    }
    // Capacity is checked after admission so an endpoint at a full relay can
    // still replace its own stale connection. A genuinely new endpoint is
    // refused without disturbing anybody already connected.
    if (
      !this.core.current(grant.endpointHandle) &&
      this.core.stats().endpoints >= config.limits.maxFabricEndpoints
    ) {
      return reject(socket, 503, "Service Unavailable");
    }

    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      this.register(ws, {
        endpointHandle: grant.endpointHandle,
        revocationHandle: grant.revocationHandle,
        expiresAt: grant.expiresAt,
        connectionGeneration: grant.connectionGeneration,
        connectionEpoch: randomBytes(16).toString("hex"),
      });
    });
  }

  private register(socket: WebSocket, rawContext: FabricEndpointContext): void {
    const context = Object.freeze({ ...rawContext });
    const connection: FabricEndpointConnection = {
      context,
      socketIdentity: socket,
      streams: new Map(),
      pending: new Map(),
      tombstones: new Map(),
      closed: false,
      strikes: 0,
      send: (frame) => this.deliver(socket, encodeFabricFrame(frame)),
      close: (code) => socket.close(code),
    };
    const peer: SocketPeer = {
      socket,
      connection,
      alive: true,
      presenceOnline: false,
    };

    // Admission can be rejected synchronously by a revocation tombstone. An
    // error listener must already exist even though that socket never enters
    // the active peer set.
    socket.on("error", () => socket.close());
    const previous = this.core.register(connection);
    if (connection.closed) return;
    this.peers.add(peer);
    previous?.close(4000);
    peer.presenceOnline = true;
    this.reportPresence(context.endpointHandle, context.connectionGeneration, "online");

    socket.on("pong", () => {
      peer.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      peer.alive = true;
      if (!isBinary) return socket.close(1003, "Fabric speaks binary frames");
      const buffer = asBuffer(data);
      if (buffer.length > config.limits.maxFrameBytes) {
        return socket.close(1009, "frame too large");
      }
      const frame = decodeFabricFrame(buffer);
      if (!frame) return socket.close(1003, "malformed Fabric frame");
      void this.core.handle(connection, frame).catch((error: unknown) => {
        log.warn("fabric: frame handling failed", { error: String(error) });
        socket.close(1011, "frame handling failed");
      });
    });

    const shutdown = () => {
      if (!this.peers.delete(peer)) return;
      const replacement = this.core.current(context.endpointHandle);
      this.core.unregister(connection);
      if (peer.presenceOnline && (!replacement || replacement === connection)) {
        peer.presenceOnline = false;
        this.reportPresence(
          context.endpointHandle,
          context.connectionGeneration,
          "offline",
        );
      }
    };
    socket.on("close", shutdown);
  }

  /** Sends an opaque frame without ever decoding its payload. */
  private deliver(socket: WebSocket, payload: Buffer): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > config.limits.maxBufferedBytes) {
      socket.close(1013, "too slow");
      return;
    }
    socket.send(payload, { binary: true });
  }

  /** Keeps online/offline writes ordered even when the control plane is slow. */
  private reportPresence(
    endpointHandle: string,
    connectionGeneration: number,
    state: "online" | "offline",
  ): void {
    const previous = this.presenceReports.get(endpointHandle) ?? Promise.resolve();
    const report = previous
      .catch(() => {})
      .then(() =>
        this.authority.reportEndpointPresence(endpointHandle, connectionGeneration, state),
      )
      .catch((error: unknown) => {
        log.warn("fabric: presence report failed", { state, error: String(error) });
      });
    this.presenceReports.set(endpointHandle, report);
    void report.finally(() => {
      if (this.presenceReports.get(endpointHandle) === report) {
        this.presenceReports.delete(endpointHandle);
      }
    });
  }
}

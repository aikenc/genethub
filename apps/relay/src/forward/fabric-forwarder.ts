import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { FabricAuthority } from "../contract/fabric.js";
import { FABRIC_PATH } from "../contract/fabric-wire.js";
import { config } from "../shared/config.js";
import { isDefinitiveAuthorityError } from "../shared/authority-error.js";
import { log } from "../shared/log.js";
import { OutboundByteBudget } from "../shared/outbound-budget.js";
import { presenceRefreshDelaySeconds } from "../shared/presence-lease.js";
import { admissionCredential, requestTarget } from "../shared/request-target.js";
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
  readonly presenceLeaseSeconds: number;
  presenceDeadlineMs: number;
  presenceRefresh: NodeJS.Timeout | null;
}

interface PresenceUpdate {
  readonly connectionGeneration: number;
  readonly state: "online" | "offline";
}

interface PresenceQueue {
  desired: PresenceUpdate;
  running: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
}

function credentialOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const credential = header.slice(7).trim();
    return admissionCredential(credential, config.limits.maxAdmissionCredentialBytes);
  }

  // The browser WebSocket API cannot set Authorization. This credential is
  // therefore short-lived and single-use when it travels in the query string.
  const url = requestTarget(request.url);
  if (!url) return null;
  const ticket = url.searchParams.get("ticket");
  return admissionCredential(ticket, config.limits.maxAdmissionCredentialBytes);
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
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.maxFrameBytes,
    perMessageDeflate: false,
  });
  private readonly peers = new Set<SocketPeer>();
  private readonly pendingSockets = new Set<Duplex>();
  /** Per endpoint: exactly one in-flight write and at most one latest intent. */
  private readonly presenceReports = new Map<string, PresenceQueue>();
  private readonly core: FabricCore;
  private heartbeat: NodeJS.Timeout | null = null;
  private closing = false;
  private authorityReady: boolean;
  /** Invalidates every admission that crossed an authority outage. */
  private authorityEpoch = 0;
  private readonly outboundBudget: OutboundByteBudget;

  constructor(
    private readonly authority: FabricAuthority,
    options: { authorityReady?: boolean; outboundBudget?: OutboundByteBudget } = {},
  ) {
    this.core = new FabricCore(authority, {
      maxStrikes: config.limits.maxFabricStrikes,
      maxConnectionGenerations: config.limits.maxFabricGenerationFences,
      maxPendingPerEndpoint: config.limits.maxFabricPendingOpensPerEndpoint,
      maxPendingGlobal: config.limits.maxFabricPendingOpens,
      maxStreamsPerEndpoint: config.limits.maxFabricStreamsPerEndpoint,
      maxStreamsGlobal: config.limits.maxFabricStreams,
    });
    this.authorityReady = options.authorityReady ?? true;
    this.outboundBudget =
      options.outboundBudget ??
      new OutboundByteBudget(
        config.limits.maxOutboundQueuedBytes,
        config.limits.maxBufferedBytes,
      );
    authority.onFabricRevoked((revocation) => this.core.revoke(revocation));
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = requestTarget(request.url);
      if (!url) {
        socket.destroy();
        return;
      }
      if (url.pathname === FABRIC_PATH) {
        void this.upgrade(request, socket, head);
      }
    });

    this.heartbeat = setInterval(() => {
      this.core.sweepExpired();
      for (const peer of this.peers) {
        if (!peer.alive) {
          this.terminate(peer.socket, "the endpoint missed a heartbeat");
          continue;
        }
        peer.alive = false;
        this.ping(peer.socket);
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
      if (peer.presenceRefresh) clearTimeout(peer.presenceRefresh);
      this.core.unregister(peer.connection, FabricReset.Revoked);
      if (wasOnline) {
        this.reportPresence(
          peer.connection.context.endpointHandle,
          peer.connection.context.connectionGeneration,
          "offline",
        );
      }
      this.closeSocket(peer.socket, 1012, "authority disconnected");
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.authorityReady = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    for (const peer of [...this.peers]) {
      const wasOnline = peer.presenceOnline;
      peer.presenceOnline = false;
      if (peer.presenceRefresh) clearTimeout(peer.presenceRefresh);
      this.core.unregister(peer.connection);
      if (wasOnline) {
        this.reportPresence(
          peer.connection.context.endpointHandle,
          peer.connection.context.connectionGeneration,
          "offline",
        );
      }
      this.closeSocket(peer.socket, 1001, "relay shutting down");
    }
    this.peers.clear();
    const deadline = Date.now() + 1_000;
    while (this.presenceReports.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.clearPresenceReports();
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
    const revocationCheckpoint = this.core.revocationCheckpoint();
    this.pendingSockets.add(socket);
    let grant;
    try {
      grant = await this.authority.authorizeEndpoint(credential);
    } catch (error) {
      log.warn("fabric: the control plane could not be reached", { error: String(error) });
      if (!socket.destroyed) reject(socket, 503, "Service Unavailable");
      return;
    } finally {
      this.pendingSockets.delete(socket);
    }
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
      !Number.isSafeInteger(grant.presenceLeaseSeconds) ||
      grant.presenceLeaseSeconds < 60 ||
      grant.presenceLeaseSeconds > 3600 ||
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
        presenceLeaseSeconds: grant.presenceLeaseSeconds,
        connectionEpoch: randomBytes(16).toString("hex"),
      }, revocationCheckpoint);
    });
  }

  private register(
    socket: WebSocket,
    rawContext: FabricEndpointContext,
    revocationCheckpoint: number,
  ): void {
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
      close: (code) => this.closeSocket(socket, code),
    };
    const peer: SocketPeer = {
      socket,
      connection,
      alive: true,
      presenceOnline: false,
      presenceLeaseSeconds: context.presenceLeaseSeconds,
      presenceDeadlineMs: Date.now() + context.presenceLeaseSeconds * 1000,
      presenceRefresh: null,
    };

    // Admission can be rejected synchronously by a revocation tombstone. An
    // error listener must already exist even though that socket never enters
    // the active peer set.
    socket.on("error", () => this.closeSocket(socket));
    const previous = this.core.register(connection, revocationCheckpoint);
    if (connection.closed) return;
    this.peers.add(peer);
    previous?.close(4000);
    peer.presenceOnline = true;
    this.reportPresence(context.endpointHandle, context.connectionGeneration, "online");
    this.schedulePresenceRefresh(peer);

    socket.on("pong", () => {
      peer.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      peer.alive = true;
      if (!isBinary) return this.closeSocket(socket, 1003, "Fabric speaks binary frames");
      const buffer = asBuffer(data);
      if (buffer.length > config.limits.maxFrameBytes) {
        return this.closeSocket(socket, 1009, "frame too large");
      }
      const frame = decodeFabricFrame(buffer);
      if (!frame) return this.closeSocket(socket, 1003, "malformed Fabric frame");
      void this.core.handle(connection, frame).catch((error: unknown) => {
        log.warn("fabric: frame handling failed", { error: String(error) });
        this.closeSocket(socket, 1011, "frame handling failed");
      });
    });

    const shutdown = () => {
      if (!this.peers.delete(peer)) return;
      if (peer.presenceRefresh) clearTimeout(peer.presenceRefresh);
      peer.presenceRefresh = null;
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

  private schedulePresenceRefresh(peer: SocketPeer): void {
    if (
      !this.peers.has(peer) ||
      this.core.current(peer.connection.context.endpointHandle) !== peer.connection ||
      this.closing
    ) return;
    const seconds = presenceRefreshDelaySeconds(
      peer.presenceLeaseSeconds,
      config.limits.presenceRefreshMaxSeconds,
    );
    peer.presenceRefresh = setTimeout(() => {
      peer.presenceRefresh = null;
      if (
        !this.peers.has(peer) ||
        this.core.current(peer.connection.context.endpointHandle) !== peer.connection ||
        peer.socket.readyState !== peer.socket.OPEN
      ) return;
      this.reportPresence(
        peer.connection.context.endpointHandle,
        peer.connection.context.connectionGeneration,
        "online",
      );
      this.schedulePresenceRefresh(peer);
    }, seconds * 1000);
    peer.presenceRefresh.unref?.();
  }

  /** Sends an opaque frame without ever decoding its payload. */
  private deliver(socket: WebSocket, payload: Buffer): void {
    if (socket.readyState !== socket.OPEN) return;
    const release = this.outboundBudget.reserve(socket, payload.length);
    if (!release) {
      this.closeSocket(socket, 1013, "too slow");
      return;
    }
    try {
      socket.send(payload, { binary: true }, (error) => {
        release();
        if (error) this.terminate(socket, "the send failed");
      });
    } catch {
      release();
      this.terminate(socket, "the send threw");
    }
  }

  /** Logged for the same reason the legacy forwarder logs its closes: the
   * reason exists only on this side, and a peer that is cut off cannot report
   * anything but "the connection ended". */
  private closeSocket(socket: WebSocket, code?: number, reason = ""): void {
    if (socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING) return;
    log.warn("fabric: closing a socket", { code: code ?? null, reason });
    try {
      if (code === undefined) socket.close();
      else socket.close(code, reason);
    } catch {
      this.terminate(socket, "the close handshake failed");
    }
  }

  private terminate(socket: WebSocket, why = "unspecified"): void {
    log.warn("fabric: terminating a socket", { why });
    try {
      socket.terminate();
    } catch {
      // The peer is already gone.
    }
  }

  private ping(socket: WebSocket): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.ping();
    } catch {
      this.terminate(socket, "the heartbeat ping threw");
    }
  }

  /** Keeps online/offline writes ordered even when the control plane is slow. */
  private reportPresence(
    endpointHandle: string,
    connectionGeneration: number,
    state: "online" | "offline",
  ): void {
    const update = { connectionGeneration, state } as const;
    const existing = this.presenceReports.get(endpointHandle);
    if (existing) {
      existing.desired = update;
      existing.attempt = 0;
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = null;
      }
      this.runPresenceReport(endpointHandle, existing);
      return;
    }

    const queue: PresenceQueue = {
      desired: update,
      running: false,
      attempt: 0,
      timer: null,
    };
    this.presenceReports.set(endpointHandle, queue);
    this.runPresenceReport(endpointHandle, queue);
  }

  private runPresenceReport(endpointHandle: string, report: PresenceQueue): void {
    if (report.running || this.presenceReports.get(endpointHandle) !== report) return;
    report.running = true;
    void (async () => {
      while (this.presenceReports.get(endpointHandle) === report) {
        const desired = report.desired;
        let succeeded = false;
        try {
          await this.authority.reportEndpointPresence(
            endpointHandle,
            desired.connectionGeneration,
            desired.state,
          );
          const peer = this.currentPeer(endpointHandle, desired.connectionGeneration);
          if (
            desired.state === "online" &&
            peer &&
            Date.now() >= peer.presenceDeadlineMs
          ) {
            this.expirePresence(peer);
          } else {
            succeeded = true;
          }
        } catch (error) {
          log.warn("fabric: presence report failed", { state: desired.state });
          if (desired.state === "online") {
            const peer = this.currentPeer(endpointHandle, desired.connectionGeneration);
            if (
              peer &&
              (isDefinitiveAuthorityError(error) ||
                Date.now() >= peer.presenceDeadlineMs)
            ) {
              this.expirePresence(peer);
            }
          } else if (isDefinitiveAuthorityError(error)) {
            // Control has already fenced this generation. An offline report
            // cannot become authoritative through retry, and retaining it would
            // leave one timer and one Control request every backoff interval for
            // every endpoint ever replaced on another Relay.
            succeeded = true;
          }
        }

        if (
          report.desired.connectionGeneration !== desired.connectionGeneration ||
          report.desired.state !== desired.state
        ) {
          report.attempt = 0;
          continue;
        }
        if (succeeded) {
          if (desired.state === "online") {
            const peer = this.currentPeer(endpointHandle, desired.connectionGeneration);
            if (peer) {
              peer.presenceDeadlineMs = Date.now() + peer.presenceLeaseSeconds * 1000;
            }
          }
          this.presenceReports.delete(endpointHandle);
          report.running = false;
          return;
        }

        report.running = false;
        const base = Math.min(250 * 2 ** report.attempt++, 30_000);
        let delay = base + Math.floor(Math.random() * Math.max(1, base / 4));
        if (desired.state === "online") {
          const peer = this.currentPeer(endpointHandle, desired.connectionGeneration);
          if (peer) {
            delay = Math.min(delay, Math.max(0, peer.presenceDeadlineMs - Date.now()));
            if (delay === 0) {
              this.expirePresence(peer);
              continue;
            }
          }
        }
        report.timer = setTimeout(() => {
          report.timer = null;
          this.runPresenceReport(endpointHandle, report);
        }, delay);
        report.timer.unref?.();
        return;
      }
      report.running = false;
    })();
  }

  private currentPeer(endpointHandle: string, connectionGeneration: number): SocketPeer | null {
    for (const peer of this.peers) {
      if (
        peer.connection.context.endpointHandle === endpointHandle &&
        peer.connection.context.connectionGeneration === connectionGeneration &&
        this.core.current(endpointHandle) === peer.connection
      ) return peer;
    }
    return null;
  }

  private expirePresence(peer: SocketPeer): void {
    if (!this.peers.delete(peer)) return;
    if (peer.presenceRefresh) clearTimeout(peer.presenceRefresh);
    peer.presenceRefresh = null;
    peer.presenceOnline = false;
    this.core.unregister(peer.connection, FabricReset.Revoked);
    this.closeSocket(peer.socket, 1012, "presence lease expired");
    this.reportPresence(
      peer.connection.context.endpointHandle,
      peer.connection.context.connectionGeneration,
      "offline",
    );
  }

  private clearPresenceReports(): void {
    for (const report of this.presenceReports.values()) {
      if (report.timer) clearTimeout(report.timer);
    }
    this.presenceReports.clear();
  }
}

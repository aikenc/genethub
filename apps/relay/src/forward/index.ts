import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import {
  CLIENT_PATH,
  DAEMON_PATH,
  type ChannelAuthority,
  type Revocation,
} from "../contract/index.js";
import { config } from "../shared/config.js";
import { isDefinitiveAuthorityError } from "../shared/authority-error.js";
import { log } from "../shared/log.js";
import { OutboundByteBudget } from "../shared/outbound-budget.js";
import { presenceRefreshDelaySeconds } from "../shared/presence-lease.js";
import { admissionCredential, requestTarget } from "../shared/request-target.js";
import { decode, encode, HEADER_BYTES, Kind, newChannelId } from "./frame.js";

export const MAX_LEGACY_PAYLOAD_BYTES = config.limits.maxFrameBytes - HEADER_BYTES;

interface Machine {
  socket: WebSocket;
  machineId: string;
  daemonId: string;
  connectionGeneration: number;
  presenceLeaseSeconds: number;
  presenceDeadlineMs: number;
  presenceRefresh: NodeJS.Timeout | null;
  clients: Map<string, ClientConnection>;
  alive: boolean;
}

interface ClientConnection {
  socket: WebSocket;
  /** Opaque device-session identity supplied by the authority grant. */
  clientId: string;
  alive: boolean;
}

interface PresenceReport {
  desired: "online" | "offline";
  connectionGeneration: number;
  running: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
}

export function boundedCloseReason(reason: string): string {
  let safe = "";
  let bytes = 0;
  for (const character of reason) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > 123) break;
    safe += character;
    bytes += width;
  }
  return safe;
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const value = header.slice(7).trim();
    return admissionCredential(value, config.limits.maxAdmissionCredentialBytes);
  }
  // Browsers cannot set headers on a WebSocket handshake, so a client ticket
  // may also ride in the query string. It is single-use and short-lived.
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

/**
 * The forwarding role: a pairing table and byte shuffling, nothing else.
 *
 * It knows machine ids and channel ids. It does not know what a session is,
 * what a user is, or what any payload contains — everything it is allowed to
 * ask goes through `ChannelAuthority`.
 */
export class Forwarder {
  private readonly daemons = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.maxFrameBytes,
    perMessageDeflate: false,
  });
  private readonly clients = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.maxFrameBytes,
    perMessageDeflate: false,
  });
  private readonly machines = new Map<string, Machine>();
  /**
   * Highest Control-issued admission generation observed for each machine.
   *
   * This deliberately outlives sockets and authority outages. Otherwise a
   * delayed generation-1 authorization can arrive after generation 2, evict
   * the newer uplink, and then keep renewing a presence report which Control
   * correctly ignores. Non-expiring machine identities cannot be pruned
   * safely, so capacity exhaustion rejects only previously unseen identities.
   */
  private readonly machineConnectionGenerations = new Map<string, number>();
  private readonly pendingSockets = new Set<Duplex>();
  private readonly presenceReports = new Map<string, PresenceReport>();
  private readonly latestRevocations = new Map<string, number>();
  private revocationSequence = 0;
  private revocationFloor = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private authorityReady: boolean;
  private authorityEpoch = 0;
  private closing = false;
  private readonly outboundBudget: OutboundByteBudget;

  constructor(
    private readonly authority: ChannelAuthority,
    options: { authorityReady?: boolean; outboundBudget?: OutboundByteBudget } = {},
  ) {
    this.authorityReady = options.authorityReady ?? true;
    this.outboundBudget =
      options.outboundBudget ??
      new OutboundByteBudget(
        config.limits.maxOutboundQueuedBytes,
        config.limits.maxBufferedBytes,
      );
    authority.onRevoked((revocation) => {
      this.rememberRevocation(revocation);
      if (revocation.target === "client") {
        this.evictClient(revocation.clientId, revocation.reason);
      } else {
        this.evictMachine(revocation.machineId, revocation.reason);
      }
    });
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = requestTarget(request.url);
      if (!url) {
        socket.destroy();
        return;
      }
      if (url.pathname === DAEMON_PATH) {
        void this.upgradeDaemon(request, socket, head);
      } else if (url.pathname === CLIENT_PATH) {
        void this.upgradeClient(request, socket, head);
      }
    });

    this.heartbeat = setInterval(() => {
      for (const machine of this.machines.values()) {
        if (!machine.alive) {
          this.terminate(machine.socket, "the uplink missed a heartbeat");
          continue;
        }
        machine.alive = false;
        this.ping(machine.socket);
        for (const [channel, client] of machine.clients) {
          if (!client.alive) {
            machine.clients.delete(channel);
            this.terminate(client.socket, "the client missed a heartbeat");
            continue;
          }
          client.alive = false;
          this.ping(client.socket);
        }
      }
    }, config.limits.heartbeatSeconds * 1000);
    this.heartbeat.unref?.();
  }

  isOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  authorityAvailable(): boolean {
    return this.authorityReady && !this.closing;
  }

  /** Opens admission only after the initial durable revocation sync. */
  authoritySynchronized(): void {
    if (this.closing) return;
    this.authorityReady = true;
    this.resyncPresence();
  }

  /** Existing authority cannot survive losing its revocation source. */
  authorityDisconnected(): void {
    this.authorityReady = false;
    this.authorityEpoch += 1;
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    for (const machine of this.machines.values()) {
      if (machine.presenceRefresh) clearTimeout(machine.presenceRefresh);
      // Keep a bounded latest-state retry alive across the Control outage.
      // Otherwise Control can retain an old "online" forever after every
      // socket was deliberately failed closed here.
      this.reportPresence(
        machine.machineId,
        machine.connectionGeneration,
        "offline",
      );
      for (const client of machine.clients.values()) {
        this.closeSocket(client.socket, 1012, "authority disconnected");
      }
      this.closeSocket(machine.socket, 1012, "authority disconnected");
    }
    this.machines.clear();
  }

  /**
   * Re-reports every machine currently held.
   *
   * Presence is otherwise reported only on change, and the control plane
   * marks every machine offline as it boots — so a control plane restart
   * strands live machines as "offline" until each one happens to reconnect
   * on its own. This is called each time the revocation stream
   * re-establishes, the relay's own signal that the control plane is (back)
   * up. Additive on purpose: another relay's machines are not ours to
   * describe.
   */
  resyncPresence(): void {
    for (const machine of this.machines.values()) {
      this.reportPresence(
        machine.machineId,
        machine.connectionGeneration,
        "online",
      );
    }
  }

  /** Presence is advisory output, but a rejected Promise must still be handled. */
  private reportPresence(
    machineId: string,
    connectionGeneration: number,
    state: "online" | "offline",
  ): void {
    const existing = this.presenceReports.get(machineId);
    if (existing) {
      existing.desired = state;
      existing.connectionGeneration = connectionGeneration;
      existing.attempt = 0;
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = null;
      }
      this.runPresenceReport(machineId, existing);
      return;
    }
    const report: PresenceReport = {
      desired: state,
      connectionGeneration,
      running: false,
      attempt: 0,
      timer: null,
    };
    this.presenceReports.set(machineId, report);
    this.runPresenceReport(machineId, report);
  }

  /** For the split-readiness smoke test and for metrics. */
  stats(): { machines: number; channels: number } {
    let channels = 0;
    for (const machine of this.machines.values()) channels += machine.clients.size;
    return { machines: this.machines.size, channels };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.authorityReady = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    for (const machine of this.machines.values()) {
      if (machine.presenceRefresh) clearTimeout(machine.presenceRefresh);
      this.reportPresence(
        machine.machineId,
        machine.connectionGeneration,
        "offline",
      );
      for (const client of machine.clients.values()) {
        this.closeSocket(client.socket, 1001, "relay shutting down");
      }
      this.closeSocket(machine.socket, 1001, "relay shutting down");
    }
    this.machines.clear();
    // Best effort on graceful shutdown, globally bounded so an unavailable
    // Control can never hang SIGTERM indefinitely. Crash convergence is the
    // Control-side presence lease's job.
    const deadline = Date.now() + 1_000;
    while (this.presenceReports.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.clearPresenceReports();
  }

  // -------------------------------------------------------------------------
  // Machine uplink

  private async upgradeDaemon(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (this.closing || !this.authorityReady) {
      return reject(socket, 503, "Service Unavailable");
    }
    const ticket = bearer(request);
    if (!ticket) return reject(socket, 401, "Unauthorized");
    const revocationCheckpoint = this.revocationSequence;
    const authorityEpoch = this.authorityEpoch;

    if (this.pendingSockets.size >= config.limits.maxPendingLegacyUpgrades) {
      return reject(socket, 503, "Service Unavailable");
    }

    this.pendingSockets.add(socket);
    let grant;
    try {
      grant = await this.authority.authorizeDaemon(ticket);
    } catch {
      if (!socket.destroyed) {
        // Authority errors are deliberately not interpolated: an alternative
        // implementation must not be able to reflect a bearer into Relay logs.
        log.warn("forward: daemon authorization is temporarily unavailable");
        reject(socket, 503, "Service Unavailable");
      }
      return;
    } finally {
      this.pendingSockets.delete(socket);
    }
    if (this.closing || socket.destroyed) {
      socket.destroy();
      return;
    }
    if (!this.authorityReady || this.authorityEpoch !== authorityEpoch) {
      return reject(socket, 503, "Service Unavailable");
    }
    if (!grant) return reject(socket, 403, "Forbidden");
    if (
      !this.machines.has(grant.machineId) &&
      this.machines.size >= config.limits.maxDaemons
    ) {
      return reject(socket, 503, "Service Unavailable");
    }
    if (this.wasRevokedSince(revocationCheckpoint, "machine", grant.machineId)) {
      return reject(socket, 403, "Forbidden");
    }

    this.daemons.handleUpgrade(request, socket, head, (ws) => {
      this.registerMachine(
        ws,
        grant.machineId,
        grant.daemonId,
        grant.connectionGeneration,
        grant.presenceLeaseSeconds,
      );
    });
  }

  private registerMachine(
    socket: WebSocket,
    machineId: string,
    daemonId: string,
    connectionGeneration: number,
    presenceLeaseSeconds: number,
  ): void {
    // `handleUpgrade` callbacks run synchronously on the JS event loop. Check
    // and advance the fence here, before consulting or closing the live map,
    // so two reordered authority responses cannot both become current and a
    // stale response can never kick the newer socket.
    const observedGeneration = this.machineConnectionGenerations.get(machineId);
    if (
      observedGeneration !== undefined &&
      connectionGeneration <= observedGeneration
    ) {
      this.closeSocket(socket, 4409, "stale connection generation");
      return;
    }
    if (
      observedGeneration === undefined &&
      this.machineConnectionGenerations.size >=
        config.limits.maxLegacyGenerationFences
    ) {
      this.closeSocket(socket, 4429, "connection generation fence capacity reached");
      return;
    }
    this.machineConnectionGenerations.set(machineId, connectionGeneration);

    // A machine reconnecting replaces its old socket: the new one is by
    // definition the live path, and keeping both would split the channel table.
    const previous = this.machines.get(machineId);
    if (previous) {
      if (previous.presenceRefresh) clearTimeout(previous.presenceRefresh);
      // Its close callback is identity-guarded because the new machine is
      // about to occupy the map. Close its clients here first or they remain
      // attached to a socket no forwarder will ever consult again.
      for (const client of previous.clients.values()) {
        this.closeSocket(client.socket, 4000, "machine reconnected; obtain a fresh ticket");
      }
      previous.clients.clear();
      this.closeSocket(previous.socket, 4000, "replaced by a newer connection");
    }

    const machine: Machine = {
      socket,
      machineId,
      daemonId,
      connectionGeneration,
      presenceLeaseSeconds,
      presenceDeadlineMs: Date.now() + presenceLeaseSeconds * 1000,
      presenceRefresh: null,
      clients: new Map(),
      alive: true,
    };
    this.machines.set(machineId, machine);
    this.reportPresence(machineId, connectionGeneration, "online");
    this.schedulePresenceRefresh(machine);

    socket.on("pong", () => {
      machine.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      machine.alive = true;
      if (!isBinary) return this.closeSocket(socket, 1003, "the uplink speaks binary frames");

      const buffer = asBuffer(data);
      if (buffer.length > config.limits.maxFrameBytes) {
        return this.closeSocket(socket, 1009, "frame too large");
      }
      const frame = decode(buffer);
      if (!frame) return this.closeSocket(socket, 1003, "malformed frame");

      const client = machine.clients.get(frame.channel);
      if (!client) return;

      switch (frame.kind) {
        case Kind.Text:
          this.deliver(client.socket, frame.payload, false);
          break;
        case Kind.Binary:
          this.deliver(client.socket, frame.payload, true);
          break;
        case Kind.Close:
          this.closeSocket(client.socket, 1000, frame.payload.toString("utf8"));
          break;
        // A machine has no business opening a channel; ignore rather than
        // tearing down every other client's session over it.
        case Kind.Open:
          break;
      }
    });

    const shutdown = () => {
      if (this.machines.get(machineId) !== machine) return;
      this.machines.delete(machineId);
      if (machine.presenceRefresh) clearTimeout(machine.presenceRefresh);
      for (const client of machine.clients.values()) {
        this.closeSocket(client.socket, 4004, "the machine went offline");
      }
      machine.clients.clear();
      this.reportPresence(machineId, connectionGeneration, "offline");
    };

    socket.on("close", shutdown);
    socket.on("error", () => this.closeSocket(socket));
  }

  private schedulePresenceRefresh(machine: Machine): void {
    if (this.machines.get(machine.machineId) !== machine || this.closing) return;
    const seconds = presenceRefreshDelaySeconds(
      machine.presenceLeaseSeconds,
      config.limits.presenceRefreshMaxSeconds,
    );
    machine.presenceRefresh = setTimeout(() => {
      machine.presenceRefresh = null;
      if (
        this.machines.get(machine.machineId) !== machine ||
        machine.socket.readyState !== machine.socket.OPEN
      ) return;
      this.reportPresence(
        machine.machineId,
        machine.connectionGeneration,
        "online",
      );
      this.schedulePresenceRefresh(machine);
    }, seconds * 1000);
    machine.presenceRefresh.unref?.();
  }

  // -------------------------------------------------------------------------
  // Client attach

  private async upgradeClient(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (this.closing || !this.authorityReady) {
      return reject(socket, 503, "Service Unavailable");
    }
    const ticket = bearer(request);
    if (!ticket) return reject(socket, 401, "Unauthorized");
    const revocationCheckpoint = this.revocationSequence;
    const authorityEpoch = this.authorityEpoch;
    if (this.pendingSockets.size >= config.limits.maxPendingLegacyUpgrades) {
      return reject(socket, 503, "Service Unavailable");
    }
    this.pendingSockets.add(socket);

    // Inspect first, spend second. Authorizing (which burns a one-shot ticket)
    // before checking the uplink map turned every brief offline blip into a
    // spent ticket and a 409 — the desktop then mints another, and the Hub
    // fills with unredeemable rows while the user stares at 「已断开」.
    try {
      let peek;
      try {
        peek = await this.authority.inspectClient(ticket);
      } catch {
        log.warn("forward: client ticket inspection is temporarily unavailable");
        if (!socket.destroyed) reject(socket, 503, "Service Unavailable");
        return;
      }
      if (this.closing || socket.destroyed) {
        socket.destroy();
        return;
      }
      if (!this.authorityReady || this.authorityEpoch !== authorityEpoch) {
        return reject(socket, 503, "Service Unavailable");
      }
      if (!peek) return reject(socket, 403, "Forbidden");
      if (
        this.wasRevokedSince(revocationCheckpoint, "machine", peek.machineId) ||
        this.wasRevokedSince(revocationCheckpoint, "client", peek.clientId)
      ) {
        return reject(socket, 403, "Forbidden");
      }

      const machine = this.machines.get(peek.machineId);
      if (!machine) return reject(socket, 409, "Machine Offline");
      if (machine.clients.size >= config.limits.maxClientsPerMachine) {
        return reject(socket, 429, "Too Many Connections");
      }

      let grant;
      try {
        grant = await this.authority.authorizeClient(ticket);
      } catch {
        log.warn("forward: client authorization is temporarily unavailable");
        if (!socket.destroyed) reject(socket, 503, "Service Unavailable");
        return;
      }
      if (this.closing || socket.destroyed) {
        socket.destroy();
        return;
      }
      if (!this.authorityReady || this.authorityEpoch !== authorityEpoch) {
        return reject(socket, 503, "Service Unavailable");
      }
      const liveMachine = this.machines.get(grant?.machineId ?? "");
      if (
        !grant ||
        grant.machineId !== machine.machineId ||
        grant.clientId !== peek.clientId ||
        !liveMachine ||
        liveMachine.clients.size >= config.limits.maxClientsPerMachine ||
        this.wasRevokedSince(revocationCheckpoint, "machine", grant.machineId) ||
        this.wasRevokedSince(revocationCheckpoint, "client", grant.clientId)
      ) {
        return reject(socket, 403, "Forbidden");
      }

      this.clients.handleUpgrade(request, socket, head, (ws) => {
        this.registerClient(ws, liveMachine, grant.clientId, grant.channelCapability);
      });
    } finally {
      this.pendingSockets.delete(socket);
    }
  }

  private registerClient(
    socket: WebSocket,
    machine: Machine,
    clientId: string,
    channelCapability: string,
  ): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelCapability)) {
      this.closeSocket(socket, 4403, "invalid channel capability");
      return;
    }
    const channel = newChannelId();
    const client: ClientConnection = { socket, clientId, alive: true };
    machine.clients.set(channel, client);
    log.debug("forward: a client channel opened", {
      channel,
      machineId: machine.machineId,
      channels: machine.clients.size,
    });
    this.deliver(machine.socket, encode(Kind.Open, channel, channelCapability), true);

    socket.on("message", (data, isBinary) => {
      client.alive = true;
      const buffer = asBuffer(data);
      if (buffer.length > MAX_LEGACY_PAYLOAD_BYTES) {
        return this.closeSocket(socket, 1009, "frame too large");
      }
      if (this.machines.get(machine.machineId) !== machine) {
        return this.closeSocket(socket, 4004, "the machine went offline");
      }
      // Revocation removes the channel before starting the WebSocket close
      // handshake. Do not let a frame already in the event queue cross that
      // authority boundary while the peer is still acknowledging the close.
      if (machine.clients.get(channel) !== client) {
        return this.closeSocket(socket, 4403, "client authority revoked");
      }
      this.deliver(
        machine.socket,
        encode(isBinary ? Kind.Binary : Kind.Text, channel, buffer),
        true,
      );
    });
    socket.on("pong", () => {
      client.alive = true;
    });

    const detach = () => {
      if (machine.clients.get(channel) !== client) return;
      machine.clients.delete(channel);
      log.debug("forward: a client channel closed", {
        channel,
        machineId: machine.machineId,
        channels: machine.clients.size,
      });
      this.deliver(machine.socket, encode(Kind.Close, channel, "client detached"), true);
    };

    socket.on("close", detach);
    socket.on("error", () => this.closeSocket(socket));
  }

  // -------------------------------------------------------------------------

  /**
   * Sends, unless the peer has fallen far enough behind that buffering more
   * would cost us memory on its behalf. Dropping one slow reader is the whole
   * point of having a per-connection budget.
   */
  private deliver(socket: WebSocket, payload: Buffer, binary: boolean): void {
    if (socket.readyState !== socket.OPEN) return;
    const release = this.outboundBudget.reserve(socket, payload.length);
    if (!release) {
      this.closeSocket(socket, 1013, "too slow");
      return;
    }
    try {
      socket.send(payload, { binary }, (error) => {
        release();
        if (error) this.terminate(socket, "the send failed");
      });
    } catch {
      release();
      this.terminate(socket, "the send threw");
    }
  }

  /**
   * Every deliberate close goes through here, and every one of them is logged.
   *
   * A peer that is cut off sees only that its connection ended; whatever it was
   * waiting for is left with an unknown outcome. The reason exists on this side
   * alone, so if it is not written down here nobody can ever answer why a
   * session dropped.
   */
  private closeSocket(socket: WebSocket, code?: number, reason = ""): void {
    if (socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING) return;
    log.warn("forward: closing a socket", { code: code ?? null, reason });
    try {
      if (code === undefined) socket.close();
      else socket.close(code, boundedCloseReason(reason));
    } catch {
      this.terminate(socket, "the close handshake failed");
    }
  }

  private terminate(socket: WebSocket, why = "unspecified"): void {
    log.warn("forward: terminating a socket", { why });
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

  private runPresenceReport(machineId: string, report: PresenceReport): void {
    if (report.running || this.presenceReports.get(machineId) !== report) return;
    report.running = true;
    void (async () => {
      while (this.presenceReports.get(machineId) === report) {
        const desired = report.desired;
        const connectionGeneration = report.connectionGeneration;
        let succeeded = false;
        try {
          await this.authority.reportPresence(
            machineId,
            connectionGeneration,
            desired,
          );
          const machine = this.machines.get(machineId);
          if (
            desired === "online" &&
            machine?.connectionGeneration === connectionGeneration &&
            Date.now() >= machine.presenceDeadlineMs
          ) {
            this.expireMachinePresence(machine);
          } else {
            succeeded = true;
          }
        } catch (error) {
          // Do not include machine ids or credentials in Relay logs.
          log.warn("forward: could not report presence to the control plane");
          if (desired === "online") {
            const machine = this.machines.get(machineId);
            if (
              machine &&
              machine.connectionGeneration === connectionGeneration &&
              (isDefinitiveAuthorityError(error) ||
                Date.now() >= machine.presenceDeadlineMs)
            ) {
              this.expireMachinePresence(machine);
            }
          } else if (isDefinitiveAuthorityError(error)) {
            // Control no longer recognizes this generation. Retrying an
            // offline report cannot make it authoritative and would retain a
            // presence queue forever after the socket is already gone.
            succeeded = true;
          }
        }
        if (
          report.desired !== desired ||
          report.connectionGeneration !== connectionGeneration
        ) {
          report.attempt = 0;
          continue;
        }
        if (succeeded) {
          if (desired === "online") {
            const machine = this.machines.get(machineId);
            if (machine?.connectionGeneration === connectionGeneration) {
              machine.presenceDeadlineMs =
                Date.now() + machine.presenceLeaseSeconds * 1000;
            }
          }
          this.presenceReports.delete(machineId);
          report.running = false;
          return;
        }

        report.running = false;
        const base = Math.min(250 * 2 ** report.attempt++, 30_000);
        let delay = base + Math.floor(Math.random() * Math.max(1, base / 4));
        if (desired === "online") {
          const machine = this.machines.get(machineId);
          if (machine?.connectionGeneration === connectionGeneration) {
            delay = Math.min(delay, Math.max(0, machine.presenceDeadlineMs - Date.now()));
            if (delay === 0) {
              this.expireMachinePresence(machine);
              continue;
            }
          }
        }
        report.timer = setTimeout(() => {
          report.timer = null;
          this.runPresenceReport(machineId, report);
        }, delay);
        report.timer.unref?.();
        return;
      }
      report.running = false;
    })();
  }

  private clearPresenceReports(): void {
    for (const report of this.presenceReports.values()) {
      if (report.timer) clearTimeout(report.timer);
    }
    this.presenceReports.clear();
  }

  private expireMachinePresence(machine: Machine): void {
    if (this.machines.get(machine.machineId) !== machine) return;
    this.machines.delete(machine.machineId);
    if (machine.presenceRefresh) clearTimeout(machine.presenceRefresh);
    machine.presenceRefresh = null;
    for (const client of machine.clients.values()) {
      this.closeSocket(client.socket, 1012, "machine presence lease expired");
    }
    machine.clients.clear();
    this.closeSocket(machine.socket, 1012, "presence lease expired");
    this.reportPresence(
      machine.machineId,
      machine.connectionGeneration,
      "offline",
    );
  }

  private evictMachine(machineId: string, reason: string): void {
    const machine = this.machines.get(machineId);
    if (!machine) return;
    if (machine.presenceRefresh) clearTimeout(machine.presenceRefresh);
    for (const client of machine.clients.values()) this.closeSocket(client.socket, 4403, reason);
    this.closeSocket(machine.socket, 4403, reason);
    this.machines.delete(machineId);
  }

  /** Closes every channel opened under one session, and no other channel. */
  private evictClient(clientId: string, reason: string): void {
    for (const machine of this.machines.values()) {
      for (const [channel, client] of machine.clients) {
        if (client.clientId !== clientId) continue;

        // Delete synchronously so queued frames fail the identity check above.
        // Also tell the daemon now rather than waiting for the WebSocket close
        // handshake, which an untrusted peer is free never to acknowledge.
        machine.clients.delete(channel);
        this.deliver(
          machine.socket,
          encode(Kind.Close, channel, "client authority revoked"),
          true,
        );
        this.closeSocket(client.socket, 4403, reason);
      }
    }
  }

  /**
   * Remembers enough ordering to stop an authority response from resurrecting
   * a socket after its revocation raced ahead of that response on the network.
   * The bounded floor fails old in-flight admissions closed if churn forced
   * their exact event out of the map.
   */
  private rememberRevocation(revocation: Revocation): void {
    const sequence = ++this.revocationSequence;
    const key =
      revocation.target === "machine"
        ? `machine:${revocation.machineId}`
        : `client:${revocation.clientId}`;
    this.latestRevocations.delete(key);
    this.latestRevocations.set(key, sequence);

    while (this.latestRevocations.size > 4_096) {
      const oldest = this.latestRevocations.entries().next().value as
        | [string, number]
        | undefined;
      if (!oldest) break;
      this.latestRevocations.delete(oldest[0]);
      this.revocationFloor = Math.max(this.revocationFloor, oldest[1]);
    }
  }

  private wasRevokedSince(
    checkpoint: number,
    target: "machine" | "client",
    id: string,
  ): boolean {
    if (checkpoint < this.revocationFloor) return true;
    return (this.latestRevocations.get(`${target}:${id}`) ?? 0) > checkpoint;
  }
}

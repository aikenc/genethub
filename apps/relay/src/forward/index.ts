import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { CLIENT_PATH, DAEMON_PATH, type ChannelAuthority } from "../contract/index.js";
import { config } from "../shared/config.js";
import { log } from "../shared/log.js";
import { decode, encode, Kind, newChannelId } from "./frame.js";

interface Machine {
  socket: WebSocket;
  machineId: string;
  daemonId: string;
  clients: Map<string, WebSocket>;
  alive: boolean;
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  // Browsers cannot set headers on a WebSocket handshake, so a client ticket
  // may also ride in the query string. It is single-use and short-lived.
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

/**
 * The forwarding role: a pairing table and byte shuffling, nothing else.
 *
 * It knows machine ids and channel ids. It does not know what a session is,
 * what a user is, or what any payload contains — everything it is allowed to
 * ask goes through `ChannelAuthority`.
 */
export class Forwarder {
  private readonly daemons = new WebSocketServer({ noServer: true });
  private readonly clients = new WebSocketServer({ noServer: true });
  private readonly machines = new Map<string, Machine>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly authority: ChannelAuthority) {
    authority.onRevoked(({ machineId, reason }) => this.evict(machineId, reason));
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === DAEMON_PATH) {
        void this.upgradeDaemon(request, socket, head);
      } else if (url.pathname === CLIENT_PATH) {
        void this.upgradeClient(request, socket, head);
      }
    });

    this.heartbeat = setInterval(() => {
      for (const machine of this.machines.values()) {
        if (!machine.alive) {
          machine.socket.terminate();
          continue;
        }
        machine.alive = false;
        machine.socket.ping();
      }
    }, config.limits.heartbeatSeconds * 1000);
    this.heartbeat.unref?.();
  }

  isOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /** For the split-readiness smoke test and for metrics. */
  stats(): { machines: number; channels: number } {
    let channels = 0;
    for (const machine of this.machines.values()) channels += machine.clients.size;
    return { machines: this.machines.size, channels };
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const machine of this.machines.values()) {
      for (const client of machine.clients.values()) client.close(1001, "relay shutting down");
      machine.socket.close(1001, "relay shutting down");
    }
    this.machines.clear();
  }

  // -------------------------------------------------------------------------
  // Machine uplink

  private async upgradeDaemon(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const ticket = bearer(request);
    if (!ticket) return reject(socket, 401, "Unauthorized");

    if (this.machines.size >= config.limits.maxDaemons) {
      return reject(socket, 503, "Service Unavailable");
    }

    const grant = await this.authority.authorizeDaemon(ticket).catch((error: unknown) => {
      log.warn("forward: the control plane could not be reached", { error: String(error) });
      return null;
    });
    if (!grant) return reject(socket, 403, "Forbidden");

    this.daemons.handleUpgrade(request, socket, head, (ws) => {
      this.registerMachine(ws, grant.machineId, grant.daemonId);
    });
  }

  private registerMachine(socket: WebSocket, machineId: string, daemonId: string): void {
    // A machine reconnecting replaces its old socket: the new one is by
    // definition the live path, and keeping both would split the channel table.
    this.machines.get(machineId)?.socket.close(4000, "replaced by a newer connection");

    const machine: Machine = { socket, machineId, daemonId, clients: new Map(), alive: true };
    this.machines.set(machineId, machine);
    void this.authority.reportPresence(machineId, "online");

    socket.on("pong", () => {
      machine.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      machine.alive = true;
      if (!isBinary) return socket.close(1003, "the uplink speaks binary frames");

      const buffer = asBuffer(data);
      if (buffer.length > config.limits.maxFrameBytes) {
        return socket.close(1009, "frame too large");
      }
      const frame = decode(buffer);
      if (!frame) return socket.close(1003, "malformed frame");

      const client = machine.clients.get(frame.channel);
      if (!client) return;

      switch (frame.kind) {
        case Kind.Text:
          this.deliver(client, frame.payload, false);
          break;
        case Kind.Binary:
          this.deliver(client, frame.payload, true);
          break;
        case Kind.Close:
          client.close(1000, frame.payload.toString("utf8").slice(0, 120));
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
      for (const client of machine.clients.values()) {
        client.close(4004, "the machine went offline");
      }
      machine.clients.clear();
      void this.authority.reportPresence(machineId, "offline");
    };

    socket.on("close", shutdown);
    socket.on("error", () => socket.close());
  }

  // -------------------------------------------------------------------------
  // Client attach

  private async upgradeClient(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const ticket = bearer(request);
    if (!ticket) return reject(socket, 401, "Unauthorized");

    const grant = await this.authority.authorizeClient(ticket).catch((error: unknown) => {
      log.warn("forward: the control plane could not be reached", { error: String(error) });
      return null;
    });
    if (!grant) return reject(socket, 403, "Forbidden");

    const machine = this.machines.get(grant.machineId);
    if (!machine) return reject(socket, 409, "Machine Offline");
    if (machine.clients.size >= config.limits.maxClientsPerMachine) {
      return reject(socket, 429, "Too Many Connections");
    }

    this.clients.handleUpgrade(request, socket, head, (ws) => {
      this.registerClient(ws, machine);
    });
  }

  private registerClient(socket: WebSocket, machine: Machine): void {
    const channel = newChannelId();
    machine.clients.set(channel, socket);
    machine.socket.send(encode(Kind.Open, channel));

    socket.on("message", (data, isBinary) => {
      const buffer = asBuffer(data);
      if (buffer.length > config.limits.maxFrameBytes) {
        return socket.close(1009, "frame too large");
      }
      if (this.machines.get(machine.machineId) !== machine) {
        return socket.close(4004, "the machine went offline");
      }
      this.deliver(
        machine.socket,
        encode(isBinary ? Kind.Binary : Kind.Text, channel, buffer),
        true,
      );
    });

    const detach = () => {
      if (machine.clients.get(channel) !== socket) return;
      machine.clients.delete(channel);
      if (machine.socket.readyState === machine.socket.OPEN) {
        machine.socket.send(encode(Kind.Close, channel, "client detached"));
      }
    };

    socket.on("close", detach);
    socket.on("error", () => socket.close());
  }

  // -------------------------------------------------------------------------

  /**
   * Sends, unless the peer has fallen far enough behind that buffering more
   * would cost us memory on its behalf. Dropping one slow reader is the whole
   * point of having a per-connection budget.
   */
  private deliver(socket: WebSocket, payload: Buffer, binary: boolean): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > config.limits.maxBufferedBytes) {
      socket.close(1013, "too slow");
      return;
    }
    socket.send(payload, { binary });
  }

  private evict(machineId: string, reason: string): void {
    const machine = this.machines.get(machineId);
    if (!machine) return;
    for (const client of machine.clients.values()) client.close(4403, reason);
    machine.socket.close(4403, reason);
    this.machines.delete(machineId);
  }
}

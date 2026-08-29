import { createHash } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { performance } from "node:perf_hooks";

const MIB = 1024 * 1024;
const DEFAULT_SEGMENT_BYTES = 16 * 1024;
const MIN_QUEUE_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 64 * MIB;

export interface NetworkLinkProfile {
  /** Request/response round-trip latency. Each direction receives half. */
  rttMs: number;
  /** Decimal megabits per second, applied independently in each direction. */
  bandwidthMbps: number;
}

export interface ShapedTcpProxyStats {
  acceptedConnections: number;
  clientToTargetBytes: number;
  targetToClientBytes: number;
  peakQueuedBytes: number;
}

export interface ShapedTcpProxy {
  readonly port: number;
  /** Replaces only the authority; path, query and ws/http/tcp scheme survive. */
  urlFor(url: string): string;
  setProfile(profile: NetworkLinkProfile): void;
  resetStats(): void;
  stats(): ShapedTcpProxyStats;
  stop(): Promise<void>;
}

export interface TcpPayloadServer {
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  stop(): Promise<void>;
}

export interface TcpTransferSample {
  bytes: number;
  elapsedMs: number;
  ttfbMs: number;
  mibPerSec: number;
  sha256: string;
}

interface MutableProfile {
  current: NetworkLinkProfile;
}

interface MutableStats extends ShapedTcpProxyStats {}

interface ScheduledChunk {
  bytes: Buffer;
  dueMs: number;
}

function validateProfile(profile: NetworkLinkProfile): NetworkLinkProfile {
  if (!Number.isFinite(profile.rttMs) || profile.rttMs < 0 || profile.rttMs > 5_000) {
    throw new RangeError(`unsupported shaped RTT: ${profile.rttMs}`);
  }
  if (
    !Number.isFinite(profile.bandwidthMbps) ||
    profile.bandwidthMbps <= 0 ||
    profile.bandwidthMbps > 100_000
  ) {
    throw new RangeError(`unsupported shaped bandwidth: ${profile.bandwidthMbps}`);
  }
  return { ...profile };
}

function targetOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  const fallback = parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
  const port = parsed.port ? Number(parsed.port) : fallback;
  if (!parsed.hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`invalid TCP proxy target: ${url}`);
  }
  return { host: parsed.hostname, port };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

class ShapedDirection {
  private readonly queue: ScheduledChunk[] = [];
  private timer: NodeJS.Timeout | null = null;
  private serializationTailMs = 0;
  private queuedBytes = 0;
  private destinationWritable = true;
  private sourceEnded = false;
  private stopped = false;

  constructor(
    private readonly source: Socket,
    private readonly destination: Socket,
    private readonly profile: MutableProfile,
    private readonly stats: MutableStats,
    private readonly direction: "clientToTarget" | "targetToClient",
  ) {
    source.on("data", (chunk: Buffer) => this.enqueue(chunk));
    source.on("end", () => {
      this.sourceEnded = true;
      this.flush();
    });
    destination.on("drain", () => {
      this.destinationWritable = true;
      this.flush();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private enqueue(chunk: Buffer): void {
    if (this.stopped) return;
    for (let offset = 0; offset < chunk.length; offset += DEFAULT_SEGMENT_BYTES) {
      const bytes = Buffer.from(chunk.subarray(offset, offset + DEFAULT_SEGMENT_BYTES));
      const now = performance.now();
      const bitsPerMs = this.profile.current.bandwidthMbps * 1_000;
      const serializationStart = Math.max(now, this.serializationTailMs);
      const serializationMs = (bytes.length * 8) / bitsPerMs;
      this.serializationTailMs = serializationStart + serializationMs;
      this.queue.push({
        bytes,
        dueMs: this.serializationTailMs + this.profile.current.rttMs / 2,
      });
      this.queuedBytes += bytes.length;
      if (this.direction === "clientToTarget") this.stats.clientToTargetBytes += bytes.length;
      else this.stats.targetToClientBytes += bytes.length;
    }
    this.stats.peakQueuedBytes = Math.max(this.stats.peakQueuedBytes, this.queuedBytes);
    if (this.queuedBytes >= this.queueLimitBytes()) this.source.pause();
    this.flush();
  }

  private queueLimitBytes(): number {
    const bytesPerSecond = (this.profile.current.bandwidthMbps * 1_000_000) / 8;
    const twoBdps = bytesPerSecond * (this.profile.current.rttMs / 1000) * 2;
    return Math.min(MAX_QUEUE_BYTES, Math.max(MIN_QUEUE_BYTES, Math.ceil(twoBdps)));
  }

  private flush(): void {
    if (this.stopped || !this.destinationWritable) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = performance.now();
    while (this.queue.length > 0 && this.queue[0]!.dueMs <= now && this.destinationWritable) {
      const item = this.queue.shift()!;
      this.queuedBytes -= item.bytes.length;
      this.destinationWritable = this.destination.write(item.bytes);
    }
    if (this.source.isPaused() && this.queuedBytes < this.queueLimitBytes() / 2) {
      this.source.resume();
    }
    if (this.queue.length > 0) {
      const delayMs = Math.max(0, this.queue[0]!.dueMs - performance.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, delayMs);
      return;
    }
    if (this.sourceEnded && !this.destination.destroyed) this.destination.end();
  }
}

/**
 * A transparent, bounded byte-stream shaper. It sits below WebSocket framing,
 * so the same RTT/bandwidth profile can carry both the real product and the
 * independent raw-TCP control without inspecting either protocol.
 */
export async function startShapedTcpProxy(input: {
  targetUrl: string;
  profile: NetworkLinkProfile;
}): Promise<ShapedTcpProxy> {
  const target = targetOf(input.targetUrl);
  const profile: MutableProfile = { current: validateProfile(input.profile) };
  const stats: MutableStats = {
    acceptedConnections: 0,
    clientToTargetBytes: 0,
    targetToClientBytes: 0,
    peakQueuedBytes: 0,
  };
  const sockets = new Set<Socket>();
  const directions = new Set<ShapedDirection>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    stats.acceptedConnections += 1;
    sockets.add(client);
    client.pause();
    client.setNoDelay(true);
    const upstream = createConnection({
      host: target.host,
      port: target.port,
      allowHalfOpen: true,
    });
    sockets.add(upstream);
    upstream.setNoDelay(true);
    const fail = (error: Error) => {
      if (!client.destroyed) client.destroy(error);
      if (!upstream.destroyed) upstream.destroy(error);
    };
    client.on("error", () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.on("error", fail);
    upstream.once("connect", () => {
      const forward = new ShapedDirection(client, upstream, profile, stats, "clientToTarget");
      const reverse = new ShapedDirection(upstream, client, profile, stats, "targetToClient");
      directions.add(forward);
      directions.add(reverse);
      client.resume();
    });
    const forget = () => {
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.once("close", forget);
    upstream.once("close", forget);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("shaped TCP proxy has no TCP address");
  }
  let stopped = false;
  return {
    port: address.port,
    urlFor(url: string): string {
      const parsed = new URL(url);
      parsed.hostname = "127.0.0.1";
      parsed.port = String(address.port);
      return parsed.toString();
    },
    setProfile(next: NetworkLinkProfile): void {
      profile.current = validateProfile(next);
    },
    resetStats(): void {
      stats.acceptedConnections = 0;
      stats.clientToTargetBytes = 0;
      stats.targetToClientBytes = 0;
      stats.peakQueuedBytes = 0;
    },
    stats(): ShapedTcpProxyStats {
      return { ...stats };
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const direction of directions) direction.stop();
      directions.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closeServer(server);
    },
  };
}

/** A real TCP source that starts one exact payload after any request byte. */
export async function startTcpPayloadServer(sizeBytes: number): Promise<TcpPayloadServer> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 128 * MIB) {
    throw new RangeError(`unsupported TCP payload size: ${sizeBytes}`);
  }
  const payload = Buffer.alloc(sizeBytes, 0xa5);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      let offset = 0;
      const write = () => {
        while (offset < payload.length) {
          const end = Math.min(payload.length, offset + 64 * 1024);
          const writable = socket.write(payload.subarray(offset, end));
          offset = end;
          if (!writable) {
            socket.once("drain", write);
            return;
          }
        }
        socket.end();
      };
      write();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("TCP payload server has no TCP address");
  }
  let stopped = false;
  return {
    url: `tcp://127.0.0.1:${address.port}`,
    sizeBytes,
    sha256,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closeServer(server);
    },
  };
}

/** Measures an established-connection request plus exact response body. */
export async function measureTcpTransfer(input: {
  url: string;
  expectedBytes: number;
  expectedSha256: string;
  timeoutMs?: number;
}): Promise<TcpTransferSample> {
  const target = targetOf(input.url);
  const socket = createConnection({ host: target.host, port: target.port });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const began = performance.now();
  let firstByteAt: number | null = null;
  let bytes = 0;
  const hash = createHash("sha256");
  const timeoutMs = input.timeoutMs ?? 30_000;
  return await new Promise<TcpTransferSample>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw TCP transfer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.on("data", (chunk: Buffer) => {
      firstByteAt ??= performance.now();
      bytes += chunk.length;
      hash.update(chunk);
    });
    socket.once("error", fail);
    socket.once("end", () => {
      clearTimeout(timer);
      const ended = performance.now();
      const sha256 = hash.digest("hex");
      if (bytes !== input.expectedBytes || sha256 !== input.expectedSha256) {
        reject(
          new Error(
            `raw TCP payload mismatch: bytes=${bytes}/${input.expectedBytes} sha256=${sha256}/${input.expectedSha256}`,
          ),
        );
        return;
      }
      const elapsedMs = ended - began;
      resolve({
        bytes,
        elapsedMs,
        ttfbMs: (firstByteAt ?? ended) - began,
        mibPerSec: bytes / MIB / (elapsedMs / 1000),
        sha256,
      });
    });
    socket.write(Buffer.from([1]));
  }).finally(() => socket.destroy());
}

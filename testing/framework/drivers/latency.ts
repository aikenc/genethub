import { WebSocket } from "ws";

import type { WebSocketLike } from "@genehub/workbench/client";

/**
 * Network-condition injection at the product Client's public socketFactory
 * seam. Each direction of a real WebSocket is delayed by half the requested
 * RTT, so a request/response cycle over the socket observes the full RTT —
 * the same window/RTT dynamics a real slow link produces. Messages are never
 * inspected or rewritten; ordering per direction is preserved.
 */
export interface LatencyStats {
  sentMessages: number;
  sentBytes: number;
  receivedMessages: number;
  receivedBytes: number;
  /** Date.now() of the first inbound message delivered since resetStats(). */
  firstReceivedAtMs: number | null;
}

export interface LatencyInjector {
  readonly rttMs: number;
  socketFactory(url: string): WebSocketLike;
  resetStats(): void;
  stats(): LatencyStats;
  closeAll(): void;
}

function byteLengthOf(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return 0;
}

interface QueuedItem {
  data: unknown;
  due: number;
}

class DelayedSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  private readonly real: WebSocket;
  private readonly halfMs: number;
  private readonly jitterMs: number;
  private readonly statsSink: LatencyStats;
  private readonly inbound: QueuedItem[] = [];
  private readonly outbound: QueuedItem[] = [];
  private inboundTimer: NodeJS.Timeout | null = null;
  private outboundTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    url: string,
    halfMs: number,
    jitterMs: number,
    statsSink: LatencyStats,
    onClose: (socket: DelayedSocket) => void,
  ) {
    this.halfMs = halfMs;
    this.jitterMs = jitterMs;
    this.statsSink = statsSink;
    this.real = new WebSocket(url);
    this.real.on("open", () => this.onopen?.({}));
    // Close and error stay immediate: delaying them would let a dead path
    // look alive for half an RTT and would mask fail-close behavior.
    this.real.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      this.clearTimers();
      onClose(this);
      this.onclose?.({ code, reason: reason.toString() });
    });
    this.real.on("error", (error: Error) => this.onerror?.({ message: error.message }));
    this.real.on("message", (data: unknown) => {
      this.inbound.push({ data, due: this.due() });
      this.scheduleInbound();
    });
  }

  get readyState(): number {
    return this.real.readyState;
  }

  get binaryType(): string | undefined {
    return this.real.binaryType;
  }

  set binaryType(value: string | undefined) {
    if (value) this.real.binaryType = value as "arraybuffer";
  }

  get bufferedAmount(): number {
    return this.real.bufferedAmount + this.outbound.reduce((sum, item) => sum + byteLengthOf(item.data), 0);
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.closed) throw new Error("delayed socket is closed");
    this.outbound.push({ data, due: this.due() });
    this.scheduleOutbound();
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.real.close(code, reason);
  }

  private due(): number {
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    return Date.now() + this.halfMs + jitter;
  }

  private clearTimers(): void {
    if (this.inboundTimer) clearTimeout(this.inboundTimer);
    if (this.outboundTimer) clearTimeout(this.outboundTimer);
    this.inboundTimer = null;
    this.outboundTimer = null;
    this.inbound.length = 0;
    this.outbound.length = 0;
  }

  private scheduleInbound(): void {
    if (this.inboundTimer) return;
    const next = this.inbound[0];
    if (!next) return;
    this.inboundTimer = setTimeout(() => {
      this.inboundTimer = null;
      // Deliver every matured message in one tick: a real link hands over all
      // packets that have arrived, and draining one-per-tick would tax burst
      // traffic ~1ms per message — an artifact that drowns the product's own
      // behavior at low RTT.
      const now = Date.now();
      while (this.inbound.length > 0 && this.inbound[0]!.due <= now) {
        const item = this.inbound.shift()!;
        if (this.closed) return;
        this.statsSink.receivedMessages += 1;
        this.statsSink.receivedBytes += byteLengthOf(item.data);
        this.statsSink.firstReceivedAtMs ??= Date.now();
        this.onmessage?.({ data: item.data });
      }
      this.scheduleInbound();
    }, Math.max(0, next.due - Date.now()));
  }

  private scheduleOutbound(): void {
    if (this.outboundTimer) return;
    const next = this.outbound[0];
    if (!next) return;
    this.outboundTimer = setTimeout(() => {
      this.outboundTimer = null;
      const now = Date.now();
      while (this.outbound.length > 0 && this.outbound[0]!.due <= now) {
        const item = this.outbound.shift()!;
        if (this.closed) return;
        if (this.real.readyState === WebSocket.OPEN) {
          this.real.send(item.data as string | ArrayBuffer);
          this.statsSink.sentMessages += 1;
          this.statsSink.sentBytes += byteLengthOf(item.data);
        }
      }
      this.scheduleOutbound();
    }, Math.max(0, next.due - Date.now()));
  }
}

export function createLatencyInjector(input: { rttMs: number; jitterMs?: number }): LatencyInjector {
  if (!Number.isFinite(input.rttMs) || input.rttMs < 0 || input.rttMs > 5_000) {
    throw new RangeError(`unsupported injected RTT: ${input.rttMs}`);
  }
  const jitterMs = input.jitterMs ?? 0;
  if (jitterMs < 0 || jitterMs > input.rttMs) {
    throw new RangeError(`jitter ${jitterMs} must stay within [0, rtt]`);
  }
  const aggregate: LatencyStats = {
    sentMessages: 0,
    sentBytes: 0,
    receivedMessages: 0,
    receivedBytes: 0,
    firstReceivedAtMs: null,
  };
  const sockets = new Set<DelayedSocket>();
  return {
    rttMs: input.rttMs,
    socketFactory(url: string): WebSocketLike {
      const socket = new DelayedSocket(url, input.rttMs / 2, jitterMs, aggregate, (done) =>
        sockets.delete(done),
      );
      sockets.add(socket);
      return socket;
    },
    resetStats(): void {
      aggregate.sentMessages = 0;
      aggregate.sentBytes = 0;
      aggregate.receivedMessages = 0;
      aggregate.receivedBytes = 0;
      aggregate.firstReceivedAtMs = null;
    },
    stats(): LatencyStats {
      return { ...aggregate };
    },
    closeAll(): void {
      for (const socket of [...sockets]) socket.close();
      sockets.clear();
    },
  };
}

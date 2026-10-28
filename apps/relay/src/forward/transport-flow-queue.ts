import type { OutboundByteBudget } from "../shared/outbound-budget.js";
import { FABRIC_MAX_STREAM_CREDIT, type FabricFrame } from "./fabric-frame.js";

interface PendingFrame {
  readonly frame: FabricFrame;
  readonly charge: number;
  readonly release: () => void;
}
interface StreamQueue {
  readonly frames: PendingFrame[];
  bytes: number;
  running: boolean;
  cancelled: boolean;
}

/** Per-source, per-stream FIFO. A slow destination never pauses its siblings. */
export class TransportFlowQueue {
  private readonly streams = new Map<string, StreamQueue>();
  private bytes = 0;
  private records = 0;
  private closed = false;

  constructor(
    private readonly budget: OutboundByteBudget,
    private readonly forward: (frame: FabricFrame) => Promise<void>,
    private readonly overflow: (streamId: string) => void,
    private readonly failed: (frame: FabricFrame, error: unknown) => void,
  ) {}

  push(frame: FabricFrame, wireBytes: number): void {
    if (this.closed) return;
    const charge = Math.max(wireBytes, 1024);
    let queue = this.streams.get(frame.streamId);
    if (charge > FABRIC_MAX_STREAM_CREDIT - (queue?.bytes ?? 0)
      || charge > 8 * 1024 * 1024 - this.bytes || this.records >= 4096) {
      this.cancel(frame.streamId);
      this.overflow(frame.streamId);
      return;
    }
    const release = this.budget.reservePending(wireBytes);
    if (!release) {
      this.cancel(frame.streamId);
      this.overflow(frame.streamId);
      return;
    }
    if (!queue) {
      queue = { frames: [], bytes: 0, running: false, cancelled: false };
      this.streams.set(frame.streamId, queue);
    }
    queue.frames.push({ frame, charge, release });
    queue.bytes += charge;
    this.bytes += charge;
    this.records++;
    if (!queue.running) void this.drain(frame.streamId, queue);
  }

  cancel(streamId: string): void {
    const queue = this.streams.get(streamId);
    if (!queue) return;
    queue.cancelled = true;
    for (const pending of queue.frames.splice(0)) this.release(queue, pending);
    this.streams.delete(streamId);
  }

  close(): void {
    this.closed = true;
    for (const streamId of this.streams.keys()) this.cancel(streamId);
  }

  private release(queue: StreamQueue, pending: PendingFrame): void {
    queue.bytes -= pending.charge;
    this.bytes -= pending.charge;
    this.records--;
    pending.release();
  }

  private async drain(streamId: string, queue: StreamQueue): Promise<void> {
    queue.running = true;
    try {
      while (!queue.cancelled) {
        const pending = queue.frames.shift();
        if (!pending) break;
        // Transfer custody synchronously to sendFlow's socket reservation.
        this.release(queue, pending);
        try { await this.forward(pending.frame); }
        catch (error) { this.failed(pending.frame, error); break; }
      }
    } finally {
      // RST may already have removed this instance while its send was pending.
      if (this.streams.get(streamId) === queue) this.cancel(streamId);
    }
  }
}

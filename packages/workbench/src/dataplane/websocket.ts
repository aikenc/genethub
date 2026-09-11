import { MAX_DATA_FRAME_BYTES } from "./frame";
import type { RecordCarrier } from "./endpoint";

const SOCKET_BUFFER_HIGH_BYTES = 256 * 1024;
const SOCKET_BUFFER_LOW_BYTES = 128 * 1024;
const SOCKET_DRAIN_POLL_MS = 4;

export interface BinaryWebSocketLike {
  binaryType?: string;
  bufferedAmount?: number;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Ordered, message-preserving WebSocket adapter for secure records. */
export class WebSocketRecordCarrier implements RecordCarrier {
  private recordHandler: ((record: Uint8Array) => void) | null = null;
  private readonly closeHandlers = new Set<(reason?: unknown) => void>();
  private receiveTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly socket: BinaryWebSocketLike) {
    if ("binaryType" in socket) socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      this.receiveTail = this.receiveTail
        .then(async () => {
          const record = await binaryMessage(event.data);
          if (record.byteLength > MAX_DATA_FRAME_BYTES) {
            throw new Error("WebSocket data record exceeds 16 KiB");
          }
          this.recordHandler?.(record);
        })
        .catch((error: unknown) => this.fail(error));
    };
    socket.onerror = (error) => this.fail(error);
    socket.onclose = (event) => this.fail(event);
  }

  async send(record: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("WebSocket carrier is closed");
    if (record.byteLength > MAX_DATA_FRAME_BYTES) {
      throw new RangeError("WebSocket data record exceeds 16 KiB");
    }
    while (
      !this.closed &&
      (this.socket.bufferedAmount ?? 0) + record.byteLength >
        SOCKET_BUFFER_HIGH_BYTES
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, SOCKET_DRAIN_POLL_MS));
      while (
        !this.closed &&
        (this.socket.bufferedAmount ?? 0) > SOCKET_BUFFER_LOW_BYTES
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, SOCKET_DRAIN_POLL_MS));
      }
    }
    if (this.closed) throw new Error("WebSocket carrier is closed");
    this.socket.send(record);
  }

  onRecord(handler: (record: Uint8Array) => void): () => void {
    if (this.recordHandler) throw new Error("WebSocket carrier already has a reader");
    this.recordHandler = handler;
    return () => {
      if (this.recordHandler === handler) this.recordHandler = null;
    };
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(reason = "data endpoint closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, reason.slice(0, 123));
  }

  private fail(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler(reason);
  }
}

export async function binaryMessage(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError("the data-plane WebSocket accepts binary messages only");
}

import { MAX_DATA_FRAME_BYTES } from "./frame";

export type RecordReader = (record: Uint8Array) => void | Promise<void>;

/** Bounded ingress for message-based transports that cannot pause browser delivery.
 * One drain awaits the consumer instead of allocating a crypto Promise per event.
 * 8 MiB accommodates the 4 MiB logical grant plus secure-record overhead; the
 * minimum charge also bounds the number of tiny queued control records. */
export class RecordInbox {
  private records: Array<{ data: Uint8Array | Blob; charge: number } | undefined> = [];
  private head = 0;
  private bytes = 0;
  private draining = false;
  private closed = false;

  constructor(private readonly deliver: RecordReader, private readonly fail: (error: unknown) => void) {}

  push(value: unknown): void {
    if (this.closed) return;
    try {
      const size = value instanceof ArrayBuffer ? value.byteLength : ArrayBuffer.isView(value)
        ? value.byteLength : typeof Blob !== "undefined" && value instanceof Blob ? value.size : -1;
      if (size < 0 || size > MAX_DATA_FRAME_BYTES) throw new Error("invalid carrier record size or type");
      const charge = Math.max(64, size);
      if (this.bytes + charge > 8 * 1024 * 1024) throw new Error("carrier record inbox is full");
      const data = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) : value as Blob;
      this.records.push({ data, charge }); this.bytes += charge;
      if (!this.draining) void this.drain();
    } catch (error) { this.close(); this.fail(error); }
  }

  close(): void {
    this.closed = true; this.records = []; this.head = 0; this.bytes = 0;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.head < this.records.length) {
        const item = this.records[this.head]!;
        this.records[this.head++] = undefined; this.bytes -= item.charge;
        if (this.head >= 1024) { this.records = this.records.slice(this.head); this.head = 0; }
        const record = item.data instanceof Uint8Array ? item.data : new Uint8Array(await item.data.arrayBuffer());
        if (!this.closed) await this.deliver(record);
      }
    } catch (error) { this.close(); this.fail(error); }
    finally {
      this.draining = false;
      if (this.head === this.records.length) { this.records = []; this.head = 0; }
    }
  }
}

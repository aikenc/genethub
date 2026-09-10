import type { ChannelDirection, ChannelSessionKey } from "../devices/proof";
import { MAX_DATA_FRAME_BYTES, SECURE_RECORD_HEADER_BYTES } from "./frame";
import { openDataRecord, sealDataRecord } from "./secure";

export interface RecordCarrier {
  send(record: Uint8Array): void | Promise<void>;
  onRecord(handler: (record: Uint8Array) => void): () => void;
  onClose(handler: (reason?: unknown) => void): () => void;
  close(reason?: string): void;
}

/** One authenticated physical channel. Owns record counters and async crypto,
 * never streams, subscriptions or handlers. A replacement needs a fresh key
 * from a fresh handshake; callers cannot reset counters on a live channel.
 */
export class AuthenticatedChannel {
  private closed = false;
  private receiveBytes = 0;
  private sendBytes = 0;
  private receiveCount = 0;
  private sendCount = 0;
  private sendSequence = 0;
  private receiveSequence = 0;
  private receiveTail: Promise<void> = Promise.resolve();
  private transmitTail: Promise<void> = Promise.resolve();
  private readonly stopRecord: () => void;
  private readonly stopClose: () => void;

  constructor(private readonly options: {
    role: "client" | "server";
    carrier: RecordCarrier;
    key: ChannelSessionKey;
    onPlaintext(plaintext: Uint8Array): void;
    onClose(reason?: unknown): void;
    onError?(error: unknown): void;
  }) {
    this.stopRecord = options.carrier.onRecord((record) => this.receive(record));
    this.stopClose = options.carrier.onClose((reason) => this.close(reason));
  }

  send(plaintext: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("authenticated channel is closed"));
    if (plaintext.byteLength + SECURE_RECORD_HEADER_BYTES + 16 > MAX_DATA_FRAME_BYTES) {
      return Promise.reject(new RangeError("secure data record exceeds the 16 KiB wire limit"));
    }
    // The queue takes custody before the first await. The owner bounds its
    // outstanding writes; crypto sequencing must never retain a mutable view.
    if (this.sendBytes + plaintext.byteLength > 4 * 1024 * 1024 || this.sendCount >= 1024) {
      const error = new Error("authenticated channel write queue is full");
      this.fail(error);
      return Promise.reject(error);
    }
    this.sendBytes += plaintext.byteLength;
    this.sendCount++;
    const owned = plaintext.slice();
    const sent = this.transmitTail.then(async () => {
      this.requireOpen();
      const record = await sealDataRecord(
        this.options.key, this.outboundDirection(), ++this.sendSequence, owned,
      );
      // Closing during Web Crypto cannot send an old-channel record afterwards.
      this.requireOpen();
      await this.options.carrier.send(record);
      this.requireOpen();
    });
    this.transmitTail = sent.catch((error: unknown) => this.fail(error)).finally(() => {
      this.sendBytes -= owned.byteLength;
      this.sendCount--;
    });
    return sent;
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRecord();
    this.stopClose();
    try {
      this.options.carrier.close("authenticated channel closed");
    } finally {
      this.options.onClose(reason);
    }
  }

  private receive(record: Uint8Array): void {
    if (this.closed) return;
    if (record.byteLength < SECURE_RECORD_HEADER_BYTES + 16 || record.byteLength > MAX_DATA_FRAME_BYTES) {
      this.fail(new Error("invalid secure data record length"));
      return;
    }
    if (this.receiveBytes + record.byteLength > 4 * 1024 * 1024 || this.receiveCount >= 1024) {
      this.fail(new Error("authenticated channel read queue is full"));
      return;
    }
    this.receiveBytes += record.byteLength;
    this.receiveCount++;
    const owned = record.slice();
    const sequence = ++this.receiveSequence;
    this.receiveTail = this.receiveTail.then(async () => {
      if (this.closed) return;
      const plaintext = await openDataRecord(
        this.options.key, this.inboundDirection(), sequence, owned,
      );
      // In-flight decryption is not cancellable; its completion is fenced.
      if (!this.closed) this.options.onPlaintext(plaintext);
    }).catch((error: unknown) => this.fail(error)).finally(() => {
      this.receiveBytes -= owned.byteLength;
      this.receiveCount--;
    });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    try { this.options.onError?.(error); } catch { /* Observers do not own channel state. */ }
    this.close(error);
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("authenticated channel is closed");
  }

  private outboundDirection(): ChannelDirection {
    return this.options.role === "client" ? "client-to-daemon" : "daemon-to-client";
  }

  private inboundDirection(): ChannelDirection {
    return this.options.role === "client" ? "daemon-to-client" : "client-to-daemon";
  }
}

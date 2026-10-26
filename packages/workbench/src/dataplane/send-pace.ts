const FLOOR = 32 * 1024, CEILING = 3 * 1024 * 1024;

/** One physical channel's DATA debit. Only authenticated, current-epoch ACKs
 * return delivery credit; replacing a channel abandons its old ledger. */
export class SendPace {
  private readonly sent = new Map<bigint, { bytes: number; at: number }>();
  private outstanding = 0;
  private cap = FLOOR;
  private idleSince = performance.now();
  private sample: { began: number; bytes: number; acked: number } | null = null;

  canSend(bytes: number): boolean {
    if (!this.outstanding && performance.now() - this.idleSince >= 100) this.cap = FLOOR;
    if (this.outstanding + bytes <= this.cap) return true;
    this.sample ??= { began: this.sent.values().next().value?.at ?? performance.now(), bytes: this.outstanding, acked: 0 };
    return false;
  }

  record(seq: bigint, bytes: number): void {
    this.sent.set(seq, { bytes, at: performance.now() });
    this.outstanding += bytes;
  }

  acknowledge(received: bigint): void {
    let delivered = 0;
    for (const [seq, record] of this.sent) {
      if (seq > received) break;
      delivered += record.bytes; this.sent.delete(seq);
    }
    if (!delivered) return;
    this.outstanding -= delivered;
    const sample = this.sample;
    if (sample) {
      sample.acked += delivered;
      const elapsed = performance.now() - sample.began;
      if (elapsed > 900) {
        this.cap = Math.max(FLOOR, Math.min(this.cap, Math.floor(sample.acked * 900 / elapsed)));
        this.sample = null;
      } else if (sample.acked >= sample.bytes) {
        if (elapsed < 50) this.cap = CEILING;
        else if (elapsed <= 450 || this.cap < 128 * 1024) {
          // A long reverse ACK path may need more than the floor to fill its
          // BDP. Such slower discovery stays bounded at 128KiB.
          this.cap = Math.min(elapsed <= 450 ? CEILING : 128 * 1024, this.cap * 2);
        }
        this.sample = null;
      }
    }
    if (!this.outstanding) { this.idleSince = performance.now(); this.sample = null; }
  }
}

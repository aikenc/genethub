const FLOOR = 32 * 1024, CEILING = 3 * 1024 * 1024;

export type SendPaceDiagnostic = {
  phase: "send-pace"; cause: string; capBeforeBytes: number; capBytes: number;
  inFlightBytes: number; acknowledgedBytes: number; oldestAckAgeMs: number | null;
  sampleBytes: number | null; sampleAckedBytes: number | null; sampleElapsedMs: number | null;
};

/** One physical channel's DATA debit. Only authenticated, current-epoch ACKs
 * return delivery credit; replacing a channel abandons its old ledger. */
export class SendPace {
  private readonly sent = new Map<bigint, { bytes: number; at: number }>();
  private outstanding = 0;
  private cap = FLOOR;
  private idleSince = performance.now();
  private sample: { began: number; bytes: number; acked: number; firstAckAt: number | null; firstAckBytes: number } | null = null;
  private lastReported = -Infinity;

  constructor(private readonly observe?: (detail: SendPaceDiagnostic) => void) {}

  /** A new operation has no evidence that the previous burst's capacity
   * still exists. Retain all delivery debt and ages; relearn from this burst. */
  beginStream(): void {
    const before = this.cap;
    this.cap = FLOOR;
    this.sample = null;
    if (before !== this.cap) this.report("stream-start", before, 0, null, null, null);
  }

  canSend(bytes: number): boolean {
    const before = this.cap;
    if (!this.outstanding && performance.now() - this.idleSince >= 100) this.cap = FLOOR;
    if (before !== this.cap) this.report("idle-reset", before, 0, null, null, null);
    if (this.outstanding + bytes <= this.cap) return true;
    this.sample ??= { began: this.sent.values().next().value?.at ?? performance.now(), bytes: this.outstanding, acked: 0, firstAckAt: null, firstAckBytes: 0 };
    return false;
  }

  record(seq: bigint, bytes: number): void {
    this.sent.set(seq, { bytes, at: performance.now() });
    this.outstanding += bytes;
  }

  acknowledge(received: bigint): void {
    let delivered = 0;
    let oldestSentAt: number | null = null;
    const before = this.cap;
    for (const [seq, record] of this.sent) {
      if (seq > received) break;
      oldestSentAt = oldestSentAt === null ? record.at : Math.min(oldestSentAt, record.at);
      delivered += record.bytes; this.sent.delete(seq);
    }
    if (!delivered) return;
    this.outstanding -= delivered;
    const sample = this.sample;
    let elapsed: number | null = null, cause = "ack";
    if (sample) {
      sample.acked += delivered;
      const now = performance.now();
      if (sample.firstAckAt === null) { sample.firstAckAt = now; sample.firstAckBytes = delivered; }
      elapsed = performance.now() - sample.began;
      if (elapsed > 900) {
        cause = "late-ack";
        // A late first ACK measures round-trip delay, not delivery rate.
        // Retain this flight until it completes so its later ACKs measure
        // actual progress rather than repeatedly charging the same delay.
        const spacing = now - sample.firstAckAt;
        const progressed = sample.acked - sample.firstAckBytes;
        const fits = spacing > 0 && progressed > 0
          ? Math.floor(progressed * 900 / spacing)
          : Math.floor(this.cap / 2);
        this.cap = Math.max(FLOOR, Math.min(this.cap, fits));
        if (sample.acked >= sample.bytes) this.sample = null;
      } else if (sample.acked >= sample.bytes) {
        cause = "window-complete";
        if (elapsed < 50) this.cap = CEILING;
        else if (elapsed <= 450 || this.cap < 256 * 1024) {
          // A long reverse ACK path may need more than the floor to fill its
          // BDP. Such slower discovery stays bounded at 256KiB.
          this.cap = Math.min(elapsed <= 450 ? CEILING : 256 * 1024, this.cap * 2);
        }
        this.sample = null;
      }
    }
    if (!this.outstanding) { this.idleSince = performance.now(); this.sample = null; }
    this.report(cause, before, delivered, oldestSentAt, sample, elapsed);
  }

  private report(cause: string, before: number, delivered: number, oldest: number | null,
    sample: { bytes: number; acked: number } | null, elapsed: number | null): void {
    if (!this.observe) return;
    const now = performance.now();
    if (now - this.lastReported < 250) return;
    this.lastReported = now;
    try {
      this.observe({ phase: "send-pace", cause, capBeforeBytes: before, capBytes: this.cap,
        inFlightBytes: this.outstanding, acknowledgedBytes: delivered,
        oldestAckAgeMs: oldest === null ? null : Math.round(now - oldest),
        sampleBytes: sample?.bytes ?? null, sampleAckedBytes: sample?.acked ?? null,
        sampleElapsedMs: elapsed === null ? null : Math.round(elapsed) });
    } catch { /* Read-only diagnostics never own delivery or pacing. */ }
  }
}

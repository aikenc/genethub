const FLOOR = 32 * 1024, CEILING = 3 * 1024 * 1024, SMALL_CUSTODY = 16 * 1024;

export type SendPaceDiagnostic = {
  phase: "send-pace"; cause: string; capBeforeBytes: number; capBytes: number;
  inFlightBytes: number; acknowledgedBytes: number; oldestAckAgeMs: number | null;
  sampleBytes: number | null; sampleAckedBytes: number | null; sampleElapsedMs: number | null;
};

/** One physical channel's DATA debit. Only authenticated, current-epoch ACKs
 * return delivery credit; replacing a channel abandons its old ledger. */
export class SendPace {
  private readonly sent = new Map<bigint, { bytes: number; at: number; control: boolean }>();
  private outstanding = 0;
  private controlOutstanding = 0;
  private cap = FLOOR;
  private idleSince = performance.now();
  private minimumAckAge = Infinity;
  private sample: { began: number; bytes: number; acked: number; firstAckAt: number | null; firstAckBytes: number; maxAckAge: number; admittedCap: number; latestFit: number | null; late: boolean } | null = null;
  private lastReported = -Infinity;
  private interactive = false;

  constructor(private readonly observe?: (detail: SendPaceDiagnostic) => void) {}

  /** A new operation has no evidence that the previous burst's capacity
   * still exists. Retain all delivery debt and ages; relearn from this burst. */
  beginStream(): void {
    const before = this.cap;
    this.interactive = false;
    this.minimumAckAge = Infinity;
    this.cap = FLOOR;
    this.sample = null;
    if (before !== this.cap) this.report("stream-start", before, 0, null, null, null);
  }

  /** Small operations observed in this bulk burst keep slow probes latency-bound. */
  noteInteractive(): void { this.interactive = true; }

  canSend(bytes: number, control = false): boolean {
    if (control) return this.controlOutstanding + bytes <= SMALL_CUSTODY;
    const before = this.cap, bulk = this.outstanding - this.controlOutstanding;
    if (!bulk && performance.now() - this.idleSince >= 100) this.cap = FLOOR;
    if (before !== this.cap) this.report("idle-reset", before, 0, null, null, null);
    if (this.outstanding + bytes <= this.cap) return true;
    if (bulk && !this.sample) {
      this.sample = { began: performance.now(), bytes: bulk, acked: 0, firstAckAt: null, firstAckBytes: 0, maxAckAge: 0,
        admittedCap: this.cap, latestFit: null, late: false };
    }
    return false;
  }

  record(seq: bigint, bytes: number, control = false): void {
    this.sent.set(seq, { bytes, at: performance.now(), control });
    this.outstanding += bytes;
    if (control) this.controlOutstanding += bytes;
  }

  acknowledge(received: bigint): void {
    let delivered = 0;
    let oldestSentAt: number | null = null;
    const before = this.cap;
    for (const [seq, record] of this.sent) {
      if (seq > received) break;
      this.outstanding -= record.bytes;
      if (record.control) this.controlOutstanding -= record.bytes;
      else {
        this.minimumAckAge = Math.min(this.minimumAckAge, performance.now() - record.at);
        oldestSentAt = oldestSentAt === null ? record.at : Math.min(oldestSentAt, record.at);
        delivered += record.bytes;
      }
      this.sent.delete(seq);
    }
    if (!delivered) return;
    const sample = this.sample;
    let elapsed: number | null = null, cause = "ack";
    if (sample) {
      sample.acked += delivered;
      const now = performance.now();
      if (sample.firstAckAt === null) { sample.firstAckAt = now; sample.firstAckBytes = delivered; }
      sample.maxAckAge = Math.max(sample.maxAckAge, oldestSentAt === null ? 0 : now - oldestSentAt);
      elapsed = Math.max(now - sample.began, sample.maxAckAge);
      const slowCap = (this.interactive ? 96 : 256) * 1024;
      const spacing = now - sample.firstAckAt, progressed = sample.acked - sample.firstAckBytes;
      // Estimate a flight's bandwidth-delay product plus a short queue,
      // rather than allowing 900ms of serialization on a slow link.
      const target = Math.min(900, this.minimumAckAge + 200);
      const fits = spacing >= 50 && progressed > 0 ? Math.floor(progressed * target / spacing) : null;
      if (fits !== null) {
        sample.latestFit = fits;
        sample.firstAckAt = now; sample.firstAckBytes = sample.acked;
      }
      if (elapsed > 900) {
        cause = "late-ack";
        // A paused ACK clock is not proof of new capacity. Shrink first;
        // a completed flight needs measured progress and bounded delay
        // before restoring or probing a larger bounded budget.
        if (fits !== null) this.cap = Math.max(FLOOR, Math.min(this.cap, fits));
        else if (!sample.late) this.cap = Math.max(FLOOR, Math.min(slowCap, Math.floor(this.cap / 2)));
        sample.late = true;
        if (sample.acked >= sample.bytes) {
          if (sample.latestFit !== null) {
            // A high-RTT path may exceed 900ms without excessive queueing.
            // Only a COMPLETE delivered flight may probe from real spaced
            // ACK throughput, and only while its excess over the shortest
            // actual timely DATA ACK age stays bounded. The first stalled
            // ACK cannot establish that baseline. A held/compressed ACK flight
            // retains its original ages and cannot supply this evidence.
            const limit = this.minimumAckAge <= 900 && sample.maxAckAge - this.minimumAckAge <= 900 ? slowCap : Math.min(sample.admittedCap, slowCap);
            this.cap = Math.max(FLOOR, Math.min(limit, sample.latestFit));
          }
          this.sample = null;
        }
      } else if (sample.acked >= sample.bytes) {
        cause = "window-complete";
        if (elapsed < 50) this.cap = CEILING;
        else if (elapsed <= 450 || this.cap < slowCap) {
          // A long reverse ACK path may need more than the floor to fill its
          // BDP. Slow discovery stays bounded at 256KiB, or 96KiB
          // once small operations share this bulk burst.
          // A complete timely flight can also use its real ACK spacing to
          // probe a high-RTT path without repeating floor-sized slow starts.
          // Once rate evidence exists, doubling must not override the
          // measured latency budget on a weak path.
          const probe = sample.latestFit === null ? this.cap * 2 : Math.max(FLOOR, sample.latestFit);
          this.cap = Math.min(elapsed <= 450 ? CEILING : slowCap, probe);
        }
        this.sample = null;
      }
    }
    if (this.outstanding === this.controlOutstanding) { this.idleSince = performance.now(); this.sample = null; }
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

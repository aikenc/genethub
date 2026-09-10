import { logicalAttachProof, randomNonce, type ChannelSessionKey } from "../devices/proof";
import { AuthenticatedChannel, type RecordCarrier } from "./authenticated-channel";
import { ResumeJournal, ResumeError, encodeResumeControl, type ResumeFrame, type ResumeWatermark } from "./resume";

const LIMITS = { dataBytes: 4 * 1024 * 1024, progressBytes: 64 * 1024 };
type Position = { received: string; dataGrant: string; progressGrant: string };
type Credentials = { id: string; incarnation: string; secret: string };
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
function counter(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("invalid logical counter");
  const n = BigInt(value); if (n > (1n << 64n) - 1n) throw new Error("logical counter overflow"); return n;
}
function position(value: ResumeWatermark): Position { return { received: String(value.received), dataGrant: String(value.dataGrant), progressGrant: String(value.progressGrant) }; }
function watermark(value: unknown): ResumeWatermark {
  if (!value || typeof value !== "object") throw new Error("invalid logical position");
  if (Object.keys(value).length !== 3 || !["received", "dataGrant", "progressGrant"].every((key) => Object.hasOwn(value, key))) throw new Error("invalid logical position fields");
  const p = value as Position; return { received: counter(p.received), dataGrant: counter(p.dataGrant), progressGrant: counter(p.progressGrant) };
}
function encode(message: Record<string, unknown>): Uint8Array {
  const json = encoder.encode(JSON.stringify(message));
  if (json.length > 8188) throw new Error("logical control too large");
  const bytes = new Uint8Array(4 + json.length); bytes.set([4, 16, 0, 0]); bytes.set(json, 4); return bytes;
}
function decode(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length < 5 || bytes.length > 8192 || bytes[0] !== 4 || bytes[1] !== 16 || bytes[2] || bytes[3]) throw new Error("invalid logical control");
  const message: unknown = JSON.parse(decoder.decode(bytes.subarray(4)));
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid logical control");
  const m = message as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = {
    create: ["policy", "resumable"], created: ["id", "incarnation", "secret"],
    attach: ["id", "incarnation", "attempt", "proof"], attached: ["epoch"],
    activate: ["attempt", "expected", "position"], activated: ["epoch", "position"],
    sync: ["epoch"], synced: ["epoch"], close: [], ping: ["nonce"], pong: ["nonce"], error: ["code"],
  };
  if (typeof m.op !== "string" || !Object.hasOwn(fields, m.op) ||
      Object.keys(m).some((key) => key !== "op" && !fields[m.op as string]!.includes(key)) ||
      fields[m.op]!.some((key) => !Object.hasOwn(m, key))) throw new Error("invalid logical control fields");
  return m;
}

/** Stream and journal ownership survive carrier replacement. A new carrier
 * always supplies a freshly authenticated key; recovery credentials live only
 * in this object and are never persisted or exposed by diagnostics. */
export class LogicalConnection {
  private readonly journal = new ResumeJournal("relay-allowed", LIMITS);
  private channel: AuthenticatedChannel | null = null;
  private generation = 0;
  private epoch = 0n;
  private credentials: Credentials | null = null;
  private attempt = "";
  private expectedEpoch = 0n;
  private phase: "created" | "attached" | "activated" | "synced" | "ready" | "closed" = "created";
  private readonly waiters = new Set<() => void>();
  private readonly ackWaiters = new Map<bigint, { resolve(): void; reject(error: unknown): void }>();
  private readonly started = performance.now();
  private deadline: number | null = null;
  private lastReceive = 0;
  private lastPing = 0;
  private ack = false;
  private budget = false;
  private pumping = false;
  private pumpRequested = false;
  private terminal: unknown = null;
  private pendingCount = 0;
  private pendingData = 0;
  private pendingProgress = 0;
  private inbox: Promise<void> = Promise.resolve();
  private inboxBytes = 0;
  private inboxCount = 0;
  private readonly clock: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    role: "client" | "server";
    carrier: RecordCarrier;
    key: ChannelSessionKey;
    onFrame(frame: ResumeFrame, release: () => void): void;
    onClose(error: unknown): void;
    onRecovering?(): void;
    onReady?(): void;
  }) {
    this.clock = setInterval(() => this.tick(), 100);
    this.attach(options.carrier, options.key);
  }
  get state(): "connecting" | "ready" | "recovering" | "closed" {
    return this.phase === "closed" ? "closed" : this.phase === "ready" ? "ready" : this.epoch ? "recovering" : "connecting";
  }
  get id(): string | null { return this.credentials?.id ?? null; }
  async ready(): Promise<void> {
    while (this.state !== "ready") { this.live(); await this.changed(); }
  }
  attach(carrier: RecordCarrier, key: ChannelSessionKey): void {
    this.live();
    if (key.context !== this.options.key.context) throw new Error("logical principal changed");
    const generation = ++this.generation;
    const previous = this.channel;
    this.channel = null;
    previous?.close("channel replaced");
    this.phase = this.options.role === "client" ? (this.credentials ? "attached" : "created") : "created";
    this.attempt = randomNonce();
    this.lastReceive = this.now();
    const channel = new AuthenticatedChannel({ role: this.options.role, carrier, key,
      onPlaintext: (bytes) => {
        if (generation !== this.generation) return;
        if (this.inboxBytes + bytes.length > LIMITS.dataBytes || this.inboxCount >= 1024) { this.close(new Error("logical inbox exhausted")); return; }
        this.inboxBytes += bytes.length; this.inboxCount++;
        this.inbox = this.inbox.then(async () => {
          if (generation === this.generation && this.state !== "closed") await this.receive(bytes, key, generation);
        }).catch((error: unknown) => { if (generation === this.generation) this.close(error); }).finally(() => { this.inboxBytes -= bytes.length; this.inboxCount--; });
      },
      onClose: () => { if (generation === this.generation) this.suspend(); },
      onError: (error, source) => { if (generation === this.generation) { if (source === "receive") this.close(error); else this.suspend(); } },
    });
    this.channel = channel;
    if (this.options.role === "client") {
      void (this.credentials ? this.sendAttach(key, generation) : this.control({ op: "create", policy: "relay-allowed", resumable: true }))
        .catch(() => { if (generation === this.generation) this.suspend(); });
    }
  }
  async send(frame: ResumeFrame): Promise<void> {
    this.live();
    const progress = frame.kind >= 4, bytes = frame.payload.length + 36;
    if (this.pendingCount >= 256 || (progress ? this.pendingProgress + bytes > LIMITS.progressBytes : this.pendingData + bytes > LIMITS.dataBytes)) throw new ResumeError("Backpressure");
    this.pendingCount++;
    if (progress) this.pendingProgress += bytes; else this.pendingData += bytes;
    try { await this.sendOwned(frame); }
    finally { this.pendingCount--; if (progress) this.pendingProgress -= bytes; else this.pendingData -= bytes; }
  }
  private async sendOwned(frame: ResumeFrame): Promise<void> {
    let seq: bigint;
    // The stream scheduler bounds all pending calls and owns the payload.
    for (;;) {
      this.live();
      try { seq = this.journal.enqueue(frame); break; }
      catch (error) { if (!(error instanceof ResumeError) || error.code !== "Backpressure") throw error; await this.changed(); }
    }
    let acknowledged: Promise<void> | null = null;
    if (frame.kind === 5 || frame.kind === 6) {
      acknowledged = new Promise<void>((resolve, reject) => this.ackWaiters.set(seq, { resolve, reject }));
    }
    this.pump();
    // FIN/RESET remain owned until acknowledgement; stream retirement cannot
    // make a terminal replay depend on an already-dropped stream object.
    if (acknowledged) await acknowledged;
  }
  close(error: unknown = new Error("logical connection closed")): void {
    if (this.phase === "closed") return;
    const channel = this.channel;
    this.phase = "closed"; this.terminal = error; this.generation++; this.channel = null;
    clearInterval(this.clock);
    this.journal.close(); this.credentials = null;
    for (const waiter of this.ackWaiters.values()) waiter.reject(error);
    this.ackWaiters.clear(); this.wake();
    if (channel) {
      // Let the peer authenticate CLOSE before tearing down its physical
      // reader. The transport remains bounded and is reclaimed on a deadline.
      void channel.send(encode({ op: "close" })).catch(() => channel.close());
      setTimeout(() => channel.close(), 1000);
    }
    this.options.onClose(error);
  }
  private async sendAttach(key: ChannelSessionKey, generation: number): Promise<void> {
    const credential = this.credentials!;
    const proof = await logicalAttachProof(key, credential.secret, credential.id, credential.incarnation, this.attempt);
    if (generation !== this.generation) return;
    this.phase = "attached";
    await this.control({ op: "attach", id: credential.id, incarnation: credential.incarnation, attempt: this.attempt, proof });
  }
  private async receive(bytes: Uint8Array, key: ChannelSessionKey, generation: number): Promise<void> {
    this.lastReceive = this.now();
    if (bytes[1] === 16) {
      const m = decode(bytes);
      if (m.op === "close" || m.op === "error") throw new Error(typeof m.code === "string" ? m.code : "logical peer closed");
      if (m.op === "ping" && typeof m.nonce === "string" && m.nonce.length <= 32) { await this.control({ op: "pong", nonce: m.nonce }); return; }
      if (m.op === "pong") return;
      if (this.options.role === "server") { await this.receiveServer(m, key, generation); return; }
      if (m.op === "created" && this.phase === "created" && !this.credentials) {
        for (const value of [m.id, m.incarnation, m.secret]) if (typeof value !== "string" || !/^[0-9a-f]{32,64}$/.test(value)) throw new Error("invalid logical credentials");
        this.credentials = { id: m.id as string, incarnation: m.incarnation as string, secret: m.secret as string };
        await this.sendAttach(key, generation); return;
      }
      if (m.op === "attached" && this.phase === "attached") {
        const expected = counter(m.epoch);
        if (expected < this.epoch) throw new Error("logical state lost");
        this.expectedEpoch = expected + 1n;
        this.phase = "activated";
        await this.control({ op: "activate", attempt: this.attempt, expected: String(expected), position: position(this.journal.watermark) }); return;
      }
      if (m.op === "activated" && this.phase === "activated") {
        const epoch = counter(m.epoch);
        if (epoch !== this.expectedEpoch) throw new Error("activation epoch mismatch");
        this.activate(epoch, watermark(m.position));
        this.epoch = epoch; this.phase = "synced";
        await this.control({ op: "sync", epoch: String(epoch) }); return;
      }
      if (m.op === "synced" && this.phase === "synced" && counter(m.epoch) === this.epoch) { this.markReady(); return; }
      throw new Error("invalid logical admission transition");
    }
    if (this.phase !== "ready") throw new Error("logical payload before SYNC");
    if (bytes[1] === 1) {
      const received = this.journal.receive(bytes);
      if (received) {
        let released = false;
        this.options.onFrame(received.frame, () => {
          if (released) return; released = true;
          if (this.state === "closed") return;
          this.journal.release(received.seq); this.budget = true; this.pump();
        });
      }
      this.ack = true;
    } else {
      this.journal.receiveControl(bytes);
      if (bytes[1] === 2 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(4) === this.epoch) {
        const acknowledged = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(12);
        this.acknowledgeTerminals(acknowledged);
      }
      this.wake();
    }
    this.pump();
  }
  private async receiveServer(m: Record<string, unknown>, key: ChannelSessionKey, generation: number): Promise<void> {
    if (m.op === "create" && this.phase === "created" && !this.credentials && m.policy === "relay-allowed") {
      this.credentials = { id: randomNonce(), incarnation: randomNonce(), secret: randomNonce() };
      await this.control({ op: "created", ...this.credentials }); return;
    }
    if (m.op === "attach" && this.phase === "created" && this.credentials && m.id === this.credentials.id && m.incarnation === this.credentials.incarnation && typeof m.attempt === "string" && /^[a-f0-9]{32}$/.test(m.attempt)) {
      const expected = await logicalAttachProof(key, this.credentials.secret, this.credentials.id, this.credentials.incarnation, m.attempt);
      if (generation !== this.generation) return;
      if (m.proof !== expected) throw new Error("logical attachment rejected");
      this.attempt = m.attempt; this.phase = "activated";
      await this.control({ op: "attached", epoch: String(this.epoch) }); return;
    }
    if (m.op === "activate" && this.phase === "activated" && m.attempt === this.attempt && counter(m.expected) === this.epoch) {
      const epoch = this.epoch + 1n;
      this.activate(epoch, watermark(m.position)); this.epoch = epoch; this.phase = "synced";
      await this.control({ op: "activated", epoch: String(epoch), position: position(this.journal.watermark) }); return;
    }
    if (m.op === "sync" && this.phase === "synced" && counter(m.epoch) === this.epoch) {
      await this.control({ op: "synced", epoch: String(this.epoch) }); this.markReady(); return;
    }
    throw new Error("invalid logical server transition");
  }
  private activate(epoch: bigint, peer: ResumeWatermark): void {
    this.journal.activate("loopback", epoch, peer, this.now());
    // A committed peer watermark is an acknowledgement too. Do not require a
    // redundant regular ACK to finish a terminal already received before loss.
    this.acknowledgeTerminals(peer.received);
    this.wake();
  }
  private acknowledgeTerminals(received: bigint): void {
    for (const [seq, waiter] of this.ackWaiters) {
      if (seq <= received) { waiter.resolve(); this.ackWaiters.delete(seq); }
    }
  }
  private markReady(): void {
    this.phase = "ready"; this.deadline = null; this.ack = true; this.budget = true;
    this.wake(); this.pump(); this.options.onReady?.();
  }
  private pump(): void {
    this.pumpRequested = true;
    if (this.pumping || this.phase !== "ready" || !this.channel) return;
    this.pumping = true;
    this.pumpRequested = false;
    const channel = this.channel, generation = this.generation;
    void (async () => {
      while (this.phase === "ready" && generation === this.generation) {
        const mark = this.journal.watermark;
        let bytes: Uint8Array | null;
        if (this.ack) { this.ack = false; bytes = encodeResumeControl({ kind: "ack", epoch: this.epoch, received: mark.received }); }
        else if (this.budget) { this.budget = false; bytes = encodeResumeControl({ kind: "budget", epoch: this.epoch, dataGrant: mark.dataGrant, progressGrant: mark.progressGrant }); }
        else bytes = this.journal.next();
        if (!bytes) return;
        await channel.send(bytes);
      }
    })().catch(() => { if (generation === this.generation) this.suspend(); }).finally(() => {
      this.pumping = false;
      if (this.phase === "ready" && (this.pumpRequested || this.ack || this.budget || generation !== this.generation)) this.pump();
    });
  }
  private control(message: Record<string, unknown>): Promise<void> {
    if (!this.channel) return Promise.reject(new Error("logical channel unavailable"));
    return this.channel.send(encode(message));
  }
  private suspend(): void {
    if (this.phase === "closed") return;
    const channel = this.channel; this.channel = null; this.generation++;
    channel?.close();
    if (this.deadline === null) this.deadline = this.now() + 60_000;
    if (this.epoch) this.journal.suspend(this.now());
    this.phase = "attached"; this.wake(); this.options.onRecovering?.();
  }
  private tick(): void {
    if (this.phase === "closed") return;
    try {
      const now = this.now();
      if (this.deadline !== null && now >= this.deadline) throw new Error("ResumeExpired");
      if (!this.epoch && now >= 60_000) throw new Error("logical admission timed out");
      this.journal.tick(now);
      if (this.channel && now - this.lastReceive >= 15_000) this.suspend();
      else if (this.channel && this.phase === "ready" && now - this.lastPing >= 5_000) {
        this.lastPing = now; void this.control({ op: "ping", nonce: randomNonce() }).catch(() => this.suspend());
      }
    } catch (error) { this.close(error); }
  }
  private now(): number { return Math.floor(performance.now() - this.started); }
  private changed(): Promise<void> { return new Promise((resolve) => this.waiters.add(resolve)); }
  private wake(): void { const waiters = [...this.waiters]; this.waiters.clear(); for (const wake of waiters) wake(); }
  private live(): void { if (this.phase === "closed") throw this.terminal; }
}

import { logicalAttachProof, logicalAttachedProof, randomNonce, type ChannelSessionKey } from "../devices/proof";
import { AuthenticatedChannel, type RecordCarrier } from "./authenticated-channel";
import { ResumeJournal, ResumeError, encodeResumeControl, type ResumeFrame, type ResumeWatermark, type ResumePath, type ResumePolicy } from "./resume";

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
    attach: ["id", "incarnation", "attempt", "proof"], attached: ["epoch", "proof"],
    activate: ["attempt", "expected", "position"], activated: ["epoch", "position"],
    sync: ["epoch"], synced: ["epoch"], close: [], ping: ["nonce"], pong: ["nonce"], error: ["code"],
  };
  if (typeof m.op !== "string" || !Object.hasOwn(fields, m.op) ||
      Object.keys(m).some((key) => key !== "op" && !fields[m.op as string]!.includes(key)) ||
      fields[m.op]!.some((key) => !Object.hasOwn(m, key))) throw new Error("invalid logical control fields");
  return m;
}

type Phase = "created" | "attached" | "activated" | "synced" | "ready" | "quiesced";
interface Channel {
  wire: AuthenticatedChannel;
  key: ChannelSessionKey;
  path: ResumePath;
  phase: Phase;
  attempt: string;
  expected: bigint;
  committed: boolean;
  lastReceive: number;
  resolve(): void;
  reject(error: unknown): void;
}

/** One stream owner with one active channel and at most one prepared candidate.
 * Recovery credentials prove both peers across fresh carrier authentication. */
export class LogicalConnection {
  private readonly journal: ResumeJournal;
  private active: Channel | null = null;
  private candidate: Channel | null = null;
  private epoch = 0n;
  private credentials: Credentials | null = null;
  private closed = false;
  private readonly waiters = new Set<() => void>();
  private readonly ackWaiters = new Map<bigint, { resolve(): void; reject(error: unknown): void }>();
  private readonly started = performance.now();
  private deadline: number | null = null;
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
    policy?: ResumePolicy;
    path?: ResumePath;
    onFrame(frame: ResumeFrame, release: () => void): void;
    onClose(error: unknown): void;
    onRecovering?(): void;
    onReady?(): void;
  }) {
    this.journal = new ResumeJournal(options.policy ?? "relay-allowed", LIMITS);
    this.clock = setInterval(() => this.tick(), 100);
    void this.attach(options.carrier, options.key, options.path ?? "loopback").catch(() => {});
  }
  get state(): "connecting" | "ready" | "recovering" | "closed" {
    return this.closed ? "closed" : this.active?.phase === "ready" ? "ready" : this.epoch ? "recovering" : "connecting";
  }
  get path(): ResumePath | null { return this.active?.phase === "ready" ? this.active.path : null; }
  get id(): string | null { return this.credentials?.id ?? null; }
  async ready(): Promise<void> {
    while (this.state !== "ready") { this.live(); await this.changed(); }
  }
  attach(carrier: RecordCarrier, key: ChannelSessionKey, path: ResumePath = "loopback"): Promise<void> {
    this.live();
    if (this.candidate) return Promise.reject(new Error("logical candidate already pending"));
    if (this.journal.policy === "direct-only" && path === "fabric") return Promise.reject(new ResumeError("PolicyDenied"));
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const channel: Channel = { key, path, phase: "created", attempt: randomNonce(), expected: 0n, committed: false,
      lastReceive: this.now(), resolve, reject, wire: null! };
    this.candidate = channel;
    channel.wire = new AuthenticatedChannel({ role: this.options.role, carrier, key,
      onPlaintext: (bytes) => {
        if (!this.owns(channel)) return;
        if (this.inboxBytes + bytes.length > LIMITS.dataBytes || this.inboxCount >= 1024) { this.failed(channel, new Error("logical inbox exhausted")); return; }
        this.inboxBytes += bytes.length; this.inboxCount++;
        this.inbox = this.inbox.then(async () => { if (this.owns(channel)) await this.receive(bytes, channel); })
          .catch((error: unknown) => { if (this.owns(channel)) this.failed(channel, error); })
          .finally(() => { this.inboxBytes -= bytes.length; this.inboxCount--; });
      },
      onClose: (reason) => this.lost(channel, reason ?? new Error("physical channel closed")),
      onError: (error, source) => { if (source === "receive") this.failed(channel, error); else this.lost(channel, error); },
    });
    if (this.options.role === "client") {
      void (this.credentials ? this.sendAttach(channel) : this.control(channel, { op: "create", policy: this.journal.policy, resumable: true }))
        .catch((error: unknown) => this.lost(channel, error));
    }
    return ready;
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
    for (;;) {
      this.live();
      try { seq = this.journal.enqueue(frame); break; }
      catch (error) { if (!(error instanceof ResumeError) || error.code !== "Backpressure") throw error; await this.changed(); }
    }
    let acknowledged: Promise<void> | null = null;
    if (frame.kind === 5 || frame.kind === 6) acknowledged = new Promise<void>((resolve, reject) => this.ackWaiters.set(seq, { resolve, reject }));
    this.pump();
    if (acknowledged) await acknowledged;
  }
  close(error: unknown = new Error("logical connection closed")): void {
    if (this.closed) return;
    this.closed = true; this.terminal = error;
    const active = this.active, candidate = this.candidate;
    this.active = null; this.candidate = null;
    clearInterval(this.clock);
    this.journal.close(); this.credentials = null;
    for (const waiter of this.ackWaiters.values()) waiter.reject(error);
    this.ackWaiters.clear(); this.wake();
    if (candidate && candidate !== active) { candidate.reject(error); candidate.wire.close(); }
    if (active) {
      active.reject(error);
      void active.wire.send(encode({ op: "close" })).catch(() => active.wire.close());
      setTimeout(() => active.wire.close(), 1000);
    }
    this.options.onClose(error);
  }
  private async sendAttach(channel: Channel): Promise<void> {
    const credential = this.credentials!;
    const proof = await logicalAttachProof(channel.key, credential.secret, credential.id, credential.incarnation, channel.attempt);
    if (!this.owns(channel)) return;
    channel.phase = "attached";
    await this.control(channel, { op: "attach", id: credential.id, incarnation: credential.incarnation, attempt: channel.attempt, proof });
  }
  private async receive(bytes: Uint8Array, channel: Channel): Promise<void> {
    channel.lastReceive = this.now();
    // Once ACTIVATE is sent, old records cannot move the snapshot used by it.
    if (channel.phase === "quiesced") return;
    if (bytes[1] === 16) {
      const m = decode(bytes);
      if (m.op === "error" && m.code === "SessionLost") {
        // An authenticated peer explicitly lost this logical session (e.g. daemon restart).
        // End its old streams; the Client may establish a fresh owner and resync subscriptions.
        this.close(new Error("SessionLost")); return;
      }
      if (m.op === "close" || m.op === "error") throw new Error(typeof m.code === "string" ? m.code : "logical peer closed");
      if (m.op === "ping" && typeof m.nonce === "string" && m.nonce.length <= 32) { await this.control(channel, { op: "pong", nonce: m.nonce }); return; }
      if (m.op === "pong") return;
      if (this.options.role === "server") { await this.receiveServer(m, channel); return; }
      if (channel !== this.candidate) throw new Error("control on non-candidate channel");
      if (m.op === "created" && channel.phase === "created" && !this.credentials) {
        for (const value of [m.id, m.incarnation, m.secret]) if (typeof value !== "string" || !/^[0-9a-f]{32,64}$/.test(value)) throw new Error("invalid logical credentials");
        this.credentials = { id: m.id as string, incarnation: m.incarnation as string, secret: m.secret as string };
        await this.sendAttach(channel); return;
      }
      if (m.op === "attached" && channel.phase === "attached") {
        const expected = counter(m.epoch), c = this.credentials!;
        if (expected < this.epoch) throw new Error("logical state lost");
        const proof = await logicalAttachedProof(channel.key, c.secret, c.id, c.incarnation, channel.attempt, expected);
        if (!this.owns(channel)) return;
        if (m.proof !== proof) throw new Error("logical server possession rejected");
        channel.expected = expected + 1n; channel.phase = "activated";
        // From this point a lost response is ambiguous: never return to the old epoch.
        channel.committed = true;
        if (this.active) this.active.phase = "quiesced";
        await this.control(channel, { op: "activate", attempt: channel.attempt, expected: String(expected), position: position(this.journal.watermark) }); return;
      }
      if (m.op === "activated" && channel.phase === "activated") {
        const epoch = counter(m.epoch);
        if (epoch !== channel.expected) throw new Error("activation epoch mismatch");
        this.activate(channel, epoch, watermark(m.position));
        await this.control(channel, { op: "sync", epoch: String(epoch) }); return;
      }
      if (m.op === "synced" && channel.phase === "synced" && counter(m.epoch) === this.epoch) { this.markReady(channel); return; }
      throw new Error("invalid logical admission transition");
    }
    if (channel !== this.active || channel.phase !== "ready") throw new Error("logical payload before SYNC");
    if (bytes[1] === 1) {
      const received = this.journal.receive(bytes);
      if (received) {
        let released = false;
        this.options.onFrame(received.frame, () => {
          if (released) return; released = true;
          if (this.closed) return;
          this.journal.release(received.seq); this.budget = true; this.pump();
        });
      }
      this.ack = true;
    } else {
      this.journal.receiveControl(bytes);
      if (bytes[1] === 2 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(4) === this.epoch) {
        this.acknowledgeTerminals(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(12));
      }
      this.wake();
    }
    this.pump();
  }
  private async receiveServer(m: Record<string, unknown>, channel: Channel): Promise<void> {
    if (channel !== this.candidate) throw new Error("unexpected logical server control");
    if (m.op === "create" && channel.phase === "created" && !this.credentials && m.policy === this.journal.policy && typeof m.resumable === "boolean") {
      this.credentials = { id: randomNonce(), incarnation: randomNonce(), secret: randomNonce() };
      await this.control(channel, { op: "created", ...this.credentials }); return;
    }
    if (m.op === "attach" && channel.phase === "created" && this.credentials && m.id === this.credentials.id && m.incarnation === this.credentials.incarnation && typeof m.attempt === "string" && /^[a-f0-9]{32}$/.test(m.attempt)) {
      const c = this.credentials;
      const expected = await logicalAttachProof(channel.key, c.secret, c.id, c.incarnation, m.attempt);
      if (!this.owns(channel)) return;
      if (m.proof !== expected) throw new Error("logical attachment rejected");
      channel.attempt = m.attempt; channel.phase = "activated";
      const epoch = this.epoch;
      const proof = await logicalAttachedProof(channel.key, c.secret, c.id, c.incarnation, channel.attempt, epoch);
      if (this.owns(channel)) await this.control(channel, { op: "attached", epoch: String(epoch), proof });
      return;
    }
    if (m.op === "activate" && channel.phase === "activated" && m.attempt === channel.attempt && counter(m.expected) === this.epoch) {
      const epoch = this.epoch + 1n;
      this.activate(channel, epoch, watermark(m.position));
      await this.control(channel, { op: "activated", epoch: String(epoch), position: position(this.journal.watermark) }); return;
    }
    if (m.op === "sync" && channel.phase === "synced" && counter(m.epoch) === this.epoch) {
      await this.control(channel, { op: "synced", epoch: String(this.epoch) }); this.markReady(channel); return;
    }
    throw new Error("invalid logical server transition");
  }
  private activate(channel: Channel, epoch: bigint, peer: ResumeWatermark): void {
    this.journal.activate(channel.path, epoch, peer, this.now());
    this.acknowledgeTerminals(peer.received);
    this.epoch = epoch; channel.phase = "synced"; channel.committed = true;
    const previous = this.active;
    this.active = channel;
    if (previous && previous !== channel) previous.wire.close("logical channel activated");
    this.wake();
  }
  private acknowledgeTerminals(received: bigint): void {
    for (const [seq, waiter] of this.ackWaiters) if (seq <= received) { waiter.resolve(); this.ackWaiters.delete(seq); }
  }
  private markReady(channel: Channel): void {
    if (this.active !== channel) throw new Error("SYNC on inactive channel");
    channel.phase = "ready"; this.candidate = null; this.deadline = null; this.ack = true; this.budget = true;
    channel.resolve(); this.wake(); this.pump(); this.options.onReady?.();
  }
  private pump(): void {
    this.pumpRequested = true;
    const channel = this.active;
    if (this.pumping || !channel || channel.phase !== "ready") return;
    this.pumping = true; this.pumpRequested = false;
    void (async () => {
      while (this.active === channel && channel.phase === "ready" && !this.closed) {
        const mark = this.journal.watermark;
        let bytes: Uint8Array | null;
        if (this.ack) { this.ack = false; bytes = encodeResumeControl({ kind: "ack", epoch: this.epoch, received: mark.received }); }
        else if (this.budget) { this.budget = false; bytes = encodeResumeControl({ kind: "budget", epoch: this.epoch, dataGrant: mark.dataGrant, progressGrant: mark.progressGrant }); }
        else bytes = this.journal.next();
        if (!bytes) return;
        await channel.wire.send(bytes);
      }
    })().catch((error: unknown) => this.lost(channel, error)).finally(() => {
      this.pumping = false;
      if (this.active?.phase === "ready" && (this.pumpRequested || this.ack || this.budget || this.active !== channel)) this.pump();
    });
  }
  private control(channel: Channel, message: Record<string, unknown>): Promise<void> {
    if (!this.owns(channel)) return Promise.reject(new Error("logical channel unavailable"));
    return channel.wire.send(encode(message));
  }
  private failed(channel: Channel, error: unknown): void {
    if (!this.owns(channel)) return;
    if (channel === this.candidate && !channel.committed && this.epoch) { this.lost(channel, error); return; }
    this.close(error);
  }
  private lost(channel: Channel, error: unknown): void {
    if (!this.owns(channel)) return;
    if (this.candidate === channel) this.candidate = null;
    if (this.active === channel) this.active = null;
    if (channel.committed && this.active?.phase === "quiesced") {
      const previous = this.active; this.active = null; previous.wire.close();
    }
    channel.reject(error); channel.wire.close();
    if (this.active?.phase === "ready") { this.wake(); return; }
    if (this.deadline === null) this.deadline = this.now() + 60_000;
    if (this.epoch) this.journal.suspend(this.now());
    this.wake();
    if (!this.candidate) this.options.onRecovering?.();
  }
  private tick(): void {
    if (this.closed) return;
    try {
      const now = this.now();
      if (this.deadline !== null && now >= this.deadline) throw new Error("ResumeExpired");
      if (!this.epoch && now >= 60_000) throw new Error("logical admission timed out");
      this.journal.tick(now);
      for (const channel of new Set([this.active, this.candidate])) {
        if (channel && now - channel.lastReceive >= 15_000) this.lost(channel, new Error("physical channel timed out"));
      }
      const active = this.active;
      if (active?.phase === "ready" && now - this.lastPing >= 5_000) {
        this.lastPing = now; void this.control(active, { op: "ping", nonce: randomNonce() }).catch((e: unknown) => this.lost(active, e));
      }
    } catch (error) { this.close(error); }
  }
  private owns(channel: Channel): boolean { return !this.closed && (this.active === channel || this.candidate === channel); }
  private now(): number { return Math.floor(performance.now() - this.started); }
  private changed(): Promise<void> { return new Promise((resolve) => this.waiters.add(resolve)); }
  private wake(): void { const waiters = [...this.waiters]; this.waiters.clear(); for (const wake of waiters) wake(); }
  private live(): void { if (this.closed) throw this.terminal; }
}

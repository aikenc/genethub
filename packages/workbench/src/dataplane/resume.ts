/** V4 journal. Authentication and channel activation belong to its owning actor.
 * Actor-owned: callers must serialize calls; accepted receive leases stay charged
 * until stream consumption/discard, not just until dispatch. See docs/logical-connection-core.md.
 */
export const RESUME_HEADER_BYTES = 36;
export const RESUME_MAX_PAYLOAD = 16 * 1024 - 28 - RESUME_HEADER_BYTES;
const U64 = (1n << 64n) - 1n;
export type ResumePolicy = "relay-allowed" | "direct-only";
export type ResumePath = "fabric" | "rtc" | "loopback";
export type ResumeKind = 1 | 2 | 3 | 4 | 5 | 6;
export interface ResumeFrame { kind: ResumeKind; streamId: number; value: number; payload: Uint8Array }
export interface ResumePayload { epoch: bigint; seq: bigint; frame: ResumeFrame }
export interface ResumeLimits { dataBytes: number; progressBytes: number;  }
export interface ResumeWatermark { received: bigint; dataGrant: bigint; progressGrant: bigint }
export class ResumeError extends Error {
  constructor(readonly code: "ProtocolViolation" | "Backpressure" | "PolicyDenied" | "ResumeExpired" | "Closed" | "StateLost") { super(code); }
}
function fail(code: ResumeError["code"]): never { throw new ResumeError(code); }
function uint64(n: bigint): void { if (typeof n !== "bigint" || n < 0n || n > U64) fail("ProtocolViolation"); }
function add(a: bigint, b: bigint): bigint { const n = a + b; uint64(n); return n; }
function uint32(n: number): void { if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) fail("ProtocolViolation"); }
function progress(frame: ResumeFrame): boolean { return frame.kind >= 4; }
function validate(frame: ResumeFrame): void {
  uint32(frame.streamId); uint32(frame.value);
  if (frame.streamId === 0 || !Number.isInteger(frame.kind) || frame.kind < 1 || frame.kind > 6 ||
      (frame.kind <= 2 && frame.payload.byteLength > 8192) || frame.payload.byteLength > RESUME_MAX_PAYLOAD || (progress(frame) && frame.payload.byteLength !== 0)) fail("ProtocolViolation");
}
/** Integers are unsigned, big endian; reserved bytes must be zero. */
export function encodeResumePayload(p: ResumePayload): Uint8Array {
  uint64(p.epoch); uint64(p.seq); validate(p.frame);
  if (p.epoch === 0n || p.seq === 0n) fail("ProtocolViolation");
  const bytes = new Uint8Array(RESUME_HEADER_BYTES + p.frame.payload.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 4; bytes[1] = 1;
  view.setBigUint64(4, p.epoch); view.setBigUint64(12, p.seq);
  bytes[20] = p.frame.kind;
  view.setUint32(24, p.frame.streamId); view.setUint32(28, p.frame.value);
  view.setUint32(32, p.frame.payload.length); bytes.set(p.frame.payload, RESUME_HEADER_BYTES);
  return bytes;
}
export function decodeResumePayload(bytes: Uint8Array): ResumePayload {
  if (bytes.length < RESUME_HEADER_BYTES || bytes.length > 16 * 1024 - 28) fail("ProtocolViolation");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 4 || bytes[1] !== 1 || view.getUint16(2) || bytes[21] || view.getUint16(22) ||
      view.getUint32(32) !== bytes.length - RESUME_HEADER_BYTES) fail("ProtocolViolation");
  const result: ResumePayload = { epoch: view.getBigUint64(4), seq: view.getBigUint64(12), frame: {
    kind: bytes[20] as ResumeKind, streamId: view.getUint32(24), value: view.getUint32(28),
    payload: bytes.slice(RESUME_HEADER_BYTES),
  } };
  validate(result.frame);
  if (!result.epoch || !result.seq) fail("ProtocolViolation");
  return result;
}
export type ResumeControl = { kind: "ack"; epoch: bigint; received: bigint } | { kind: "budget"; epoch: bigint; dataGrant: bigint; progressGrant: bigint };
export function encodeResumeControl(control: ResumeControl): Uint8Array {
  uint64(control.epoch); if (!control.epoch) fail("ProtocolViolation");
  const bytes = new Uint8Array(control.kind === "ack" ? 20 : 28);
  const view = new DataView(bytes.buffer); bytes[0] = 4; bytes[1] = control.kind === "ack" ? 2 : 3;
  view.setBigUint64(4, control.epoch);
  if (control.kind === "ack") { uint64(control.received); view.setBigUint64(12, control.received); }
  else { uint64(control.dataGrant); uint64(control.progressGrant); view.setBigUint64(12, control.dataGrant); view.setBigUint64(20, control.progressGrant); }
  return bytes;
}
export function decodeResumeControl(bytes: Uint8Array): ResumeControl {
  if (bytes.length < 20 || bytes[0] !== 4 || bytes[2] || bytes[3] ||
      !((bytes[1] === 2 && bytes.length === 20) || (bytes[1] === 3 && bytes.length === 28))) fail("ProtocolViolation");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), epoch = view.getBigUint64(4);
  if (!epoch) fail("ProtocolViolation");
  return bytes[1] === 2 ? { kind: "ack", epoch, received: view.getBigUint64(12) } :
    { kind: "budget", epoch, dataGrant: view.getBigUint64(12), progressGrant: view.getBigUint64(20) };
}
type LaneIndex = 0 | 1;
interface Entry { frame: ResumeFrame; size: number; lane: LaneIndex }
interface Lane { capacity: bigint; charged: bigint; grant: bigint; logBytes: number; logCount: number; received: bigint; freed: bigint; receiveCount: number }
/** One endpoint's two directions. No timers or asynchronous callbacks inside the
 * transaction; the owning actor supplies monotonic time and authenticated paths.
 */
export class ResumeJournal {
  private epoch = 0n;
  private cursor = 0n;
  private allocated = 0n;
  private attempted = 0n;
  private acked = 0n;
  private received = 0n;
  private lastNow = 0;
  private deadline: number | null = null;
  private active = false;
  private terminal: ResumeError["code"] | null = null;
  private readonly lanes: readonly [Lane, Lane];
  private readonly log = new Map<bigint, Entry>();
  private readonly leases = new Map<bigint, { size: number; lane: LaneIndex }>();
  constructor(readonly policy: ResumePolicy, limits: ResumeLimits, readonly ttlMs = 60_000) {
    if (!["relay-allowed", "direct-only"].includes(policy) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail("ProtocolViolation");
    const createLane = (bytes: number): Lane => {
      if (!Number.isSafeInteger(bytes) || bytes < RESUME_HEADER_BYTES || bytes > 128 * 1024 * 1024) fail("ProtocolViolation");
      return { capacity: BigInt(bytes), charged: 0n, grant: BigInt(bytes), logBytes: 0, logCount: 0, received: 0n, freed: 0n, receiveCount: 0 };
    };
    this.lanes = [createLane(limits.dataBytes), createLane(limits.progressBytes)];
  }
  get state(): "connecting" | "ready" | "recovering" | "closed" { return this.terminal ? "closed" : this.active ? "ready" : this.epoch ? "recovering" : "connecting"; }
  get watermark(): ResumeWatermark { return { received: this.received, dataGrant: add(this.lanes[0].capacity, this.lanes[0].freed), progressGrant: add(this.lanes[1].capacity, this.lanes[1].freed) }; }
  get stats() { return { retainedFrames: this.log.size, receiveLeases: this.leases.size, logBytes: this.lanes.reduce((n, l) => n + l.logBytes, 0), receiveBytes: this.lanes.reduce((n, l) => n + Number(l.received - l.freed), 0), epoch: this.epoch }; }
  /** The registry, not this journal, authenticates admission and arbitrates epoch.
   * Invoke only once the activation/SYNC transaction has agreed both watermarks.
   * Reject before mutation, including route policy and impossible peer positions.
   */
  activate(path: ResumePath, epoch: bigint, peer: ResumeWatermark, now: number): void {
    this.tick(now); uint64(epoch);
    if (!["fabric", "rtc", "loopback"].includes(path) || (this.policy === "direct-only" && path === "fabric")) fail("PolicyDenied");
    if (epoch <= this.epoch) fail("ProtocolViolation");
    this.checkPeer(peer);
    this.acknowledge(peer.received);
    this.updateGrants(peer.dataGrant, peer.progressGrant);
    this.epoch = epoch; this.cursor = peer.received; this.active = true; this.deadline = null;
  }
  suspend(now: number): void {
    this.tick(now);
    if (!this.epoch) fail("ProtocolViolation");
    if (this.deadline === null) {
      const deadline = now + this.ttlMs;
      if (!Number.isSafeInteger(deadline)) fail("ProtocolViolation");
      this.deadline = deadline;
    }
    this.active = false;
  }
  tick(now: number): void {
    this.live();
    if (!Number.isSafeInteger(now) || now < this.lastNow) fail("ProtocolViolation");
    this.lastNow = now;
    if (this.deadline !== null && now >= this.deadline) { this.close("ResumeExpired"); fail("ResumeExpired"); }
  }
  enqueue(frame: ResumeFrame): bigint {
    this.live(); validate(frame);
    const size = RESUME_HEADER_BYTES + frame.payload.length;
    const lane = progress(frame) ? 1 : 0, l = this.lanes[lane];
    const charged = add(l.charged, BigInt(size)), seq = add(this.allocated, 1n);
    if (l.logBytes + size > Number(l.capacity) || charged > l.grant) fail("Backpressure");
    // Own a copy before promising custody; never retain the caller's mutable view.
    this.log.set(seq, { frame: { ...frame, payload: frame.payload.slice() }, size, lane });
    this.allocated = seq; l.charged = charged; l.logBytes += size; l.logCount++;
    return seq;
  }
  /** Marks a transmission attempt before handing bytes to an asynchronous writer.
   * A send failure suspends the journal; it must never roll back the logical seq.
   */
  next(): Uint8Array | null {
    this.live(); if (!this.active) return null;
    const seq = this.cursor + 1n, entry = this.log.get(seq);
    if (!entry) return null;
    const bytes = encodeResumePayload({ epoch: this.epoch, seq, frame: entry.frame });
    this.cursor = seq; if (seq > this.attempted) this.attempted = seq;
    return bytes;
  }
  receive(bytes: Uint8Array): { seq: bigint; frame: ResumeFrame } | null {
    this.live(); const packet = decodeResumePayload(bytes);
    if (packet.epoch < this.epoch) return null; // Fenced old channel; no grant or dispatch.
    if (!this.active || packet.epoch !== this.epoch) fail("ProtocolViolation");
    if (packet.seq <= this.received) return null;
    if (packet.seq !== this.received + 1n) fail("ProtocolViolation");
    const lane = progress(packet.frame) ? 1 : 0, l = this.lanes[lane], size = bytes.length;
    const received = add(l.received, BigInt(size));
    if (received > add(l.capacity, l.freed)) fail("ProtocolViolation");
    // The returned frame transfers ownership to the stream engine, but the lease
    // remains charged until consumption. Dispatch must happen exactly once.
    this.leases.set(packet.seq, { size, lane }); l.received = received; l.receiveCount++;
    this.received = packet.seq;
    return { seq: packet.seq, frame: packet.frame };
  }
  release(seq: bigint): void {
    this.live(); uint64(seq);
    const lease = this.leases.get(seq);
    if (!lease) fail("ProtocolViolation");
    const l = this.lanes[lease.lane];
    const freed = add(l.freed, BigInt(lease.size)); add(l.capacity, freed);
    l.freed = freed; l.receiveCount--; this.leases.delete(seq);
  }
  /** Encrypted channel reader supplies authenticated control plaintext. Old epoch
   * controls are fenced before they can delete a log or grant extra capacity. */
  receiveControl(bytes: Uint8Array): void {
    this.live(); const control = decodeResumeControl(bytes);
    if (control.epoch < this.epoch) return;
    if (!this.active || control.epoch !== this.epoch) fail("ProtocolViolation");
    if (control.kind === "ack") this.acknowledge(control.received);
    else this.updateGrants(control.dataGrant, control.progressGrant);
  }
  /** ACK/grant envelopes must be authenticated and epoch-checked by the owner. */
  acknowledge(seq: bigint): void {
    this.live(); uint64(seq);
    if (seq > this.attempted) fail("ProtocolViolation");
    if (seq <= this.acked) return;
    for (const [id, entry] of this.log) {
      if (id > seq) break;
      const l = this.lanes[entry.lane]; l.logBytes -= entry.size; l.logCount--; this.log.delete(id);
    }
    this.acked = seq; if (this.cursor < seq) this.cursor = seq;
  }
  updateGrants(data: bigint, progressGrant: bigint): void {
    this.live(); this.checkGrants(data, progressGrant);
    const grants = [data, progressGrant] as const;
    for (const i of [0, 1] as const) { if (grants[i] > this.lanes[i].grant) this.lanes[i].grant = grants[i]; }
  }
  private checkGrants(data: bigint, control: bigint): void {
    const grants = [data, control] as const;
    for (const i of [0, 1] as const) {
      const grant = grants[i];
      uint64(grant);
      if (grant > add(this.lanes[i].capacity, this.lanes[i].charged)) fail("ProtocolViolation");
    }
  }
  private checkPeer(peer: ResumeWatermark): void {
    uint64(peer.received);
    if (peer.received > this.attempted) fail("ProtocolViolation");
    if (peer.received < this.acked) fail("StateLost");
    this.checkGrants(peer.dataGrant, peer.progressGrant);
    if (peer.dataGrant < this.lanes[0].grant || peer.progressGrant < this.lanes[1].grant) fail("StateLost");
  }
  close(reason: ResumeError["code"] = "Closed"): void {
    if (this.terminal) return;
    this.terminal = reason; this.active = false; this.log.clear(); this.leases.clear();
    for (const l of this.lanes) { l.logBytes = 0; l.logCount = 0; l.receiveCount = 0; l.freed = l.received; }
  }
  private live(): void { if (this.terminal) fail(this.terminal); }
}

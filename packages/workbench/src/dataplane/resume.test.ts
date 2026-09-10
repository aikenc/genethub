// @vitest-environment node
// Binary/u64/ownership invariants, not a simulated production resume journey.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ResumeJournal, ResumeError, encodeResumePayload, decodeResumePayload, RESUME_MAX_PAYLOAD, encodeResumeControl, decodeResumeControl, type ResumeFrame, type ResumePolicy } from "./resume";
const limits = { dataBytes: 78, progressBytes: 108 };
const initial = { received: 0n, dataGrant: 78n, progressGrant: 108n };
const frame = (kind: ResumeFrame["kind"] = 3): ResumeFrame => ({ kind, streamId: 1, value: 1, payload: kind >= 4 ? new Uint8Array() : new Uint8Array([1, 2, 3]) });
function pair(policy: ResumePolicy = "relay-allowed") {
  const a = new ResumeJournal(policy, limits), b = new ResumeJournal(policy, limits);
  a.activate("rtc", 1n, b.watermark, 0); b.activate("rtc", 1n, a.watermark, 0);
  return { a, b };
}
function error(fn: () => unknown, code: ResumeError["code"]) { expect(fn).toThrowError(new ResumeError(code)); }
function deliver(a: ResumeJournal, b: ResumeJournal) { const bytes = a.next(); expect(bytes).not.toBeNull(); return b.receive(bytes!); }
describe("candidate resume journal invariants", () => {
  it("matches the independent Rust/TS corpus including exact u64 above 2^53", () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../proto/fixtures/resume-payload.json", import.meta.url), "utf8"));
    for (const v of vectors) {
      const p = { epoch: BigInt(v.epoch), seq: BigInt(v.seq), frame: { kind: v.kind, streamId: v.streamId, value: v.value, payload: Uint8Array.from(Buffer.from(v.payload, "hex")) } };
      const wire = encodeResumePayload(p);
      expect(Buffer.from(wire).toString("hex")).toBe(v.wire);
      expect(decodeResumePayload(wire)).toEqual(p);
      for (const offset of [0, 1, 2, 3, 21, 22, 23, 32]) {
        const bad = wire.slice(); bad[offset] = bad[offset]! ^ 0x80;
        error(() => decodeResumePayload(bad), "ProtocolViolation");
      }
      for (let n = 0; n < wire.length; n++) error(() => decodeResumePayload(wire.slice(0, n)), "ProtocolViolation");
    }
  });
  it("pins ACK/BUDGET encoding and fences old-epoch control before mutation", () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../proto/fixtures/resume-control.json", import.meta.url), "utf8"));
    for (const v of vectors) {
      const p = v.kind === "ack" ? { kind: "ack" as const, epoch: BigInt(v.epoch), received: BigInt(v.received) } :
        { kind: "budget" as const, epoch: BigInt(v.epoch), dataGrant: BigInt(v.dataGrant), progressGrant: BigInt(v.progressGrant) };
      const wire = encodeResumeControl(p); expect(Buffer.from(wire).toString("hex")).toBe(v.wire);
      expect(decodeResumeControl(wire)).toEqual(p);
      for (let n = 0; n < wire.length; n++) error(() => decodeResumeControl(wire.slice(0, n)), "ProtocolViolation");
    }
    const { a, b } = pair(); a.enqueue(frame()); a.next(); a.suspend(0);
    a.activate("fabric", 2n, b.watermark, 1);
    a.receiveControl(encodeResumeControl({ kind: "ack", epoch: 1n, received: (1n << 64n) - 1n }));
    a.receiveControl(encodeResumeControl({ kind: "budget", epoch: 1n, dataGrant: 999n, progressGrant: 999n }));
    expect(a.stats.retainedFrames).toBe(1);
    error(() => a.receiveControl(encodeResumeControl({ kind: "ack", epoch: 3n, received: 0n })), "ProtocolViolation");
  });
  it("derives the exact secure record limit and rejects invalid frame classes", () => {
    const p = { epoch: 1n, seq: 1n, frame: { ...frame(), payload: new Uint8Array(RESUME_MAX_PAYLOAD) } };
    expect(encodeResumePayload(p).length + 28).toBe(16384);
    error(() => encodeResumePayload({ ...p, frame: { ...p.frame, payload: new Uint8Array(RESUME_MAX_PAYLOAD + 1) } }), "ProtocolViolation");
    error(() => encodeResumePayload({ ...p, epoch: 1n << 64n }), "ProtocolViolation");
    error(() => encodeResumePayload({ ...p, seq: 0n }), "ProtocolViolation");
    error(() => encodeResumePayload({ ...p, frame: { ...frame(), kind: 4 } }), "ProtocolViolation");
  });
  it("owns writes, retains unconfirmed OPEN and dispatches it once after ACK loss", () => {
    const { a, b } = pair(); const input = frame(1);
    a.enqueue(input); input.payload.fill(99);
    const first = a.next()!; const accepted = b.receive(first)!;
    expect(accepted.frame.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(b.receive(first)).toBeNull(); expect(b.stats.receiveLeases).toBe(1);
    expect(a.stats.retainedFrames).toBe(1);
    a.suspend(1); b.suspend(1);
    a.activate("fabric", 2n, b.watermark, 30_000); b.activate("fabric", 2n, a.watermark, 30_000);
    expect(a.next()).toBeNull(); expect(a.stats.retainedFrames).toBe(0);
    expect(b.stats.receiveBytes).toBe(39); expect(b.receive(first)).toBeNull();
    b.release(accepted.seq); error(() => b.release(accepted.seq), "ProtocolViolation");
    expect(b.stats.receiveBytes).toBe(0);
  });
  it("replays an unreceived frame with a new epoch, without charging it twice", () => {
    const { a, b } = pair(); a.enqueue(frame()); const lost = a.next()!;
    a.suspend(0); b.suspend(0);
    a.activate("fabric", 2n, b.watermark, 1); b.activate("fabric", 2n, a.watermark, 1);
    expect(b.receive(lost)).toBeNull(); const replay = a.next()!;
    expect(decodeResumePayload(replay).seq).toBe(1n); expect(decodeResumePayload(replay).epoch).toBe(2n);
    expect(b.receive(replay)?.seq).toBe(1n); expect(b.receive(replay)).toBeNull();
    a.enqueue(frame()); error(() => a.enqueue(frame()), "Backpressure");
  });
  it("keeps RESET, FIN and WINDOW_UPDATE moving when both data directions are full", () => {
    const { a, b } = pair();
    for (let i = 0; i < 2; i++) { a.enqueue(frame()); b.enqueue(frame()); }
    error(() => a.enqueue(frame()), "Backpressure"); error(() => b.enqueue(frame()), "Backpressure");
    for (let i = 0; i < 2; i++) { deliver(a, b); deliver(b, a); }
    a.acknowledge(b.watermark.received); b.acknowledge(a.watermark.received);
    // Dispatch did not release receive memory; ACK cannot manufacture credit.
    expect(a.stats.receiveBytes).toBe(78); error(() => a.enqueue(frame()), "Backpressure");
    for (const kind of [4, 5, 6] as const) { a.enqueue(frame(kind)); b.enqueue(frame(kind)); }
    for (let i = 0; i < 3; i++) {
      const atB = deliver(a, b)!, atA = deliver(b, a)!;
      expect(atB.frame.kind).toBe(4 + i); a.release(atA.seq); b.release(atB.seq);
    }
    a.acknowledge(b.watermark.received); b.acknowledge(a.watermark.received);
    a.updateGrants(b.watermark.dataGrant, b.watermark.progressGrant);
    expect(a.enqueue(frame(6))).toBe(6n);
    b.release(1n); a.updateGrants(b.watermark.dataGrant, b.watermark.progressGrant);
    expect(a.enqueue(frame())).toBe(7n); expect(a.stats.logBytes).toBe(75);
  });
  it("rejects state loss, future ACK, gaps and forged budget atomically", () => {
    const { a, b } = pair(); a.enqueue(frame());
    error(() => a.acknowledge(1n), "ProtocolViolation");
    error(() => a.updateGrants(118n, 108n), "ProtocolViolation");
    const wire = a.next()!; const gap = decodeResumePayload(wire); gap.seq = 2n;
    error(() => b.receive(encodeResumePayload(gap)), "ProtocolViolation"); expect(b.watermark.received).toBe(0n);
    b.receive(wire); a.acknowledge(1n);
    const before = a.stats;
    error(() => a.activate("fabric", 2n, initial, 1), "StateLost"); expect(a.stats).toEqual(before);
    a.acknowledge(0n); expect(a.stats.retainedFrames).toBe(0);
  });
  it("never relaxes direct-only on recovery or damages the healthy epoch on denial", () => {
    const { a, b } = pair("direct-only"); a.enqueue(frame());
    error(() => a.activate("fabric", 2n, b.watermark, 1), "PolicyDenied");
    expect(a.state).toBe("ready"); expect(decodeResumePayload(a.next()!).epoch).toBe(1n);
    a.suspend(1); error(() => a.activate("fabric", 2n, b.watermark, 30_000), "PolicyDenied");
    a.activate("rtc", 2n, b.watermark, 30_001); expect(a.state).toBe("ready");
  });
  it("does not extend TTL on repeated outage/denied attach and closes all custody", () => {
    const { a, b } = pair("direct-only"); a.enqueue(frame()); deliver(a, b);
    a.suspend(100); a.suspend(30_000);
    error(() => a.activate("fabric", 2n, b.watermark, 60_099), "PolicyDenied");
    error(() => a.activate("rtc", 2n, b.watermark, 60_100), "ResumeExpired");
    expect(a.state).toBe("closed"); expect(a.stats.logBytes).toBe(0);
    error(() => a.enqueue(frame()), "ResumeExpired"); a.close();
  });
  it("rejects deadline overflow without installing a poisoned recovery deadline", () => {
    const { a, b } = pair();
    error(() => a.suspend(Number.MAX_SAFE_INTEGER), "ProtocolViolation");
    expect(a.state).toBe("ready");
    a.activate("rtc", 2n, b.watermark, Number.MAX_SAFE_INTEGER);
    expect(a.state).toBe("ready");
  });
  it("survives 100 handoffs with lost frames/ACKs, constant buffers and exact bytes", () => {
    const { a, b } = pair(); const output: number[] = [];
    for (let i = 0; i < 100; i++) {
      const input = frame(); input.payload[0] = i; a.enqueue(input);
      const old = a.next()!;
      if (i % 2 === 0) { const p = b.receive(old)!; output.push(p.frame.payload[0]!); b.release(p.seq); }
      a.suspend(i); b.suspend(i);
      const epoch = BigInt(i + 2);
      a.activate(i % 2 ? "rtc" : "fabric", epoch, b.watermark, i);
      b.activate(i % 2 ? "rtc" : "fabric", epoch, a.watermark, i);
      expect(b.receive(old)).toBeNull(); const replay = a.next();
      if (replay) { const p = b.receive(replay)!; output.push(p.frame.payload[0]!); b.release(p.seq); }
      a.acknowledge(b.watermark.received); a.updateGrants(b.watermark.dataGrant, b.watermark.progressGrant);
      expect(a.stats.logBytes).toBe(0); expect(b.stats.receiveBytes).toBe(0);
    }
    expect(output).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});

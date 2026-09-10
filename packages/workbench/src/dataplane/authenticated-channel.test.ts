// @vitest-environment node
// Crypto/cancellation invariants use real Web Crypto and MessagePort transport.
// Actual WebSocket/Fabric/RTC behavior is covered by product-client specialties.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { deriveChannelSessionKey } from "../devices/proof";
import { AuthenticatedChannel, type RecordCarrier } from "./authenticated-channel";
import { sealDataRecord } from "./secure";

class PortCarrier implements RecordCarrier {
  sent = 0;
  constructor(readonly port: MessagePort) {}
  send(record: Uint8Array): void { this.sent++; this.port.postMessage(record); }
  onRecord(handler: (record: Uint8Array) => void): () => void {
    this.port.on("message", handler); return () => this.port.off("message", handler);
  }
  onClose(handler: () => void): () => void {
    this.port.on("close", handler); return () => this.port.off("close", handler);
  }
  close(): void { this.port.close(); }
}
const key = () => deriveChannelSessionKey("0123456789abcdef".repeat(4), "channel-invariants",
  "00112233445566778899aabbccddeeff", "ffeeddccbbaa99887766554433221100");
const barrier = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("authenticated physical channel custody", () => {
  it("owns queued plaintext and preserves concurrent record order", async () => {
    const { port1, port2 } = new MessageChannel();
    const session = await key(), got: number[] = [];
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    const client = new AuthenticatedChannel({ role: "client", key: session, carrier: new PortCarrier(port1), onPlaintext() {}, onClose() {} });
    const server = new AuthenticatedChannel({ role: "server", key: session, carrier: new PortCarrier(port2), onPlaintext(bytes) {
      got.push(bytes[0]!); if (got.length === 100) complete();
    }, onClose() {} });
    try {
      const writes = Array.from({ length: 100 }, (_, i) => {
        const input = new Uint8Array([i]); const sent = client.send(input); input[0] = 255; return sent;
      });
      await Promise.all(writes); await done;
      expect(got).toEqual(Array.from({ length: 100 }, (_, i) => i));
    } finally { client.close(); server.close(); }
  });

  it("fences encryption finishing after channel close and closes only once", async () => {
    const { port1, port2 } = new MessageChannel();
    const carrier = new PortCarrier(port1); let closes = 0;
    const channel = new AuthenticatedChannel({ role: "client", key: await key(), carrier,
      onPlaintext() {}, onClose() { closes++; } });
    try {
      const sent = channel.send(new Uint8Array([1]));
      // send's microtask starts real asynchronous crypto before this closure.
      queueMicrotask(() => channel.close());
      await expect(sent).rejects.toThrow("closed");
      channel.close(); expect(closes).toBe(1); expect(carrier.sent).toBe(0);
      await expect(channel.send(new Uint8Array([2]))).rejects.toThrow("closed");
    } finally { channel.close(); port2.close(); }
  });

  it("does not dispatch queued ciphertext after detach", async () => {
    const { port1, port2 } = new MessageChannel();
    const session = await key(); let delivered = 0;
    const receiver = new AuthenticatedChannel({ role: "server", key: session, carrier: new PortCarrier(port2),
      onPlaintext() { delivered++; }, onClose() {} });
    try {
      const wire = await sealDataRecord(session, "client-to-daemon", 1, new Uint8Array([7]));
      const detached = new Promise<void>((resolve) => port2.once("message", () => { receiver.close(); resolve(); }));
      port1.postMessage(wire); await detached; await barrier();
      expect(delivered).toBe(0);
    } finally { receiver.close(); port1.close(); }
  });

  it("fails closed on replay instead of continuing after a sequence hole", async () => {
    const { port1, port2 } = new MessageChannel();
    const session = await key(); const got: number[] = []; let reason: unknown;
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => { finish = resolve; });
    const receiver = new AuthenticatedChannel({ role: "server", key: session, carrier: new PortCarrier(port2),
      onPlaintext(bytes) { got.push(bytes[0]!); }, onClose(error) { reason = error; finish(); } });
    try {
      const wire = await sealDataRecord(session, "client-to-daemon", 1, new Uint8Array([7]));
      port1.postMessage(wire); port1.postMessage(wire);
      port1.postMessage(await sealDataRecord(session, "client-to-daemon", 2, new Uint8Array([8])));
      await closed; await barrier();
      expect(got).toEqual([7]); expect(String(reason)).toContain("sequence or version");
    } finally { receiver.close(); port1.close(); }
  });
});

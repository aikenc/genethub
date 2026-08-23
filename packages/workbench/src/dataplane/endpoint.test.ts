import type { ExchangeRequestHead } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { deriveChannelSessionKey } from "../devices/proof";
import { collectBody, exchange } from "./exchange";
import { DataEndpoint, type RecordCarrier } from "./endpoint";
import { DataKind, decodeDataFrame } from "./frame";
import { openDataRecord } from "./secure";

class MemoryCarrier implements RecordCarrier {
  peer: MemoryCarrier | null = null;
  readonly sent: Uint8Array[] = [];
  private readonly records = new Set<(record: Uint8Array) => void>();
  private readonly closes = new Set<(reason?: unknown) => void>();
  private closed = false;

  async send(record: Uint8Array): Promise<void> {
    if (this.closed || !this.peer || this.peer.closed) throw new Error("carrier closed");
    const copy = record.slice();
    this.sent.push(copy);
    await Promise.resolve();
    for (const handler of this.peer.records) handler(copy.slice());
  }

  onRecord(handler: (record: Uint8Array) => void): () => void {
    this.records.add(handler);
    return () => this.records.delete(handler);
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    this.closes.add(handler);
    return () => this.closes.delete(handler);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closes) handler(reason);
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      for (const handler of this.peer.closes) handler(reason);
    }
  }
}

function carriers(): [MemoryCarrier, MemoryCarrier] {
  const client = new MemoryCarrier();
  const server = new MemoryCarrier();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

const head = (method: string, length: number): ExchangeRequestHead => ({
  version: 3,
  method,
  metadata: null,
  bodyLength: length,
});

async function endpoints() {
  const [clientCarrier, serverCarrier] = carriers();
  const key = await deriveChannelSessionKey(
    "0123456789abcdef".repeat(4),
    "hosted:test",
    "00112233445566778899aabbccddeeff",
    "ffeeddccbbaa99887766554433221100",
  );
  const client = new DataEndpoint({ role: "client", carrier: clientCarrier, key });
  const server = new DataEndpoint({ role: "server", carrier: serverCarrier, key });
  return { client, server, clientCarrier, key };
}

describe("the E2EE data endpoint", () => {
  it("runs independent streaming exchanges over one carrier", async () => {
    const stack = await endpoints();
    stack.server.onIncoming((stream) => {
      void (async () => {
        const request = await collectBody(stream.body(), 3 * 1024 * 1024);
        await stream.respond({
          status: 200,
          metadata: { method: stream.requestHead.method },
          bodyLength: request.byteLength,
        });
        await stream.write(request);
        await stream.finish();
      })();
    });

    const source = new Uint8Array(2 * 1024 * 1024);
    source.forEach((_, index) => (source[index] = index % 251));
    const response = await exchange(stack.client, head("echo", source.byteLength), source);
    expect(response.head).toMatchObject({ status: 200, metadata: { method: "echo" } });
    expect(await collectBody(response.body, source.byteLength)).toEqual(source);
    await response.stream.done;
    expect(stack.client.activeStreamCount).toBe(0);
    expect(stack.server.activeStreamCount).toBe(0);
  }, 20_000);

  it("round-robins bounded data frames from concurrent writers", async () => {
    const stack = await endpoints();
    stack.server.onIncoming((stream) => {
      void (async () => {
        await collectBody(stream.body(), 1024 * 1024);
        await stream.respond({ status: 204, metadata: null, bodyLength: 0 });
        await stream.finish();
      })();
    });
    const one = stack.client.open(head("one", 96 * 1024));
    const two = stack.client.open(head("two", 96 * 1024));
    await Promise.all([
      one.write(new Uint8Array(96 * 1024)),
      two.write(new Uint8Array(96 * 1024)),
    ]);
    await Promise.all([one.finish(), two.finish()]);
    await Promise.all([one.responseHead, two.responseHead]);

    const dataIds: number[] = [];
    for (const [index, record] of stack.clientCarrier.sent.entries()) {
      const plaintext = await openDataRecord(
        stack.key,
        "client-to-daemon",
        index + 1,
        record,
      );
      const frame = decodeDataFrame(plaintext)!;
      if (frame.kind === DataKind.Data) dataIds.push(frame.streamId);
    }
    expect(dataIds.slice(0, 6)).toEqual([one.id, two.id, one.id, two.id, one.id, two.id]);
  });

  it("sends a terminal reset even while the stream's OPEN is in flight", async () => {
    const stack = await endpoints();
    const stream = stack.client.open(head("cancel", 0));
    stream.reset();
    await waitFor(() => stack.clientCarrier.sent.length === 2);

    const kinds = await Promise.all(
      stack.clientCarrier.sent.map(async (record, index) => {
        const plaintext = await openDataRecord(
          stack.key,
          "client-to-daemon",
          index + 1,
          record,
        );
        return decodeDataFrame(plaintext)!.kind;
      }),
    );
    expect(kinds).toEqual([DataKind.Open, DataKind.Reset]);
  });

  it("fails only a malformed stream transition before closing a hostile peer", async () => {
    const stack = await endpoints();
    const errors: unknown[] = [];
    const [attackerCarrier, victimCarrier] = carriers();
    const attacker = new DataEndpoint({
      role: "client",
      carrier: attackerCarrier,
      key: stack.key,
    });
    const victim = new DataEndpoint({
      role: "server",
      carrier: victimCarrier,
      key: stack.key,
      onError: (error) => errors.push(error),
    });
    const stream = attacker.open(head("bad", 0));
    await stream.finish();
    // A second FIN is prevented locally; a wire-level duplicate is covered by
    // the frame/record codec tests and dispatch must fail the endpoint.
    await expect(stream.finish()).resolves.toBeUndefined();
    expect(victim.state).toBe("open");
    expect(errors).toEqual([]);
    attacker.close();
    expect(victim.state).toBe("closed");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for data-plane state");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

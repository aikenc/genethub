import type { ExchangeRequestHead } from "@genehub/proto";
import { afterEach, describe, expect, it } from "vitest";

import { deriveChannelSessionKey } from "../devices/proof";
import { collectBody, exchange } from "./exchange";
import { DataEndpoint, type RecordCarrier } from "./endpoint";
import {
  DataKind,
  DATA_PLANE_VERSION,
} from "./frame";
import { decodeDataFrame } from "./frame";
import { openDataRecord } from "./secure";

class MemoryCarrier implements RecordCarrier {
  peer: MemoryCarrier | null = null;
  readonly sent: Uint8Array[] = [];
  private readonly records = new Set<(record: Uint8Array) => void>();
  private readonly closes = new Set<(reason?: unknown) => void>();
  private closed = false;
  beforeDelivery?: (record: Uint8Array, sequence: number) => Promise<void>;

  async send(record: Uint8Array): Promise<void> {
    if (this.closed || !this.peer || this.peer.closed) throw new Error("carrier closed");
    const copy = record.slice();
    this.sent.push(copy);
    await this.beforeDelivery?.(copy, this.sent.length);
    await Promise.resolve();
    if (this.closed || this.peer.closed) return;
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
  version: DATA_PLANE_VERSION,
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
  cleanup.push(client, server);
  return { client, server, clientCarrier, serverCarrier, key };
}

const cleanup: DataEndpoint[] = [];
const handlerTasks: Promise<void>[] = [];
afterEach(async () => {
  try { await Promise.all(handlerTasks.splice(0)); }
  finally { for (const endpoint of cleanup.splice(0)) endpoint.close(); }
});

describe("the E2EE data endpoint", () => {
  it("transfers finite and unknown-length bodies beyond the former credit without ACKs", async () => {
    const stack = await endpoints();
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(73);
    stack.server.onIncoming((stream) => {
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        const preview = stream.requestHead.method !== "workspace.list";
        await stream.respond({ status: 200, metadata: null, ...(stream.requestHead.method === "duplex-output" ? {} : { bodyLength: preview ? bytes.length : 0 }) });
        if (preview) for (let at = 0; at < bytes.length; at += 65536) await stream.write(bytes.subarray(at, at + 65536));
        await stream.finish();
      })());
    });

    for (const method of ["asset.preview", "duplex-output"]) {
      const stream = stack.client.open(head(method, 0));
      await stream.finish();
      await stream.responseHead;
      const actual = await collectBody(stream.body(), bytes.length);
      expect(actual.length).toBe(bytes.length);
      expect(actual.every(byte => byte === 73)).toBe(true);
      await stream.done;
    }
    const regular = stack.client.open(head("workspace.list", 0));
    await regular.finish();
    await regular.done;

    const opens: Array<{ method: string; window: number }> = [];
    let updates = 0;
    for (const [index, record] of stack.clientCarrier.sent.entries()) {
      const plaintext = await openDataRecord(
        stack.key,
        "client-to-daemon",
        index + 1,
        record,
      );
      if (plaintext[1] === 16) continue;
      const frame = decodeDataFrame(plaintext)!;
      if (plaintext[1] === 4) updates++; // Former consumption ACK kind is no longer accepted.
      if (frame.kind !== DataKind.Open) continue;
      const request = JSON.parse(new TextDecoder().decode(frame.payload)) as {
        method: string;
      };
      opens.push({ method: request.method, window: frame.value });
    }
    expect(updates).toBe(0);
    expect(opens).toEqual([
      { method: "asset.preview", window: 0 },
      { method: "duplex-output", window: 0 },
      { method: "workspace.list", window: 0 },
    ]);
  }, 20_000);

  it("refuses an unread overfull stream while a healthy sibling continues", async () => {
    const stack = await endpoints();
    let refused = false;
    stack.server.onIncoming(stream => {
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        await stream.respond({ status: 200, metadata: null });
        if (stream.requestHead.method === "slow-output") {
          try {
            for (let i = 0; i < 80; i++) await stream.write(new Uint8Array(65536));
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            refused = true;
          }
        } else await stream.finish();
      })());
    });
    const slow = stack.client.open(head("slow-output", 0));
    await slow.finish(); await slow.responseHead;
    await expect(slow.done).rejects.toThrow("reset");
    await expect(collectBody(slow.body(), 4 * 1024 * 1024)).rejects.toThrow("reset");
    await waitFor(() => refused);
    const healthy = stack.client.open(head("healthy", 0));
    await healthy.finish(); await healthy.responseHead; await healthy.done;
    expect(stack.client.state).toBe("open"); expect(stack.server.state).toBe("open");
  }, 20_000);

  it("retains unread completed response bytes until consumption or cancellation", async () => {
    const stack = await endpoints();
    const bytes = new Uint8Array(1024).fill(19);
    stack.server.onIncoming(stream => {
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        await stream.respond({ status: 200, metadata: null, bodyLength: bytes.length });
        await stream.write(bytes);
        await stream.finish();
      })());
    });
    const first = stack.client.open(head("unread", 0));
    await first.finish(); await first.responseHead;
    await waitFor(() => stack.server.activeStreamCount === 0);
    expect(stack.client.activeStreamCount).toBe(1);
    expect(await collectBody(first.body(), bytes.length)).toEqual(bytes);
    await first.done;
    expect(stack.client.activeStreamCount).toBe(0);
    const canceled = stack.client.open(head("unread", 0));
    await canceled.finish(); await canceled.responseHead;
    await waitFor(() => stack.server.activeStreamCount === 0);
    canceled.reset();
    await expect(canceled.done).rejects.toThrow("reset");
    expect(stack.client.activeStreamCount).toBe(0);
  });

  it("rejects finish when no FIN was accepted before cancellation", async () => {
    const stack = await endpoints();
    await stack.client.ready();
    const stream = stack.client.open(head("cancel-before-finish", 0));
    stream.reset();
    await expect(stream.finish()).rejects.toThrow("stream is closed");
  });

  it("reports a failed body even when the consumer starts after carrier loss", async () => {
    const stack = await endpoints();
    let sent!: () => void;
    const written = new Promise<void>(resolve => { sent = resolve; });
    stack.server.onIncoming(stream => {
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        await stream.respond({ status: 200, metadata: null, bodyLength: 4096 });
        await stream.write(new Uint8Array(1024));
        sent();
        // Deliberately no FIN: a prefix is not a successful response.
      })());
    });
    const stream = stack.client.open(head("lost-prefix", 0));
    await stream.finish(); await stream.responseHead;
    await written;
    stack.clientCarrier.close("injected body loss");
    await expect(collectBody(stream.body(), 4096)).rejects.toThrow();
    await expect(stream.done).rejects.toThrow();
  });

  it("runs independent streaming exchanges over one carrier", async () => {
    const stack = await endpoints();
    let serverDone!: Promise<void>;
    stack.server.onIncoming((stream) => {
      serverDone = stream.done;
      handlerTasks.push((async () => {
        const request = await collectBody(stream.body(), 3 * 1024 * 1024);
        await stream.respond({
          status: 200,
          metadata: { method: stream.requestHead.method },
          bodyLength: request.byteLength,
        });
        await stream.write(request);
        await stream.finish();
      })());
    });

    // Several frames, still inside the initial window. A 2MiB echo is the
    // same path but spends tens of seconds in AES when the suite is beside
    // cargo, so this stays multi-frame without depending on a quiet machine.
    const source = new Uint8Array(256 * 1024);
    source.forEach((_, index) => (source[index] = index % 251));
    const response = await exchange(stack.client, head("echo", source.byteLength), source);
    expect(response.head).toMatchObject({ status: 200, metadata: { method: "echo" } });
    expect(await collectBody(response.body, source.byteLength)).toEqual(source);
    await response.stream.done;
    expect(stack.client.activeStreamCount).toBe(0);
    // Both sides finish from local writes and complete bodies, without ACKs.
    await serverDone;
    expect(stack.server.activeStreamCount).toBe(0);
  }, 20_000);

  it("round-robins bounded data frames from concurrent writers", async () => {
    const stack = await endpoints();
    stack.server.onIncoming((stream) => {
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 1024 * 1024);
        await stream.respond({ status: 204, metadata: null, bodyLength: 0 });
        await stream.finish();
      })());
    });
    const one = stack.client.open(head("one", 96 * 1024));
    const two = stack.client.open(head("two", 96 * 1024));
    await Promise.all([
      one.write(new Uint8Array(96 * 1024)),
      two.write(new Uint8Array(96 * 1024)),
    ]);
    await Promise.all([one.finish(), two.finish()]);
    await Promise.all([one.responseHead, two.responseHead, one.done, two.done]);
    await waitFor(() => stack.server.activeStreamCount === 0);

    const dataIds: number[] = [];
    for (const [index, record] of stack.clientCarrier.sent.entries()) {
      const plaintext = await openDataRecord(
        stack.key,
        "client-to-daemon",
        index + 1,
        record,
      );
      if (plaintext[1] === 16) continue;
      const frame = decodeDataFrame(plaintext)!;
      if (frame.kind === DataKind.Data) dataIds.push(frame.streamId);
    }
    expect(dataIds.slice(0, 6)).toEqual([one.id, two.id, one.id, two.id, one.id, two.id]);
  });

  it("sends a terminal reset even while the stream's OPEN is in flight", async () => {
    const stack = await endpoints();
    await stack.client.ready();
    const stream = stack.client.open(head("cancel", 0));
    stream.reset();
    await stack.client.ready();
    await waitFor(async () => {
      const frames = await Promise.all(stack.clientCarrier.sent.map(async (record, i) =>
        openDataRecord(stack.key, "client-to-daemon", i + 1, record)));
      return frames.filter((bytes) => bytes[1] !== 16).length === 2;
    });

    const kinds = await Promise.all(
      stack.clientCarrier.sent.map(async (record, index) => {
        const plaintext = await openDataRecord(
          stack.key,
          "client-to-daemon",
          index + 1,
          record,
        );
        return plaintext[1] !== 16 ? decodeDataFrame(plaintext)!.kind : null;
      }),
    );
    expect(kinds.filter((kind) => kind !== null)).toEqual([DataKind.Open, DataKind.Reset]);
  });

  it("owns concurrent write buffers and orders FIN after every accepted write", async () => {
    const stack = await endpoints();
    stack.server.onIncoming((stream) => {
      handlerTasks.push((async () => {
        const bytes = await collectBody(stream.body(), 4);
        await stream.respond({ status: 200, metadata: null, bodyLength: bytes.length });
        await stream.write(bytes); await stream.finish();
      })());
    });
    const stream = stack.client.open(head("echo", 4));
    const first = new Uint8Array([1, 2]), second = new Uint8Array([3, 4]);
    const writes = [stream.write(first), stream.write(second), stream.finish()];
    first.fill(9); second.fill(9);
    await Promise.all(writes);
    expect(await collectBody(stream.body(), 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await stream.done;
  });

  it("ends all old streams on carrier loss and uses a fresh endpoint for new work", async () => {
    const old = await endpoints();
    let handled = 0, ended = 0;
    old.server.onIncoming(stream => handlerTasks.push((async () => {
      handled++;
      try { await collectBody(stream.body(), 3); }
      catch { ended++; }
    })()));
    const one = old.client.open(head("one", 3)), two = old.client.open(head("two", 3));
    await Promise.all([one.write(new Uint8Array([1])), two.write(new Uint8Array([2]))]);
    await waitFor(() => handled === 2);
    const id = old.client.logicalId;
    old.clientCarrier.close("injected carrier loss");
    await expect(one.done).rejects.toThrow();
    await expect(two.done).rejects.toThrow();
    await waitFor(() => old.client.state === "closed" && old.server.state === "closed" && ended === 2);
    expect(old.client.activeStreamCount).toBe(0);
    expect(handled).toBe(2);
    const next = await endpoints();
    await Promise.all([next.client.ready(), next.server.ready()]);
    expect(next.client.logicalId).not.toBe(id);
    next.server.onIncoming(stream => handlerTasks.push((async () => {
      await collectBody(stream.body(), 0);
      await stream.respond({ status: 204, metadata: null, bodyLength: 0 });
      await stream.finish();
    })()));
    const result = await exchange(next.client, head("explicit-new-read", 0));
    expect(result.head.status).toBe(204);
    await result.stream.done;
    expect(handled).toBe(2);
  });

  it("keeps an independent healthy connection when another carrier ends", async () => {
    const failed = await endpoints(), healthy = await endpoints();
    await Promise.all([failed.client.ready(), healthy.client.ready()]);
    const id = healthy.client.logicalId;
    failed.clientCarrier.close("only this connection fails");
    healthy.server.onIncoming(stream => handlerTasks.push((async () => {
      await collectBody(stream.body(), 0);
      await stream.respond({ status: 204, metadata: null, bodyLength: 0 });
      await stream.finish();
    })()));
    const result = await exchange(healthy.client, head("independent", 0));
    expect(result.head.status).toBe(204);
    await result.stream.done;
    expect(healthy.client.logicalId).toBe(id);
    expect(failed.client.state).toBe("closed");
  });

  it("refuses to create a direct-only endpoint on a Fabric carrier", async () => {
    const [carrier, peer] = carriers();
    const key = await deriveChannelSessionKey("direct-secret", "hosted:direct", randomToken(9), randomToken(10));
    expect(() => new DataEndpoint({ role: "client", carrier, key, policy: "direct-only", path: "fabric" })).toThrow("PolicyDenied");
    expect(carrier.sent).toHaveLength(0);
    carrier.close(); peer.close();
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
    cleanup.push(attacker, victim);
    const stream = attacker.open(head("bad", 0));
    await stream.finish();
    // A second FIN is prevented locally; a wire-level duplicate is covered by
    // the frame/record codec tests and dispatch must fail the endpoint.
    await expect(stream.finish()).resolves.toBeUndefined();
    expect(victim.state).toBe("open");
    expect(errors).toEqual([]);
    attacker.close();
    await waitFor(() => victim.state === "closed");
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for data-plane state");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function randomToken(n: number): string { return n.toString(16).padStart(32, "0"); }

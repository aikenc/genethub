import type { ExchangeRequestHead } from "@genehub/proto";
import { afterEach, describe, expect, it } from "vitest";

import { deriveChannelSessionKey } from "../devices/proof";
import { collectBody, exchange } from "./exchange";
import { DataEndpoint, type RecordCarrier } from "./endpoint";
import {
  DataKind,
  DATA_PLANE_VERSION,
  INITIAL_STREAM_WINDOW_BYTES,
  MAX_BULK_STREAM_WINDOW_BYTES,
} from "./frame";
import { decodeResumePayload } from "./resume";
import { AuthenticatedChannel } from "./authenticated-channel";
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

async function bulkEndpoints() {
  const [clientCarrier, serverCarrier] = carriers();
  const key = await deriveChannelSessionKey(
    "0123456789abcdef".repeat(4),
    "hosted:test",
    "00112233445566778899aabbccddeeff",
    "ffeeddccbbaa99887766554433221100",
  );
  const options = { key, maxBulkStreamWindowBytes: MAX_BULK_STREAM_WINDOW_BYTES };
  const client = new DataEndpoint({ role: "client", carrier: clientCarrier, ...options });
  const server = new DataEndpoint({ role: "server", carrier: serverCarrier, ...options });
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
  it("bounds Preview and ordinary streams to the same logical receive window", async () => {
    const stack = await bulkEndpoints();
    stack.server.onIncoming((stream) => {
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        await stream.respond({ status: 204, metadata: null, bodyLength: 0 });
        await stream.finish();
      })());
    });

    const preview = stack.client.open(head("asset.preview", 0));
    await preview.finish();
    await preview.done;
    const regular = stack.client.open(head("workspace.list", 0));
    await regular.finish();
    await regular.done;

    const opens: Array<{ method: string; window: number }> = [];
    for (const [index, record] of stack.clientCarrier.sent.entries()) {
      const plaintext = await openDataRecord(
        stack.key,
        "client-to-daemon",
        index + 1,
        record,
      );
      if (plaintext[1] !== 1) continue;
      const frame = decodeResumePayload(plaintext).frame;
      if (frame.kind !== DataKind.Open) continue;
      const request = JSON.parse(new TextDecoder().decode(frame.payload)) as {
        method: string;
      };
      opens.push({ method: request.method, window: frame.value });
    }
    expect(opens).toEqual([
      { method: "asset.preview", window: INITIAL_STREAM_WINDOW_BYTES },
      { method: "workspace.list", window: INITIAL_STREAM_WINDOW_BYTES },
    ]);
  });

  it("runs independent streaming exchanges over one carrier", async () => {
    const stack = await endpoints();
    stack.server.onIncoming((stream) => {
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

    const source = new Uint8Array(2 * 1024 * 1024);
    source.forEach((_, index) => (source[index] = index % 251));
    const response = await exchange(stack.client, head("echo", source.byteLength), source);
    expect(response.head).toMatchObject({ status: 200, metadata: { method: "echo" } });
    expect(await collectBody(response.body, source.byteLength)).toEqual(source);
    await response.stream.done;
    expect(stack.client.activeStreamCount).toBe(0);
    await waitFor(() => stack.server.activeStreamCount === 0);
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
      if (plaintext[1] !== 1) continue;
      const frame = decodeResumePayload(plaintext).frame;
      if (frame.kind === DataKind.Data) dataIds.push(frame.streamId);
    }
    expect(dataIds.slice(0, 6)).toEqual([one.id, two.id, one.id, two.id, one.id, two.id]);
  });

  it("sends a terminal reset even while the stream's OPEN is in flight", async () => {
    const stack = await endpoints();
    const stream = stack.client.open(head("cancel", 0));
    stream.reset();
    await stack.client.ready();
    await waitFor(async () => {
      const frames = await Promise.all(stack.clientCarrier.sent.map(async (record, i) =>
        openDataRecord(stack.key, "client-to-daemon", i + 1, record)));
      return frames.filter((bytes) => bytes[1] === 1).length === 2;
    });

    const kinds = await Promise.all(
      stack.clientCarrier.sent.map(async (record, index) => {
        const plaintext = await openDataRecord(
          stack.key,
          "client-to-daemon",
          index + 1,
          record,
        );
        return plaintext[1] === 1 ? decodeResumePayload(plaintext).frame.kind : null;
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

  it("keeps the same stream and handler across a fresh authenticated carrier", async () => {
    const stack = await endpoints();
    let handlers = 0;
    let incomingId = 0;
    stack.server.onIncoming((stream) => {
      handlers++; incomingId = stream.id;
      handlerTasks.push((async () => {
        const request = await collectBody(stream.body(), 1024);
        await stream.respond({ status: 200, metadata: null, bodyLength: request.length });
        await stream.write(request);
        await stream.finish();
      })());
    });
    const stream = stack.client.open(head("echo", 6));
    await stream.write(new Uint8Array([1, 2, 3]));
    await waitFor(() => handlers === 1);
    const id = stack.client.logicalId;
    stack.clientCarrier.close("fault: physical connection lost");
    await waitFor(() => stack.client.recovering && stack.server.recovering);
    expect(stack.client.activeStreamCount).toBe(1);
    expect(stack.server.activeStreamCount).toBe(1);
    const [clientCarrier, serverCarrier] = carriers();
    const fresh = await deriveChannelSessionKey("0123456789abcdef".repeat(4), "hosted:test",
      "11223344556677889900aabbccddeeff", "aabbccddeeff00112233445566778899");
    await Promise.all([stack.server.attach(serverCarrier, fresh), stack.client.attach(clientCarrier, fresh)]);
    expect(stack.client.logicalId).toBe(id);
    await stream.write(new Uint8Array([4, 5, 6]));
    await stream.finish();
    expect(await collectBody(stream.body(), 6)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    await stream.done;
    expect(handlers).toBe(1);
    expect(incomingId).toBe(stream.id);
  });

  it.each(["client", "server"] as const)("retires %s FIN from the resume watermark when its ACK was lost", async (sender) => {
    const stack = await endpoints();
    await Promise.all([stack.client.ready(), stack.server.ready()]);
    let finSequence: bigint | null = null;
    let dropped = false;
    const transmit = sender === "client" ? stack.clientCarrier : stack.serverCarrier;
    const acknowledge = sender === "client" ? stack.serverCarrier : stack.clientCarrier;
    transmit.beforeDelivery = async (record, sequence) => {
      const bytes = await openDataRecord(stack.key, sender === "client" ? "client-to-daemon" : "daemon-to-client", sequence, record);
      if (bytes[1] === 1) {
        const payload = decodeResumePayload(bytes);
        if (payload.frame.kind === DataKind.Fin) finSequence = payload.seq;
      }
    };
    acknowledge.beforeDelivery = async (record, sequence) => {
      const bytes = await openDataRecord(stack.key, sender === "client" ? "daemon-to-client" : "client-to-daemon", sequence, record);
      if (bytes[1] === 2 && finSequence !== null && new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(12) >= finSequence) {
        dropped = true;
        acknowledge.close("fault: FIN acknowledgement lost");
      }
    };
    let handlers = 0;
    let senderFinished = false;
    stack.server.onIncoming((stream) => {
      handlers++;
      handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        await stream.respond({ status: 204, metadata: null, bodyLength: 0 });
        await stream.finish();
        if (sender === "server") senderFinished = true;
      })());
    });
    const stream = stack.client.open(head("empty", 0));
    const finished = stream.finish().then(() => { if (sender === "client") senderFinished = true; });
    await waitFor(() => dropped && stack.client.recovering && stack.server.recovering);
    const [clientCarrier, serverCarrier] = carriers();
    const fresh = await deriveChannelSessionKey("0123456789abcdef".repeat(4), "hosted:test",
      "11223344556677889900aabbccddeeff", "aabbccddeeff00112233445566778899");
    let releaseAck!: () => void;
    const delayedAck = new Promise<void>((resolve) => { releaseAck = resolve; });
    const resumedAcknowledge = sender === "client" ? serverCarrier : clientCarrier;
    resumedAcknowledge.beforeDelivery = async (record, sequence) => {
      const bytes = await openDataRecord(fresh, sender === "client" ? "daemon-to-client" : "client-to-daemon", sequence, record);
      if (bytes[1] === 2) await delayedAck;
    };
    try {
      await Promise.all([stack.server.attach(serverCarrier, fresh), stack.client.attach(clientCarrier, fresh)]);
      // The authenticated activation watermark itself acknowledges the FIN.
      // A subsequent regular ACK is delayed at the real encrypted carrier seam.
      await waitFor(() => senderFinished);
    } finally { releaseAck(); }
    await Promise.all([finished, stream.done]);
    await waitFor(() => stack.client.activeStreamCount === 0 && stack.server.activeStreamCount === 0);
    expect(handlers).toBe(1);
  });

  it("keeps the healthy carrier working until a differently authenticated RTC candidate activates", async () => {
    const stack = await endpoints();
    const received: number[] = [];
    let handlers = 0;
    stack.server.onIncoming((stream) => {
      handlers++;
      handlerTasks.push((async () => {
        for await (const chunk of stream.body()) received.push(...chunk);
        await stream.respond({ status: 200, metadata: null, bodyLength: 6 });
        await stream.write(new Uint8Array(received)); await stream.finish();
      })());
    });
    const stream = stack.client.open(head("handoff", 6));
    await stream.write(new Uint8Array([1, 2, 3]));
    await waitFor(() => received.length === 3);
    const id = stack.client.logicalId;
    const [clientCarrier, serverCarrier] = carriers();
    const fresh = await deriveChannelSessionKey("rtc-admission-secret", "hosted:rtc-candidate", randomToken(1), randomToken(2));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    clientCarrier.beforeDelivery = async () => held;
    const attached = Promise.all([stack.server.attach(serverCarrier, fresh, "rtc"), stack.client.attach(clientCarrier, fresh, "rtc")]);
    try {
      await stream.write(new Uint8Array([4]));
      await waitFor(() => received.length === 4);
      expect(stack.client.recovering).toBe(false);
    } finally { release(); }
    await attached;
    expect(stack.client.logicalId).toBe(id);
    expect(stack.client.activePath).toBe("rtc");
    await stream.write(new Uint8Array([5, 6])); await stream.finish();
    expect(await collectBody(stream.body(), 6)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    await stream.done;
    expect(handlers).toBe(1);
  });

  it.each(["rtc", "base"])("survives loss of %s without replaying a business operation", async (failed) => {
    const stack = await endpoints();
    let handlers = 0;
    stack.server.onIncoming(stream => handlerTasks.push((async () => {
      handlers++;
      const bytes = await collectBody(stream.body(), 4);
      await stream.respond({ status: 200, metadata: null, bodyLength: 4 });
      await stream.write(bytes); await stream.finish();
    })()));
    const stream = stack.client.open(head("one-operation", 4));
    await stream.write(new Uint8Array([1]));
    await waitFor(() => handlers === 1);
    const id = stack.client.logicalId;
    const [rtcClient, rtcServer] = carriers();
    const key = await deriveChannelSessionKey("rtc-fallback", "hosted:rtc", randomToken(11), randomToken(12));
    await Promise.all([stack.server.attach(rtcServer, key, "rtc"), stack.client.attach(rtcClient, key, "rtc")]);
    await stream.write(new Uint8Array([2]));
    (failed === "rtc" ? rtcClient : stack.clientCarrier).close("injected physical failure");
    await waitFor(() => stack.client.activePath === (failed === "rtc" ? "loopback" : "rtc"));
    expect(stack.client.logicalId).toBe(id);
    await stream.write(new Uint8Array([3, 4])); await stream.finish();
    expect(await collectBody(stream.body(), 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await stream.done;
    expect(handlers).toBe(1);
  });

  it("fences a queued old base record during authenticated failback", async () => {
    const stack = await endpoints();
    await Promise.all([stack.client.ready(), stack.server.ready()]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let heldRecord = false, reattaching = false;
    stack.serverCarrier.beforeDelivery = async () => { heldRecord = true; await held; };
    stack.clientCarrier.beforeDelivery = async (record, sequence) => {
      const bytes = await openDataRecord(stack.key, "client-to-daemon", sequence, record);
      if (bytes[1] === 16 && JSON.parse(new TextDecoder().decode(bytes.subarray(4))).op === "attach") reattaching = true;
    };
    let handlers = 0;
    stack.server.onIncoming(stream => handlerTasks.push((async () => {
      handlers++;
      const bytes = await collectBody(stream.body(), 2);
      await stream.respond({ status: 200, metadata: null, bodyLength: 2 });
      await stream.write(bytes); await stream.finish();
    })()));
    const stream = stack.client.open(head("queued-record", 2));
    try {
      await stream.write(new Uint8Array([1]));
      await waitFor(() => heldRecord && handlers === 1);
      const [rtcClient, rtcServer] = carriers();
      const key = await deriveChannelSessionKey("rtc-queued", "hosted:rtc", randomToken(15), randomToken(16));
      await Promise.all([stack.server.attach(rtcServer, key, "rtc"), stack.client.attach(rtcClient, key, "rtc")]);
      rtcClient.close("fault before old record drains");
      await waitFor(() => reattaching);
    } finally { release(); }
    await waitFor(() => stack.client.activePath === "loopback");
    await stream.write(new Uint8Array([2])); await stream.finish();
    expect(await collectBody(stream.body(), 2)).toEqual(new Uint8Array([1, 2]));
    await stream.done;
    expect(handlers).toBe(1);
  });

  it("keeps the idle base probed beyond the channel timeout and uses it on heartbeat failure", async () => {
    const stack = await endpoints();
    await Promise.all([stack.client.ready(), stack.server.ready()]);
    const [rtcClient, rtcServer] = carriers();
    const key = await deriveChannelSessionKey("rtc-idle", "hosted:rtc", randomToken(13), randomToken(14));
    await Promise.all([stack.server.attach(rtcServer, key, "rtc"), stack.client.attach(rtcClient, key, "rtc")]);
    await new Promise(resolve => setTimeout(resolve, 16_000));
    expect(stack.client.hasPath("loopback")).toBe(true);
    expect(stack.server.hasPath("loopback")).toBe(true);
    stack.client.failActivePath(new Error("application heartbeat timed out"));
    await waitFor(() => stack.client.activePath === "loopback" && stack.server.activePath === "loopback");
    expect(stack.client.recovering).toBe(false);
  }, 25_000);

  it("rejects a fresh authenticated peer without old-server possession and keeps the healthy connection", async () => {
    const stack = await endpoints();
    await Promise.all([stack.client.ready(), stack.server.ready()]);
    const id = stack.client.logicalId;
    const [clientCarrier, serverCarrier] = carriers();
    const fresh = await deriveChannelSessionKey("different-peer-secret", "hosted:wrong-peer", randomToken(3), randomToken(4));
    const forged = new AuthenticatedChannel({ role: "server", carrier: serverCarrier, key: fresh,
      onPlaintext() {
        const json = new TextEncoder().encode(JSON.stringify({ op: "attached", epoch: "1", proof: "0".repeat(64) }));
        const bytes = new Uint8Array(4 + json.length); bytes.set([4, 16, 0, 0]); bytes.set(json, 4);
        void forged.send(bytes).catch(() => {});
      }, onClose() {},
    });
    try {
      await expect(stack.client.attach(clientCarrier, fresh, "rtc")).rejects.toThrow("server possession");
      expect(stack.client.logicalId).toBe(id);
      expect(stack.client.recovering).toBe(false);
      stack.server.onIncoming((stream) => handlerTasks.push((async () => {
        await collectBody(stream.body(), 0);
        await stream.respond({ status: 204, metadata: null, bodyLength: 0 }); await stream.finish();
      })()));
      const response = await exchange(stack.client, head("still-live", 0));
      expect(response.head.status).toBe(204);
      await response.stream.done;
    } finally { forged.close(); }
  });

  it.each(["activated", "synced"])("recovers the committed epoch after losing %s without opening a second stream", async (lost) => {
    const stack = await endpoints();
    let handlers = 0;
    stack.server.onIncoming((stream) => handlerTasks.push((async () => {
      handlers++;
      const bytes = await collectBody(stream.body(), 2);
      await stream.respond({ status: 200, metadata: null, bodyLength: 2 });
      await stream.write(bytes); await stream.finish();
    })()));
    const stream = stack.client.open(head("handoff-response-loss", 2));
    await stream.write(new Uint8Array([1]));
    await waitFor(() => handlers === 1);
    const [clientCarrier, serverCarrier] = carriers();
    const fresh = await deriveChannelSessionKey("rtc-admission-secret", "hosted:rtc-candidate", randomToken(5), randomToken(6));
    let fault = false;
    serverCarrier.beforeDelivery = async (record, sequence) => {
      const bytes = await openDataRecord(fresh, "daemon-to-client", sequence, record);
      if (bytes[1] === 16 && JSON.parse(new TextDecoder().decode(bytes.subarray(4))).op === lost) {
        fault = true; serverCarrier.close("fault: activation response lost");
      }
    };
    await Promise.allSettled([stack.server.attach(serverCarrier, fresh, "rtc"), stack.client.attach(clientCarrier, fresh, "rtc")]);
    expect(fault).toBe(true);
    // Even ambiguous activation loss must use a new epoch on the retained
    // authenticated base, without creating another business stream.
    await waitFor(() => stack.client.activePath === "loopback" && stack.server.activePath === "loopback");
    await stream.write(new Uint8Array([2])); await stream.finish();
    expect(await collectBody(stream.body(), 2)).toEqual(new Uint8Array([1, 2]));
    await stream.done;
    expect(handlers).toBe(1);
  });

  it("refuses a Fabric candidate for an immutable direct-only stream owner", async () => {
    const [clientCarrier, serverCarrier] = carriers();
    const key = await deriveChannelSessionKey("direct-secret", "hosted:direct", randomToken(9), randomToken(10));
    const client = new DataEndpoint({ role: "client", carrier: clientCarrier, key, policy: "direct-only", path: "rtc" });
    const server = new DataEndpoint({ role: "server", carrier: serverCarrier, key, policy: "direct-only", path: "rtc" });
    cleanup.push(client, server);
    await Promise.all([client.ready(), server.ready()]);
    const [candidate, other] = carriers();
    try {
      await expect(client.attach(candidate, key, "fabric")).rejects.toThrow("PolicyDenied");
      expect(client.activePath).toBe("rtc");
      expect(candidate.sent).toHaveLength(0);
    } finally { candidate.close(); other.close(); }
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

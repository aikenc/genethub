import type { SequencedEvent } from "@genehub/proto";
import { describe, expect, it, vi } from "vitest";

import {
  channelServerProof,
  deriveChannelSessionKey,
  hostedChannelContext,
  openChannelFrame,
  sealChannelFrame,
} from "../devices/proof";

import {
  Client,
  ClientQueueFullError,
  ClientRequestTimeoutError,
  ConnectionOutcomeUnknownError,
  type LocalServerProof,
  type WebSocketLike,
} from "./client";
import { socketQueue, type FakeSocket } from "./fake-socket";

function event(seq: number, text: string): SequencedEvent {
  return {
    seq,
    sessionId: "s1",
    event: {
      type: "item",
      turnId: "t1",
      item: { type: "assistantMessage", id: `a${seq}`, text },
    },
  };
}

/** Lets queued microtasks run, which is how the client's awaits progress. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function localProof(suffix: string, expiresAt = Math.ceil(Date.now() / 1000) + 10): LocalServerProof {
  return {
    proof: suffix.repeat(64),
    challenge: suffix.repeat(64),
    pid: 42,
    machineId: "m_local",
    fingerprint: "FP-LOCAL",
    expiresAt,
  };
}

function acceptLocal(socket: FakeSocket, proof: LocalServerProof): void {
  const hello = socket.lastOf("hello");
  socket.reply(hello.id, {
    type: "hello",
    data: {
      daemonVersion: "test",
      protocolVersion: 2,
      machineId: proof.machineId,
      machineName: "local",
      fingerprint: proof.fingerprint,
      transport: "loopback",
      proof: proof.proof,
    },
  });
}

async function connected(): Promise<{
  client: Client;
  socket: FakeSocket;
  queue: ReturnType<typeof socketQueue>;
}> {
  const queue = socketQueue();
  const client = new Client({
    url: "ws://test",
    socketFactory: queue.factory,
    backoffMs: () => 0,
  });
  client.connect();
  queue.latest().open();
  await settle();
  queue.latest().acceptHandshake();
  await settle();
  return { client, socket: queue.latest(), queue };
}

describe("the daemon connection", () => {
  it("requires an out-of-band server proof before trusting a loopback listener", async () => {
    const queue = socketQueue();
    const expected = localProof("b");
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws?proof=client-only",
      localServerProof: expected,
      socketFactory: queue.factory,
    });
    client.connect();
    const socket = queue.latest();
    socket.open();
    await settle();
    acceptLocal(socket, { ...expected, proof: "c".repeat(64) });
    await settle();

    expect(socket.closed).toBe(true);
    expect(client.connectionState).toBe("closed");
    expect(client.failure?.code).toBe("unauthorized");
  });

  it("accepts a fresh local server proof and rejects an expired one", async () => {
    const queue = socketQueue();
    const expected = localProof("d");
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws?proof=client-only",
      localServerProof: expected,
      socketFactory: queue.factory,
    });
    client.connect();
    queue.latest().open();
    await settle();
    acceptLocal(queue.latest(), expected);
    await settle();
    expect(client.connectionState).toBe("ready");
    client.close();

    const expiredQueue = socketQueue();
    const expired = localProof("e", 1);
    const rejected = new Client({
      url: "ws://127.0.0.1:42124/ws?proof=client-only",
      localServerProof: expired,
      socketFactory: expiredQueue.factory,
    });
    rejected.connect();
    expiredQueue.latest().open();
    await settle();
    acceptLocal(expiredQueue.latest(), expired);
    await settle();
    expect(expiredQueue.latest().closed).toBe(true);
    expect(rejected.connectionState).toBe("closed");
  });

  it("requires fresh local and hosted credentials on every redial", async () => {
    const localQueue = socketQueue();
    const first = localProof("f");
    const second = localProof("1");
    const local = new Client({
      url: "ws://127.0.0.1:1/first",
      localServerProof: first,
      redial: () =>
        Promise.resolve({ url: "ws://127.0.0.1:1/second", localServerProof: second }),
      socketFactory: localQueue.factory,
      backoffMs: () => 0,
    });
    local.connect();
    localQueue.latest().open();
    await settle();
    acceptLocal(localQueue.latest(), first);
    await settle();
    localQueue.latest().close();
    for (let turn = 0; turn < 5 && localQueue.sockets.length < 2; turn += 1) await settle();
    localQueue.latest().open();
    await settle();
    // A proof from the spent first admission cannot authenticate the new epoch.
    acceptLocal(localQueue.latest(), first);
    await settle();
    expect(local.connectionState).toBe("closed");

    const hostedQueue = socketQueue();
    const hosted = new Client({
      url: "wss://relay.test/first",
      channelCredential: { capabilityId: "cap_first", secret: "2".repeat(64) },
      redial: () => Promise.resolve({ url: "wss://relay.test/second" }),
      socketFactory: hostedQueue.factory,
      backoffMs: () => 0,
    });
    hosted.connect();
    hostedQueue.latest().close();
    await settle();
    await settle();
    expect(hosted.connectionState).toBe("closed");
    expect(hostedQueue.sockets).toHaveLength(1);
  });

  it.each([
    { capabilityId: null, secret: "3".repeat(64) },
    { capabilityId: "cap_second", secret: null },
    { capabilityId: 42, secret: "3".repeat(64) },
    { capabilityId: "cap_second", secret: { length: 64 } },
  ])(
    "fail-closes a malformed hosted credential returned by redial: %j",
    async (malformed) => {
      const queue = socketQueue();
      const client = new Client({
        url: "wss://relay.test/first",
        channelCredential: {
          capabilityId: "cap_first",
          secret: "2".repeat(64),
        },
        redial: () =>
          Promise.resolve({
            url: "wss://relay.test/second",
            channelCredential: malformed as unknown as {
              capabilityId: string;
              secret: string;
            },
          }),
        socketFactory: queue.factory,
        backoffMs: () => 0,
      });
      client.connect();
      queue.latest().close();
      for (let turn = 0; turn < 5 && client.connectionState !== "closed"; turn += 1)
        await settle();

      expect(client.connectionState).toBe("closed");
      expect(client.failure?.code).toBe("unauthorized");
      expect(queue.sockets).toHaveLength(1);
    },
  );

  it("fail-closes plaintext business replies while the client proof is still pending", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "wss://relay.test",
      channelCredential: {
        capabilityId: "capability_strict_hello",
        secret: "1".repeat(64),
      },
      socketFactory: queue.factory,
    });
    // The workbench asks for its catalog immediately after connect(), before
    // the authenticated channel is ready. Its predictable correlation id must
    // not turn the asynchronous WebCrypto proof window into a plaintext reply
    // injection window for the Relay.
    const queued = client.call({ type: "agent.list" });
    client.connect();
    const socket = queue.latest();
    socket.open();
    socket.reply("1", { type: "agents", data: [] });

    await expect(queued).rejects.toThrow(/closed/);
    expect(socket.closed).toBe(true);
    expect(client.connectionState).toBe("closed");
  });

  it.each([
    JSON.stringify({
      type: "result",
      id: "not-the-current-hello",
      ok: true,
      payload: { type: "hello", data: {} },
    }),
    JSON.stringify({ type: "notice", level: "info", message: "injected" }),
    "not-json",
  ])("fail-closes any non-Hello plaintext during channel setup", async (raw) => {
    const queue = socketQueue();
    const client = new Client({
      url: "wss://relay.test",
      channelCredential: {
        capabilityId: "capability_strict_plaintext",
        secret: "2".repeat(64),
      },
      socketFactory: queue.factory,
    });
    client.connect();
    const socket = queue.latest();
    socket.open();
    socket.onmessage?.({ data: raw });

    for (let turn = 0; turn < 5 && !socket.closed; turn += 1) await settle();
    expect(socket.closed).toBe(true);
    expect(client.connectionState).toBe("closed");
  });

  it("ignores an exact Hello correlation delivered by an old socket epoch", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "wss://relay.test/first",
      redial: () =>
        Promise.resolve({
          url: "wss://relay.test/second",
          channelCredential: {
            capabilityId: "capability_second_epoch",
            secret: "4".repeat(64),
          },
        }),
      channelCredential: {
        capabilityId: "capability_first_epoch",
        secret: "3".repeat(64),
      },
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });
    client.connect();
    const first = queue.latest();
    first.open();
    first.close();
    for (let turn = 0; turn < 5 && queue.sockets.length < 2; turn += 1) await settle();

    const second = queue.latest();
    expect(second).not.toBe(first);
    second.open();
    first.reply("1", {
      type: "hello",
      data: {
        daemonVersion: "attacker",
        protocolVersion: 2,
        machineId: "wrong",
        machineName: "wrong",
        fingerprint: "wrong",
        transport: "forwarded",
      },
    });
    await settle();

    expect(second.closed).toBe(false);
    expect(client.connectionState).not.toBe("ready");
    client.close();
  });

  it("serializes an immediate authenticated push behind asynchronous key derivation", async () => {
    const capabilityId = "capability_test";
    const secret = "2".repeat(64);
    const context = hostedChannelContext(capabilityId);
    const serverNonce = "server-nonce";
    let socket!: WebSocketLike;
    const notices: string[] = [];
    const sent: unknown[] = [];
    socket = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close() {},
      send(raw: string) {
        sent.push(JSON.parse(raw));
        void (async () => {
          const outer = JSON.parse(raw) as {
            id: string;
            type: string;
            payload?: {
              channel?: { nonce: string };
              sequence?: number;
              body?: string;
              mac?: string;
            };
          };
          if (outer.type === "hello") {
            const nonce = outer.payload!.channel!.nonce;
            const proof = await channelServerProof(secret, context, nonce, serverNonce);
            const key = await deriveChannelSessionKey(secret, context, nonce, serverNonce);
            const pushed = await sealChannelFrame(
              key,
              "daemon-to-client",
              1,
              JSON.stringify({ type: "notice", level: "info", message: "encrypted push" }),
            );
            socket.onmessage?.({
              data: JSON.stringify({
                type: "result",
                id: outer.id,
                ok: true,
                payload: {
                  type: "hello",
                  data: {
                    daemonVersion: "",
                    protocolVersion: 2,
                    machineId: "",
                    machineName: "",
                    fingerprint: "",
                    transport: "forwarded",
                    proof,
                    serverNonce,
                  },
                },
              }),
            });
            // Same JavaScript turn: the browser has not yet resumed the Hello
            // promise or completed its WebCrypto key derivation.
            socket.onmessage?.({
              data: JSON.stringify({ type: "authenticated", sequence: 1, ...pushed }),
            });
            return;
          }
          if (outer.type === "authenticated") {
            const hello = sent[0] as { payload: { channel: { nonce: string } } };
            const nonce = hello.payload.channel.nonce;
            const key = await deriveChannelSessionKey(secret, context, nonce, serverNonce);
            const inner = JSON.parse(
              await openChannelFrame(
                key,
                "client-to-daemon",
                outer.payload!.sequence!,
                outer.payload!.body!,
                outer.payload!.mac!,
              ),
            ) as { id: string };
            const identity = await sealChannelFrame(
              key,
              "daemon-to-client",
              2,
              JSON.stringify({
                type: "result",
                id: inner.id,
                ok: true,
                payload: {
                  type: "hello",
                  data: {
                    daemonVersion: "test",
                    protocolVersion: 2,
                    machineId: "m_test",
                    machineName: "测试机器",
                    fingerprint: "AAAA-BBBB",
                    transport: "forwarded",
                  },
                },
              }),
            );
            socket.onmessage?.({
              data: JSON.stringify({ type: "authenticated", sequence: 2, ...identity }),
            });
          }
        })();
      },
    };
    const client = new Client({
      url: "wss://relay.test",
      channelCredential: { capabilityId, secret },
      socketFactory: () => socket,
    });
    client.onNotice((_level, message) => notices.push(message));
    client.connect();
    socket.onopen?.({});
    for (let turn = 0; turn < 12 && client.connectionState !== "ready"; turn += 1) {
      await settle();
    }

    expect(client.connectionState).toBe("ready");
    expect(notices).toEqual(["encrypted push"]);
    const uncertain = client.call({ type: "agent.list" });
    // Drop in the same turn, while WebCrypto still owns the queued plaintext.
    // The request must reject and retain its byte reservation until encryption
    // unwinds; it may never dangle or be replayed on a new epoch.
    socket.onclose?.({});
    await expect(uncertain).rejects.toBeInstanceOf(
      ConnectionOutcomeUnknownError,
    );
    client.close();
  });

  it("repeats whatever the close frame said, since nothing else records it", async () => {
    const { client, socket } = await connected();

    const uncertain = client.call({ type: "agent.list" });
    // Exactly what Relay sends when a client falls behind its send budget.
    socket.close({ code: 1013, reason: "too slow" });

    await expect(uncertain).rejects.toThrow("1013 too slow");
    expect(client.lastCloseReason).toEqual({ code: 1013, reason: "too slow" });
    client.close();
  });

  it("fail-closes when authenticated receive work exceeds its frame budget", async () => {
    const capabilityId = "capability_backlog";
    const secret = "3".repeat(64);
    const context = hostedChannelContext(capabilityId);
    const serverNonce = "server-nonce";
    let closed = false;
    let socket!: WebSocketLike;
    socket = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close() {
        closed = true;
      },
      send(raw: string) {
        const hello = JSON.parse(raw) as {
          id: string;
          type: string;
          payload: { channel: { nonce: string } };
        };
        if (hello.type !== "hello") return;
        void (async () => {
          const proof = await channelServerProof(
            secret,
            context,
            hello.payload.channel.nonce,
            serverNonce,
          );
          socket.onmessage?.({
            data: JSON.stringify({
              type: "result",
              id: hello.id,
              ok: true,
              payload: {
                type: "hello",
                data: {
                  daemonVersion: "",
                  protocolVersion: 2,
                  machineId: "",
                  machineName: "",
                  fingerprint: "",
                  transport: "forwarded",
                  proof,
                  serverNonce,
                },
              },
            }),
          });
          const queued = JSON.stringify({
            type: "authenticated",
            sequence: 1,
            body: "queued",
            mac: "queued",
          });
          socket.onmessage?.({ data: queued });
          socket.onmessage?.({ data: queued });
        })();
      },
    };
    const client = new Client({
      url: "wss://relay.test",
      channelCredential: { capabilityId, secret },
      socketFactory: () => socket,
      maxReceiveBacklogFrames: 2,
    });
    client.connect();
    socket.onopen?.({});
    for (let turn = 0; turn < 10 && !closed; turn += 1) await settle();

    expect(closed).toBe(true);
    expect(client.connectionState).toBe("closed");
  });

  it("drops an oversized raw frame before JSON parsing or receive-chain growth", async () => {
    const { client, socket } = await connected();
    socket.onmessage?.({ data: "x".repeat(4 * 1024 * 1024 + 1) });
    await settle();
    expect(socket.closed).toBe(true);
    expect(client.connectionState).toBe("closed");
  });

  it("says hello before anything else, and only then reports itself ready", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
    });
    client.connect();
    queue.latest().open();
    await settle();

    expect(queue.latest().sent[0]?.type).toBe("hello");
    expect(client.connectionState).toBe("connecting");

    queue.latest().acceptHandshake();
    await settle();
    expect(client.connectionState).toBe("ready");
  });

  it("holds a request typed during a blip and sends it when the socket returns", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });
    client.connect();

    // Nothing is open yet; this must not throw and must not be lost.
    const pending = client.call({ type: "agent.list" });

    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    const sent = queue.latest().lastOf("agent.list");
    queue.latest().reply(sent.id, { type: "agents", data: [] });
    expect(await pending).toEqual({ type: "agents", data: [] });
  });

  it("never replays a request whose execution became unknown after a drop", async () => {
    const { client, queue } = await connected();
    const first = queue.latest();
    const pending = client.call({ type: "agent.list" });
    expect(first.lastOf("agent.list")).toBeDefined();

    first.close();
    await expect(pending).rejects.toBeInstanceOf(ConnectionOutcomeUnknownError);
    await settle();

    const second = queue.latest();
    second.open();
    await settle();
    second.acceptHandshake();
    await settle();
    expect(second.sent.filter((frame) => frame.type === "agent.list")).toEqual([]);
    client.close();
  });

  it("bounds the offline request queue instead of growing memory without limit", async () => {
    const client = new Client({
      url: "ws://test",
      maxQueuedRequests: 1,
    });
    const first = client.call({ type: "agent.list" });
    void first.catch(() => {});

    await expect(client.call({ type: "agent.list" })).rejects.toBeInstanceOf(
      ClientQueueFullError,
    );
    client.close();
  });

  it("bounds all unresolved business requests after the socket is ready", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
      maxPendingRequests: 1,
    });
    client.connect();
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    const first = client.call({ type: "agent.list" });
    void first.catch(() => {});
    await expect(client.call({ type: "agent.list" })).rejects.toBeInstanceOf(
      ClientQueueFullError,
    );
    client.close();
  });

  it("accounts queued and sent request bytes once and releases them on reply", async () => {
    const oneFrame = new TextEncoder().encode(
      JSON.stringify({ id: "2", type: "agent.list" }),
    ).byteLength;
    const queue = socketQueue();
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
      maxPendingBytes: oneFrame,
    });
    client.connect();
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    const first = client.call({ type: "agent.list" });
    await expect(client.call({ type: "agent.list" })).rejects.toBeInstanceOf(
      ClientQueueFullError,
    );
    queue.latest().reply(queue.latest().lastOf("agent.list").id, {
      type: "agents",
      data: [],
    });
    await first;

    const afterReply = client.call({ type: "agent.list" });
    queue.latest().reply(queue.latest().lastOf("agent.list").id, {
      type: "agents",
      data: [],
    });
    await afterReply;
    client.close();
  });

  it("releases queued byte reservations after their total deadline", async () => {
    vi.useFakeTimers();
    try {
      const oneFrame = new TextEncoder().encode(
        JSON.stringify({ id: "1", type: "agent.list" }),
      ).byteLength;
      const client = new Client({
        url: "ws://test",
        maxPendingBytes: oneFrame,
        maxQueueAgeMs: 10,
      });
      const expired = client.call({ type: "agent.list" });
      await expect(client.call({ type: "agent.list" })).rejects.toBeInstanceOf(
        ClientQueueFullError,
      );
      const rejected = expect(expired).rejects.toBeInstanceOf(
        ClientRequestTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejected;

      const admitted = client.call({ type: "agent.list" });
      void admitted.catch(() => {});
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a request that waited too long for any authenticated socket", async () => {
    vi.useFakeTimers();
    try {
      const client = new Client({
        url: "ws://test",
        maxQueueAgeMs: 25,
      });
      const pending = client.call({ type: "agent.list" });
      const rejected = expect(pending).rejects.toBeInstanceOf(
        ClientRequestTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one total request deadline across queueing and sending", async () => {
    vi.useFakeTimers();
    try {
      const queue = socketQueue();
      const client = new Client({
        url: "ws://test",
        socketFactory: queue.factory,
        maxQueueAgeMs: 1_000,
        requestTimeoutMs: 50,
      });
      client.connect();
      const pending = client.call({ type: "agent.list" });
      const rejected = expect(pending).rejects.toBeInstanceOf(
        ClientRequestTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(40);
      queue.latest().open();
      await Promise.resolve();
      queue.latest().acceptHandshake();
      await Promise.resolve();
      expect(queue.latest().lastOf("agent.list")).toBeDefined();

      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a refused request into a rejection carrying the daemon's reason", async () => {
    const { client, socket } = await connected();
    const pending = client.call({
      type: "session.get",
      payload: { sessionId: "nope" },
    });
    socket.fail(socket.lastOf("session.get").id, "notFound", "no such session");

    await expect(pending).rejects.toThrow("no such session");
  });

  it("asks for the gap by sequence number after a reconnect, not for everything", async () => {
    const { client, queue } = await connected();

    const seen: number[] = [];
    const resyncs: Array<{ replayed: number[]; reset: boolean }> = [];
    const subscribing = client.subscribe("s1", {
      onEvent: (e) => seen.push(e.seq),
      onResync: (_snapshot, replayed, reset) => {
        resyncs.push({ replayed: replayed.map((e) => e.seq), reset });
      },
    });

    const first = queue.latest();
    first.reply(first.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: snapshot(), replayed: [], reset: false },
    });
    await subscribing;

    first.event("s1", event(1, "one"));
    first.event("s1", event(2, "two"));
    expect(seen).toEqual([1, 2]);

    first.close();
    await settle();
    expect(client.connectionState).toBe("reconnecting");

    const second = queue.latest();
    expect(second).not.toBe(first);
    second.open();
    await settle();
    second.acceptHandshake();
    await settle();

    const resubscribe = second.lastOf("subscribe");
    expect(resubscribe.payload).toMatchObject({ sessionId: "s1", sinceSeq: 2 });

    second.reply(resubscribe.id, {
      type: "subscribed",
      data: {
        snapshot: snapshot(),
        replayed: [event(3, "three")],
        reset: false,
      },
    });
    await settle();

    expect(resyncs).toEqual([{ replayed: [3], reset: false }]);
  });

  it("keeps escalating the backoff while every fresh connection dies at once", async () => {
    const queue = socketQueue();
    const attempts: number[] = [];
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
      backoffMs: (attempt) => {
        attempts.push(attempt);
        return 0;
      },
    });
    client.connect();
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    queue.latest().close();
    await settle();

    // The redial and its handshake both succeed, which used to reset the
    // counter on the spot — so a far side that kills every fresh channel a
    // second after it opens became a one-second dial loop, forever.
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    queue.latest().close();
    await settle();

    expect(attempts).toEqual([0, 1]);
    client.close();
  });

  /**
   * The daemon dropping events used to arrive as a sentence in English asking
   * the person to reconnect. Anyone who did not reconnect kept a timeline with a
   * hole in it — a half-finished answer that never moved again — and anyone who
   * did read it as something being broken.
   */
  it("closes a gap the daemon reports, without asking the person to do anything", async () => {
    const { client, queue } = await connected();

    const seen: number[] = [];
    const resyncs: number[][] = [];
    const notices: string[] = [];
    client.onNotice((_level, message) => notices.push(message));
    const subscribing = client.subscribe("s1", {
      onEvent: (e) => seen.push(e.seq),
      onResync: (_snapshot, replayed) => resyncs.push(replayed.map((e) => e.seq)),
    });

    const socket = queue.latest();
    socket.reply(socket.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: snapshot(), replayed: [], reset: false },
    });
    await subscribing;
    socket.event("s1", event(1, "one"));
    expect(seen).toEqual([1]);

    // Events 2 and 3 never arrive; the daemon says so instead.
    socket.deliver({ type: "desync", sessionId: "s1", missed: 2 });
    await settle();

    const asked = socket.lastOf("subscribe");
    expect(asked.payload).toMatchObject({ sessionId: "s1", sinceSeq: 1 });

    socket.reply(asked.id, {
      type: "subscribed",
      data: {
        snapshot: snapshot(),
        replayed: [event(2, "two"), event(3, "three")],
        reset: false,
      },
    });
    await settle();

    expect(resyncs).toEqual([[2, 3]]);
    expect(notices).toEqual([]);
  });

  it("runs only one gap repair per session and repairs events that race it", async () => {
    const { client, queue } = await connected();
    const seen: number[] = [];
    const resyncs: number[][] = [];
    const subscribing = client.subscribe("s1", {
      onEvent: (entry) => seen.push(entry.seq),
      onResync: (_snapshot, replayed) =>
        resyncs.push(replayed.map((entry) => entry.seq)),
    });
    const socket = queue.latest();
    socket.reply(socket.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: snapshot(), replayed: [], reset: false },
    });
    await subscribing;
    socket.event("s1", event(1, "one"));

    const before = socket.sent.filter((frame) => frame.type === "subscribe").length;
    socket.deliver({ type: "desync", sessionId: "s1", missed: 1 });
    socket.deliver({ type: "desync", sessionId: "s1", missed: 1 });
    socket.event("s1", event(3, "raced repair"));
    await settle();

    const firstRepair = socket.lastOf("subscribe");
    expect(
      socket.sent.filter((frame) => frame.type === "subscribe").length,
    ).toBe(before + 1);
    expect(firstRepair.payload).toMatchObject({ sessionId: "s1", sinceSeq: 1 });
    expect(seen).toEqual([1]);

    socket.reply(firstRepair.id, {
      type: "subscribed",
      data: {
        snapshot: snapshot(),
        replayed: [event(2, "two")],
        reset: false,
      },
    });
    await settle();
    const secondRepair = socket.lastOf("subscribe");
    expect(secondRepair.id).not.toBe(firstRepair.id);
    expect(secondRepair.payload).toMatchObject({ sessionId: "s1", sinceSeq: 2 });
    socket.reply(secondRepair.id, {
      type: "subscribed",
      data: {
        snapshot: snapshot(),
        replayed: [event(3, "three")],
        reset: false,
      },
    });
    await settle();

    expect(resyncs).toEqual([[2], [3]]);
    expect(seen).toEqual([1]);
    client.close();
  });

  /** A gap on a session nobody is watching is not worth a request. */
  it("ignores a gap reported for a session it is not subscribed to", async () => {
    const { client, queue } = await connected();
    const socket = queue.latest();
    const before = socket.sent.length;

    socket.deliver({ type: "desync", sessionId: "someone-elses", missed: 9 });
    await settle();

    expect(socket.sent.length).toBe(before);
    expect(client.connectionState).toBe("ready");
  });

  it("passes on the daemon's admission that a gap was too old to fill", async () => {
    const { client, queue } = await connected();
    let resetSeen: boolean | null = null;
    const subscribing = client.subscribe("s1", {
      onEvent: () => {},
      onResync: (_snapshot, _replayed, reset) => {
        resetSeen = reset;
      },
    });
    const first = queue.latest();
    first.reply(first.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: snapshot(), replayed: [], reset: false },
    });
    await subscribing;

    first.close();
    await settle();
    const second = queue.latest();
    second.open();
    await settle();
    second.acceptHandshake();
    await settle();
    second.reply(second.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: snapshot(), replayed: [], reset: true },
    });
    await settle();

    expect(resetSeen).toBe(true);
  });

  it("ignores an event it has already applied", async () => {
    const { client, queue } = await connected();
    const seen: number[] = [];
    const subscribing = client.subscribe("s1", {
      onEvent: (e) => seen.push(e.seq),
      onResync: () => {},
    });
    const socket = queue.latest();
    socket.reply(socket.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: snapshot(), replayed: [], reset: false },
    });
    await subscribing;

    socket.event("s1", event(1, "one"));
    socket.event("s1", event(1, "one again"));
    socket.event("s1", event(2, "two"));

    expect(seen).toEqual([1, 2]);
  });

  it("stops trying when the handshake itself is refused", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });
    client.connect();
    queue.latest().open();
    await settle();

    // A version mismatch is not a blip; retrying would loop forever.
    queue
      .latest()
      .fail(queue.latest().lastOf("hello").id, "protocolVersion", "speak v1");
    await settle();

    expect(client.connectionState).toBe("closed");
    expect(queue.sockets).toHaveLength(1);
    expect(client.failure?.code).toBe("protocolVersion");
  });

  it("hands terminal output straight to whoever is listening", async () => {
    const { socket } = await connected();
    const chunks: Array<string | null> = [];
    const client = new Client({
      url: "ws://test",
      socketFactory: () => socket,
    });
    client.onPty((_id, data) => chunks.push(data));
    client.connect();
    socket.open();
    await settle();
    socket.acceptHandshake();
    await settle();

    socket.deliver({ type: "pty", ptyId: "p1", data: "hello" });
    socket.deliver({ type: "ptyClosed", ptyId: "p1", exitCode: 0 });

    expect(chunks).toEqual(["hello", null]);
  });

  it("asks again where to dial, so an address good for one use survives a drop", async () => {
    // A forwarding ticket is spent by the connection that used it. Remembering
    // the first address would mean every reconnect replays a spent one, and a
    // remote session would end at the first wifi hiccup with no way back except
    // starting over from the machine list.
    const queue = socketQueue();
    let minted = 1;
    const client = new Client({
      url: "ws://test/?ticket=1",
      redial: () => Promise.resolve(`ws://test/?ticket=${++minted}`),
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });

    client.connect();
    await settle();
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    queue.latest().close();
    await settle();
    await settle();

    expect(queue.urls).toEqual(["ws://test/?ticket=1", "ws://test/?ticket=2"]);
    expect(client.connectionState).not.toBe("closed");
    client.close();
  });

  it("aborts a hung redial at its total deadline and keeps recovering", async () => {
    vi.useFakeTimers();
    try {
      const queue = socketQueue();
      const signals: AbortSignal[] = [];
      const client = new Client({
        url: "ws://test/first",
        redial: (signal) => {
          signals.push(signal!);
          return new Promise(() => {});
        },
        socketFactory: queue.factory,
        backoffMs: () => 0,
        redialTimeoutMs: 25,
      });
      client.connect();
      queue.latest().close();
      await vi.advanceTimersByTimeAsync(1);
      expect(signals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals.length).toBeGreaterThanOrEqual(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates throwing application listeners from receive and reconnect", async () => {
    const { client, socket, queue } = await connected();
    const observed: string[] = [];
    client.onNotice(() => {
      throw new Error("broken panel");
    });
    client.onNotice((_level, message) => observed.push(message));
    client.onStateChange(() => {
      throw new Error("broken state observer");
    });

    socket.deliver({ type: "notice", level: "info", message: "still delivered" });
    await settle();
    expect(client.connectionState).toBe("ready");
    expect(observed).toEqual(["still delivered"]);

    socket.close();
    for (let turn = 0; turn < 5 && queue.sockets.length < 2; turn += 1) await settle();
    expect(queue.sockets).toHaveLength(2);
    client.close();
  });

  it("coalesces manual connect calls with a pending redial", async () => {
    const queue = socketQueue();
    let releaseRedial!: (url: string) => void;
    let redials = 0;
    const client = new Client({
      url: "ws://test/?ticket=1",
      redial: () => {
        redials += 1;
        return new Promise<string>((resolve) => {
          releaseRedial = resolve;
        });
      },
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });
    client.connect();
    client.connect();
    expect(queue.sockets).toHaveLength(1);

    queue.latest().close();
    await settle();
    client.connect();
    client.connect();
    expect(redials).toBe(1);
    releaseRedial("ws://test/?ticket=2");
    await settle();
    expect(queue.urls).toEqual(["ws://test/?ticket=1", "ws://test/?ticket=2"]);
    client.close();
  });

  it("retries when constructing a WebSocket throws synchronously", async () => {
    const queue = socketQueue();
    let constructions = 0;
    const client = new Client({
      url: "ws://test",
      socketFactory: (url) => {
        constructions += 1;
        if (constructions === 1) throw new Error("browser refused the socket");
        return queue.factory(url);
      },
      backoffMs: () => 0,
    });
    client.connect();
    await settle();
    expect(constructions).toBe(2);
    expect(queue.sockets).toHaveLength(1);
    client.close();
  });

  it("ignores a redial result that arrives after close", async () => {
    const queue = socketQueue();
    let releaseRedial!: (url: string) => void;
    const client = new Client({
      url: "ws://test/?ticket=1",
      redial: () =>
        new Promise<string>((resolve) => {
          releaseRedial = resolve;
        }),
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });
    client.connect();
    queue.latest().close();
    await settle();
    client.close();
    releaseRedial("ws://test/?stale=1");
    await settle();
    expect(queue.urls).toEqual(["ws://test/?ticket=1"]);
  });

  it("replaces a socket that stays silent in CONNECTING", async () => {
    // Safari 26 can strand a WebSocket before the HTTP upgrade reaches the
    // server: no open, error, or close event. Waiting for an event in that
    // state means waiting forever, and the relay ticket is never redeemed.
    vi.useFakeTimers();
    try {
      const queue = socketQueue();
      let minted = 1;
      const client = new Client({
        url: "ws://test/?ticket=1",
        redial: () => Promise.resolve(`ws://test/?ticket=${++minted}`),
        socketFactory: queue.factory,
        connectTimeoutMs: 5_000,
        backoffMs: () => 0,
      });

      client.connect();
      expect(queue.urls).toEqual(["ws://test/?ticket=1"]);

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(queue.sockets[0]?.closed).toBe(true);
      expect(queue.urls).toEqual([
        "ws://test/?ticket=1",
        "ws://test/?ticket=2",
      ]);
      expect(client.connectionState).toBe("reconnecting");
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a socket that opens but never completes Hello", async () => {
    vi.useFakeTimers();
    try {
      const queue = socketQueue();
      let minted = 1;
      const client = new Client({
        url: "ws://test/?ticket=1",
        redial: () => Promise.resolve(`ws://test/?ticket=${++minted}`),
        socketFactory: queue.factory,
        helloTimeoutMs: 5_000,
        backoffMs: () => 0,
      });

      client.connect();
      queue.latest().open();
      await Promise.resolve();
      expect(queue.latest().lastOf("hello")).toBeDefined();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(queue.sockets[0]?.closed).toBe(true);
      expect(queue.urls).toEqual([
        "ws://test/?ticket=1",
        "ws://test/?ticket=2",
      ]);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a sent request without retrying or closing healthy streams", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "ws://test",
      socketFactory: queue.factory,
      requestTimeoutMs: 10,
    });
    client.connect();
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();

    vi.useFakeTimers();
    try {
      const pending = client.call({ type: "agent.list" });
      const rejected = expect(pending).rejects.toBeInstanceOf(
        ClientRequestTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(client.connectionState).toBe("ready");
      expect(queue.sockets).toHaveLength(1);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });

  it("keeps retrying when it cannot even find out where to dial", async () => {
    // The thing that mints the address can be the thing that is down. Treating
    // that as fatal would turn a control-plane blip into a session the user has
    // to rebuild by hand.
    const queue = socketQueue();
    let attempts = 0;
    const client = new Client({
      url: "ws://test/?ticket=1",
      redial: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("hub is down"))
          : Promise.resolve("ws://test/?ticket=2");
      },
      socketFactory: queue.factory,
      backoffMs: () => 0,
    });

    client.connect();
    queue.latest().close();
    await settle();
    // The first retry could not even find out where to go, and that must not be
    // the end of it.
    expect(attempts).toBe(1);

    await settle();
    await settle();
    expect(queue.urls).toEqual(["ws://test/?ticket=1", "ws://test/?ticket=2"]);
    client.close();
  });

  it("does not reconnect after it has been closed on purpose", async () => {
    const { client, queue } = await connected();
    const reconnect = vi.fn();
    client.onStateChange(reconnect);

    client.close();
    queue.latest().close();
    await settle();

    expect(queue.sockets).toHaveLength(1);
    expect(client.connectionState).toBe("closed");
  });
});

function snapshot() {
  return {
    summary: {
      id: "s1",
      workspaceId: "w1",
      agentId: "genet",
      title: "test",
      status: "idle" as const,
      modelId: undefined,
      modeId: undefined,
      createdAtMs: 0,
      updatedAtMs: 0,
      archived: false,
    },
    items: [],
    seq: 0,
    pendingPermissions: [],
  };
}

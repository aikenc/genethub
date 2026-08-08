import type { SequencedEvent } from "@genehub/proto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssetPreviewError_,
  Client,
  ClientQueueFullError,
  ClientRequestTimeoutError,
  ConnectionOutcomeUnknownError,
  type ClientOptions,
  type LocalServerProof,
} from "./client";
import {
  socketQueue,
  TEST_PEER_SECRET,
  type FakePeerOptions,
  type FakeSocket,
} from "./fake-socket";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function localProof(
  proof = TEST_PEER_SECRET,
  expiresAt = Math.ceil(Date.now() / 1000) + 30,
): LocalServerProof {
  return {
    proof,
    challenge: "c".repeat(64),
    pid: 42,
    machineId: "m_local",
    fingerprint: "FP-LOCAL",
    expiresAt,
  };
}

const localIdentity: FakePeerOptions["identity"] = {
  machineId: "m_local",
  fingerprint: "FP-LOCAL",
  machineName: "本机",
  transport: "loopback",
  rtcSupported: false,
};

async function waitFor(test: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (test()) return;
    await settle();
  }
  throw new Error("condition did not settle");
}

async function connected(options: Partial<ClientOptions> = {}): Promise<{
  client: Client;
  socket: FakeSocket;
  queue: ReturnType<typeof socketQueue>;
}> {
  const proof = localProof();
  const queue = socketQueue({ secret: proof.proof, identity: localIdentity });
  const client = new Client({
    ...options,
    url: options.url ?? "ws://127.0.0.1:42123/ws",
    localServerProof: options.localServerProof ?? proof,
    socketFactory: options.socketFactory ?? queue.factory,
    rtcEnabled: options.rtcEnabled ?? false,
    backoffMs: options.backoffMs ?? (() => 0),
  });
  client.connect();
  const socket = queue.latest();
  socket.open();
  await waitFor(() => socket.sent.some((message) => message.type === "hello"));
  socket.acceptHandshake();
  await waitFor(() => client.connectionState === "ready");
  return { client, socket, queue };
}

afterEach(() => vi.unstubAllGlobals());

describe("the v3 peer connection", () => {
  it("requires the out-of-band loopback PSK and verifies encrypted identity", async () => {
    const proof = localProof();
    const queue = socketQueue({ secret: proof.proof, identity: localIdentity });
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws",
      localServerProof: proof,
      socketFactory: queue.factory,
      rtcEnabled: false,
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.length === 1);
    queue.latest().acceptHandshake();
    await waitFor(() => client.connectionState === "ready");

    expect(client.identity).toMatchObject({
      machineId: "m_local",
      fingerprint: "FP-LOCAL",
      protocolVersion: 3,
    });
    client.close();
  });

  it("fail-closes a peer that cannot prove the expected secret", async () => {
    const proof = localProof();
    const queue = socketQueue({ identity: localIdentity });
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws",
      localServerProof: proof,
      socketFactory: queue.factory,
      rtcEnabled: false,
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.length === 1);
    queue.latest().acceptHandshake("f".repeat(64));
    await waitFor(() => client.connectionState === "closed");

    expect(client.failure?.code).toBe("unauthorized");
    expect(queue.latest().closed).toBe(true);
  });

  it("rejects an expired local admission before emitting PeerHello", async () => {
    const queue = socketQueue();
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws",
      localServerProof: localProof(TEST_PEER_SECRET, 1),
      socketFactory: queue.factory,
      rtcEnabled: false,
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => client.connectionState === "closed");
    expect(queue.latest().sent).toEqual([]);
  });

  it("requires a fresh route and E2EE credential on reconnect", async () => {
    const first = localProof("1".repeat(64));
    const second = localProof("2".repeat(64));
    const queue = socketQueue({ secret: first.proof, identity: localIdentity });
    const redial = vi.fn(async () => ({
      url: "ws://127.0.0.1:42124/ws",
      localServerProof: second,
    }));
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws",
      localServerProof: first,
      redial,
      socketFactory: queue.factory,
      rtcEnabled: false,
      backoffMs: () => 0,
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.length === 1);
    queue.latest().acceptHandshake(first.proof);
    await waitFor(() => client.connectionState === "ready");
    queue.latest().close(1012, "restart");
    await waitFor(() => queue.sockets.length === 2);

    expect(redial).toHaveBeenCalledTimes(1);
    expect(queue.urls[1]).toContain("42124");
    client.close();
  });

  it("keeps escalating backoff while fresh encrypted carriers keep flapping", async () => {
    const attempts: number[] = [];
    const { client, queue } = await connected({
      backoffMs: (attempt) => {
        attempts.push(attempt);
        return 0;
      },
    });

    queue.latest().close(1012, "restart");
    await waitFor(() => queue.sockets.length === 2);
    queue.latest().open();
    await waitFor(() => queue.latest().sent.some((message) => message.type === "hello"));
    queue.latest().acceptHandshake();
    await waitFor(() => client.connectionState === "ready");

    queue.latest().close(1012, "restart again");
    await waitFor(() => queue.sockets.length === 3);

    expect(attempts).toEqual([0, 1]);
    client.close();
  });
});

describe("RPC exchanges are independent logical streams", () => {
  it("queues work until authenticated, then resolves concurrent replies out of order", async () => {
    const proof = localProof();
    const queue = socketQueue({ secret: proof.proof, identity: localIdentity });
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws",
      localServerProof: proof,
      socketFactory: queue.factory,
      rtcEnabled: false,
    });
    const first = client.call({ type: "agent.list" });
    const second = client.call({ type: "workspace.list" });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.length === 1);
    queue.latest().acceptHandshake();
    await waitFor(() => queue.latest().sent.some((message) => message.type === "workspace.list"));

    const agent = queue.latest().lastOf("agent.list");
    const workspace = queue.latest().lastOf("workspace.list");
    queue.latest().reply(workspace.id, { type: "workspaces", data: [] });
    queue.latest().reply(agent.id, { type: "agents", data: [] });

    expect(await second).toEqual({ type: "workspaces", data: [] });
    expect(await first).toEqual({ type: "agents", data: [] });
    client.close();
  });

  it("does not replay a request whose outcome became unknown", async () => {
    const { client, socket } = await connected();
    const request = client.call({ type: "agent.list" });
    await waitFor(() => socket.sent.some((message) => message.type === "agent.list"));
    socket.close({ code: 1013, reason: "too slow" });

    await expect(request).rejects.toBeInstanceOf(ConnectionOutcomeUnknownError);
    expect(client.lastCloseReason).toEqual({ code: 1013, reason: "too slow" });
    client.close();
  });

  it("maps one response error without closing unrelated streams", async () => {
    const { client, socket } = await connected();
    const denied = client.call({ type: "agent.list" });
    const healthy = client.call({ type: "workspace.list" });
    await waitFor(() => socket.sent.some((message) => message.type === "workspace.list"));
    socket.fail(socket.lastOf("agent.list").id, "forbidden", "not yours");
    socket.reply(socket.lastOf("workspace.list").id, { type: "workspaces", data: [] });

    await expect(denied).rejects.toMatchObject({
      detail: { code: "forbidden", message: "not yours" },
    });
    await expect(healthy).resolves.toEqual({ type: "workspaces", data: [] });
    expect(client.connectionState).toBe("ready");
    client.close();
  });

  it("bounds offline queues and applies per-exchange deadlines", async () => {
    const offline = new Client({
      url: "ws://127.0.0.1:1/ws",
      localServerProof: localProof(),
      maxQueuedRequests: 1,
      maxQueueAgeMs: 5,
      rtcEnabled: false,
    });
    const waiting = offline.call({ type: "agent.list" });
    await expect(offline.call({ type: "agent.list" })).rejects.toBeInstanceOf(
      ClientQueueFullError,
    );
    await expect(waiting).rejects.toBeInstanceOf(ClientRequestTimeoutError);
    offline.close();

    const { client, socket } = await connected({ requestTimeoutMs: 5 });
    const unanswered = client.call({ type: "agent.list" });
    await waitFor(() => socket.sent.some((message) => message.type === "agent.list"));
    await expect(unanswered).rejects.toBeInstanceOf(ClientRequestTimeoutError);
    expect(client.connectionState).toBe("ready");
    client.close();
  });
});

describe("events, Preview and RTC use the same endpoint abstraction", () => {
  it("delivers encrypted subscription events independently of RPC", async () => {
    const { client, socket } = await connected();
    const seen: SequencedEvent[] = [];
    const subscribing = client.subscribe("s1", {
      onEvent: (event) => seen.push(event),
      onResync: () => {},
    });
    await waitFor(() => socket.sent.some((message) => message.type === "subscribe"));
    socket.reply(socket.lastOf("subscribe").id, {
      type: "subscribed",
      data: { snapshot: null as never, replayed: [], reset: false },
    });
    await subscribing;
    const event: SequencedEvent = {
      seq: 1,
      sessionId: "s1",
      event: {
        type: "item",
        turnId: "t1",
        item: { type: "assistantMessage", id: "a1", text: "hello" },
      },
    };
    socket.event("s1", event);
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([event]);
    client.close();
  });

  it("streams exact Preview bytes and preserves typed failures", async () => {
    const { client, socket } = await connected();
    const bytes = new TextEncoder().encode("# hello");
    const preview = client.preview("workspace-1", "docs/readme.md");
    await waitFor(() => socket.sent.some((message) => message.type === "asset.preview"));
    const exchange = socket.lastOf("asset.preview");
    expect(exchange.payload).toEqual({
      source: {
        kind: "workspaceFile",
        workspaceHandle: "workspace-1",
        path: "docs/readme.md",
      },
    });
    socket.respondExchange(exchange.id, 200, {
      version: "0123456789abcdef0123456789abcdef",
      kind: "markdown",
      mediaType: "text/markdown",
      sourceBytes: bytes.byteLength,
    }, bytes);
    expect(Array.from((await preview).bytes)).toEqual(Array.from(bytes));

    const missing = client.preview("workspace-1", "gone.png");
    await waitFor(() => socket.lastOf("asset.preview").id !== exchange.id);
    socket.respondExchange(socket.lastOf("asset.preview").id, 404, {
      error: "notFound",
      limitBytes: 4 * 1024 * 1024,
    });
    await expect(missing).rejects.toBeInstanceOf(AssetPreviewError_);
    client.close();
  });

  it("shows RTC state and upgrades only remote peers when enabled", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const secret = "r".repeat(64);
    const queue = socketQueue({
      secret,
      identity: {
        machineId: "m_remote",
        fingerprint: "FP-REMOTE",
        transport: "forwarded",
        rtcSupported: true,
      },
    });
    const rtcFactory = vi.fn(async (base) => ({
      endpoint: base,
      peer: {} as RTCPeerConnection,
      close() {},
    }));
    const client = new Client({
      url: "wss://relay.example/fabric/v2",
      channelCredential: { capabilityId: "cap-1", secret },
      socketFactory: queue.factory,
      rtcFactory,
      rtcEnabled: true,
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.length === 1);
    queue.latest().acceptHandshake();
    await waitFor(() => client.rtcState === "connected");

    expect(rtcFactory).toHaveBeenCalledTimes(1);
    client.setRtcEnabled(false);
    expect(client.rtcState).toBe("disabled");
    client.close();
  });
});

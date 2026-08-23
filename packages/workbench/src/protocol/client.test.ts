import type { SequencedEvent } from "@genehub/proto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssetPreviewError_,
  Client,
  ClientQueueFullError,
  ClientRequestTimeoutError,
  ConnectionOutcomeUnknownError,
  type ClientDiagnosticDetail,
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
    const types = queue.latest().sent.map((message) => message.type);
    expect(types.indexOf("protocol.identity")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("connection.identity")).toBeGreaterThan(
      types.indexOf("protocol.identity"),
    );
    client.close();
  });

  it("assumes business protocol v3 when protocol.identity is missing", async () => {
    const proof = localProof();
    const queue = socketQueue({
      secret: proof.proof,
      identity: localIdentity,
      autoProtocolIdentity: false,
    });
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

    expect(queue.latest().lastOf("protocol.identity")).toBeDefined();
    expect(client.identity).toMatchObject({ protocolVersion: 3 });
    client.close();
  });

  it("fail-closes when protocol.identity reports a version with no adapter", async () => {
    const proof = localProof();
    const queue = socketQueue({
      secret: proof.proof,
      identity: { ...localIdentity, protocolVersion: 4 },
    });
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
    await waitFor(() => client.connectionState === "closed");

    expect(client.failure?.message).toContain("请刷新网页");
  });

  it("skips protocol.identity on the invite/claim path", async () => {
    const secret = "i".repeat(64);
    const queue = socketQueue({ secret });
    const client = new Client({
      url: "ws://127.0.0.1:42123/ws",
      inviteCredential: { inviteId: `inv_${"a".repeat(32)}`, secret },
      socketFactory: queue.factory,
      rtcEnabled: false,
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.some((message) => message.type === "hello"));
    queue.latest().acceptHandshake();
    await waitFor(() => client.connectionState === "ready");

    expect(queue.latest().sent.map((message) => message.type)).not.toContain("protocol.identity");
    expect(queue.latest().sent.map((message) => message.type)).not.toContain(
      "connection.identity",
    );
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

  it("notices a silently dead carrier through the heartbeat and reconnects", async () => {
    const { client, queue } = await connected({
      heartbeatMs: 20,
      heartbeatTimeoutMs: 40,
      backoffMs: () => 0,
    });

    // The page was suspended and the carrier died without a close frame: the
    // socket still looks open, it just never answers again.
    queue.latest().silence();
    await waitFor(() => client.connectionState === "reconnecting", 500);
    await waitFor(() => queue.sockets.length === 2, 500);

    queue.latest().open();
    await waitFor(() => queue.latest().sent.some((message) => message.type === "hello"), 500);
    queue.latest().acceptHandshake();
    await waitFor(() => client.connectionState === "ready", 500);
    client.close();
  });

  it("keeps a healthy carrier ready across heartbeat probes", async () => {
    const { client, socket } = await connected({ heartbeatMs: 15 });
    await waitFor(
      () =>
        socket.sent.filter((message) => message.type === "connection.identity").length >= 3,
      500,
    );
    expect(client.connectionState).toBe("ready");
    client.close();
  });

  it("reconnects immediately when the page returns while reconnecting", async () => {
    const { client, queue } = await connected({ backoffMs: () => 3_600_000 });
    queue.latest().close(1006, "lost");
    await waitFor(() => client.connectionState === "reconnecting");
    expect(queue.sockets.length).toBe(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => queue.sockets.length === 2);
    queue.latest().open();
    await waitFor(() => queue.latest().sent.some((message) => message.type === "hello"));
    queue.latest().acceptHandshake();
    await waitFor(() => client.connectionState === "ready");
    client.close();
  });

  it("settles a fake peer reply that races with closing the carrier", async () => {
    const { client, socket } = await connected();
    const pending = client.call({ type: "agent.list" });
    await waitFor(() => socket.sent.some((message) => message.type === "agent.list"));

    socket.reply(socket.lastOf("agent.list").id, { type: "agents", data: [] });
    client.close();

    await pending.catch(() => undefined);
    await settle();
    expect(socket.closed).toBe(true);
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

  it("emits correlated operation evidence without request bodies", async () => {
    const diagnostics: Array<{ kind: string; detail: Record<string, unknown> }> = [];
    const { client, socket } = await connected({
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const call = client.call({
      type: "file.tree",
      payload: { workspaceId: "workspace-1", path: "r_root/docs", depth: 2 },
    });
    await waitFor(() => socket.sent.some((message) => message.type === "file.tree"));
    socket.reply(socket.lastOf("file.tree").id, {
      type: "fileTree",
      data: { name: "docs", path: "r_root/docs", isDir: true, children: [] },
    });
    await call;

    const operation = diagnostics.filter(
      (event) => event.kind === "operation" && event.detail.operation === "file.tree",
    );
    expect(operation.map((event) => event.detail.phase)).toEqual(["start", "finish"]);
    expect(operation[0]?.detail.requestId).toBe(operation[1]?.detail.requestId);
    expect(operation[1]?.detail.outcome).toBe("ok");
    expect(operation[0]?.detail).toMatchObject({
      workspaceId: "workspace-1",
      path: "r_root/docs",
      transport: "websocket",
    });
    expect(JSON.stringify(operation)).not.toContain("children");
    client.close();
  });

  it("retrieves the daemon's typed bounded diagnostic snapshot", async () => {
    const { client, socket } = await connected();
    const pending = client.diagnostics();
    await waitFor(() => socket.sent.some((message) => message.type === "diagnostics.snapshot"));
    socket.reply(socket.lastOf("diagnostics.snapshot").id, {
      type: "diagnostics",
      data: {
        version: 1,
        daemonVersion: "0.1.0",
        capturedAt: "2026-08-13T00:00:00.000Z",
        os: "linux",
        arch: "x86_64",
        uptimeSeconds: 42,
        hubState: "unpaired",
        remoteState: "disabled",
        droppedEvents: 0,
        events: [],
      },
    });
    await expect(pending).resolves.toMatchObject({ version: 1, uptimeSeconds: 42 });
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
    const preview = client.preview("workspace-1", "r_project/docs/readme.md");
    await waitFor(() => socket.sent.some((message) => message.type === "asset.preview"));
    const exchange = socket.lastOf("asset.preview");
    expect(exchange.payload).toEqual({
      source: {
        kind: "workspaceFile",
        workspaceHandle: "workspace-1",
        path: "r_project/docs/readme.md",
      },
      diagnosticId: expect.stringMatching(/^preview_/),
    });
    socket.respondExchange(exchange.id, 200, {
      version: "0123456789abcdef0123456789abcdef",
      kind: "markdown",
      mediaType: "text/markdown",
      sourceBytes: bytes.byteLength,
    }, bytes);
    expect(Array.from((await preview).bytes)).toEqual(Array.from(bytes));

    const missing = client.preview("workspace-1", "r_project/gone.png");
    await waitFor(() => socket.lastOf("asset.preview").id !== exchange.id);
    socket.respondExchange(socket.lastOf("asset.preview").id, 404, {
      error: "notFound",
      limitBytes: 64 * 1024 * 1024,
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

  it("forwards RTC peer lifecycle details as rtc diagnostics", async () => {
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
    const diagnostics: Array<{ kind: string; detail: Record<string, unknown> }> = [];
    let peerDiagnostic: ((detail: ClientDiagnosticDetail) => void) | undefined;
    const rtcFactory = vi.fn(
      async (
        base,
        _diagnosticId?: string,
        onDiagnostic?: (detail: ClientDiagnosticDetail) => void,
      ) => {
        peerDiagnostic = onDiagnostic;
        return {
          endpoint: base,
          peer: {} as RTCPeerConnection,
          close() {},
        };
      },
    );
    const client = new Client({
      url: "wss://relay.example/fabric/v2",
      channelCredential: { capabilityId: "cap-1", secret },
      socketFactory: queue.factory,
      rtcFactory,
      rtcEnabled: true,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    client.connect();
    queue.latest().open();
    await waitFor(() => queue.latest().sent.length === 1);
    queue.latest().acceptHandshake();
    await waitFor(() => client.rtcState === "connected");

    expect(peerDiagnostic).toBeTypeOf("function");
    peerDiagnostic!({ diagnosticId: "rtc_1", iceConnectionState: "checking" });
    const rtc = diagnostics.find(
      (event) => event.kind === "rtc" && "iceConnectionState" in event.detail,
    );
    expect(rtc?.detail.iceConnectionState).toBe("checking");
    client.close();
  });
});

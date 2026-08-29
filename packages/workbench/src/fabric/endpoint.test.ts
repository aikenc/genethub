import { describe, expect, it, vi } from "vitest";

import {
  FabricConnectionError,
  FabricEndpoint,
  FabricStateError,
  FabricStreamResetError,
  type FabricReconnectOptions,
  type FabricSocketCloseEvent,
  type FabricSocketLike,
  type FabricStream,
} from "./endpoint";
import {
  decodeFabricFrame,
  encodeFabricFrame,
  FabricKind,
  type FabricFrame,
  FABRIC_INITIAL_STREAM_CREDIT,
  FABRIC_MAX_OPERATION_METADATA_BYTES,
  FABRIC_MAX_STREAM_CREDIT,
  FabricReset,
} from "./frame";

const bytes = (text = "") => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const id = (value: number) => value.toString(16).padStart(32, "0");
const CREDIT = BigInt(FABRIC_INITIAL_STREAM_CREDIT);

class FakeFabricSocket implements FabricSocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: FabricSocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data.slice());
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: FabricFrame | Uint8Array | string): void {
    const data = typeof frame === "string" ? frame : frame instanceof Uint8Array ? frame : encodeFabricFrame(frame);
    this.onmessage?.({ data });
  }

  peerClose(code = 1006, reason = "network lost"): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  networkError(): void {
    if (this.readyState === 3) return;
    this.onerror?.(new Error("network failed"));
  }
}

class ManualReconnectTimer {
  readonly delays: number[] = [];
  private readonly pending: Array<{
    handle: object;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  readonly timer: NonNullable<FabricReconnectOptions["timer"]> = {
    set: (callback, delayMs) => {
      const task = { handle: {}, callback, cancelled: false };
      this.delays.push(delayMs);
      this.pending.push(task);
      return task.handle;
    },
    clear: (handle) => {
      const task = this.pending.find((candidate) => candidate.handle === handle);
      if (task) task.cancelled = true;
    },
  };

  get activeCount(): number {
    return this.pending.filter((task) => !task.cancelled).length;
  }

  runNext(): void {
    const task = this.pending.find((candidate) => !candidate.cancelled);
    if (!task) throw new Error("no reconnect timer is pending");
    task.cancelled = true;
    task.callback();
  }
}

function decoded(socket: FakeFabricSocket): FabricFrame[] {
  return socket.sent.map((wire) => {
    const frame = decodeFabricFrame(wire);
    if (!frame) throw new Error("the SDK sent a malformed Fabric frame");
    return frame;
  });
}

function harness(
  streamIds: string[],
  options: {
    redial?: () => Promise<string>;
    onError?: (error: unknown) => void;
    connectTimeoutMs?: number;
    reconnect?: FabricReconnectOptions | false;
    initialStreamCredit?: number;
    maxActiveStreams?: number;
    maxRememberedStreamIds?: number;
    maxQueuedInboundFrames?: number;
    maxQueuedInboundBytes?: number;
    maxBufferedBytes?: number;
    transportFlow?: boolean;
  } = {},
) {
  const sockets: FakeFabricSocket[] = [];
  const urls: string[] = [];
  const endpoint = new FabricEndpoint({
    url: "wss://relay.test/fabric/v2?ticket=first",
    redial: options.redial,
    streamId: () => {
      const next = streamIds.shift();
      if (!next) throw new Error("test ran out of stream ids");
      return next;
    },
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeFabricSocket();
      sockets.push(socket);
      return socket;
    },
    onError: options.onError,
    initialStreamCredit: options.initialStreamCredit,
    transportFlow: options.transportFlow,
    ...(options.maxActiveStreams === undefined
      ? {}
      : { maxActiveStreams: options.maxActiveStreams }),
    ...(options.maxRememberedStreamIds === undefined
      ? {}
      : { maxRememberedStreamIds: options.maxRememberedStreamIds }),
    ...(options.maxQueuedInboundFrames === undefined
      ? {}
      : { maxQueuedInboundFrames: options.maxQueuedInboundFrames }),
    ...(options.maxQueuedInboundBytes === undefined
      ? {}
      : { maxQueuedInboundBytes: options.maxQueuedInboundBytes }),
    ...(options.maxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: options.maxBufferedBytes }),
    ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  });
  return { endpoint, sockets, urls };
}

async function connect(
  endpoint: FabricEndpoint,
  sockets: FakeFabricSocket[],
  index = 0,
): Promise<FakeFabricSocket> {
  const opening = endpoint.connect();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index));
  const socket = sockets[index]!;
  expect(socket.binaryType).toBe("arraybuffer");
  socket.open();
  await opening;
  return socket;
}

async function waitForFrames(socket: FakeFabricSocket, count: number): Promise<FabricFrame[]> {
  await vi.waitFor(() => expect(socket.sent).toHaveLength(count));
  return decoded(socket);
}

describe("a browser Fabric endpoint", () => {
  it("interleaves independent streams over one physical WebSocket", async () => {
    const stack = harness([id(1), id(2)]);
    const socket = await connect(stack.endpoint, stack.sockets);

    const first = stack.endpoint.open("route:first", bytes("hello:first"));
    const second = stack.endpoint.open("route:second", bytes("hello:second"));
    expect(stack.sockets).toHaveLength(1);
    expect(decoded(socket).map((frame) => [frame.kind, frame.streamId])).toEqual([
      [FabricKind.Open, id(1)],
      [FabricKind.Open, id(2)],
    ]);

    // ACCEPT can arrive in either order; it is resolved by this socket's local
    // stream id rather than by whichever operation was opened most recently.
    socket.receive({
      kind: FabricKind.Accept,
      streamId: id(2),
      value: CREDIT,
      payload: bytes("second-ready"),
    });
    socket.receive({
      kind: FabricKind.Accept,
      streamId: id(1),
      value: CREDIT,
      payload: bytes("first-ready"),
    });
    expect(text(await first.accepted)).toBe("first-ready");
    expect(text(await second.accepted)).toBe("second-ready");

    const firstData: string[] = [];
    const secondData: string[] = [];
    first.onData((payload) => firstData.push(text(payload)));
    second.onData((payload) => secondData.push(text(payload)));

    first.send(bytes("first:one"));
    second.send(bytes("second:one"));
    first.send(bytes("first:two"));
    const sent = decoded(socket).slice(2);
    expect(sent.map((frame) => [frame.streamId, frame.value, text(frame.payload)])).toEqual([
      [id(1), 1n, "first:one"],
      [id(2), 1n, "second:one"],
      [id(1), 2n, "first:two"],
    ]);

    socket.receive({ kind: FabricKind.Data, streamId: id(2), value: 1n, payload: bytes("b1") });
    socket.receive({ kind: FabricKind.Data, streamId: id(1), value: 1n, payload: bytes("a1") });
    socket.receive({ kind: FabricKind.Data, streamId: id(1), value: 2n, payload: bytes("a2") });
    await vi.waitFor(() => expect(firstData).toEqual(["a1", "a2"]));
    expect(secondData).toEqual(["b1"]);

    stack.endpoint.close();
  });

  it("accounts byte credit and lets a healthy stream pass a slow consumer", async () => {
    const stack = harness([id(70), id(71)], { initialStreamCredit: 4 });
    const socket = await connect(stack.endpoint, stack.sockets);
    const slow = stack.endpoint.open("route:slow");
    const healthy = stack.endpoint.open("route:healthy");
    expect(decoded(socket).map((frame) => frame.value)).toEqual([4n, 4n]);

    socket.receive({ kind: FabricKind.Accept, streamId: slow.id, value: 4n, payload: bytes() });
    socket.receive({ kind: FabricKind.Accept, streamId: healthy.id, value: 4n, payload: bytes() });
    await Promise.all([slow.accepted, healthy.accepted]);

    slow.send(bytes("full"));
    expect(slow.availableSendCredit).toBe(0n);
    expect(() => slow.send(bytes("x"))).toThrow(FabricStateError);
    socket.receive({
      kind: FabricKind.WindowUpdate,
      streamId: slow.id,
      value: 4n,
      payload: bytes(),
    });
    await vi.waitFor(() => expect(slow.availableSendCredit).toBe(4n));

    let releaseSlow!: () => void;
    const slowConsumption = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const delivered: string[] = [];
    slow.onData(async (payload) => {
      delivered.push(text(payload));
      await slowConsumption;
    });
    healthy.onData((payload) => delivered.push(text(payload)));

    socket.receive({ kind: FabricKind.Data, streamId: slow.id, value: 1n, payload: bytes("slow") });
    socket.receive({ kind: FabricKind.Data, streamId: healthy.id, value: 1n, payload: bytes("ok") });
    await vi.waitFor(() => expect(delivered).toEqual(["slow", "ok"]));
    await vi.waitFor(() =>
      expect(decoded(socket)).toContainEqual(
        expect.objectContaining({
          kind: FabricKind.WindowUpdate,
          streamId: healthy.id,
          value: 2n,
        }),
      ),
    );
    expect(
      decoded(socket).some(
        (frame) => frame.kind === FabricKind.WindowUpdate && frame.streamId === slow.id,
      ),
    ).toBe(false);

    releaseSlow();
    await vi.waitFor(() =>
      expect(decoded(socket)).toContainEqual(
        expect.objectContaining({
          kind: FabricKind.WindowUpdate,
          streamId: slow.id,
          value: 4n,
        }),
      ),
    );
    expect(stack.endpoint.connectionState).toBe("open");
    stack.endpoint.close();
  });

  it("uses local socket drain and emits no WINDOW_UPDATE in transport-flow mode", async () => {
    const stack = harness([id(76)], {
      transportFlow: true,
      maxBufferedBytes: 64,
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    const stream = stack.endpoint.open("route:transport-flow");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: stream.id,
      value: 0n,
      payload: bytes(),
    });
    await stream.accepted;

    socket.bufferedAmount = 64;
    const sending = stream.sendAsync(bytes("bulk"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(decoded(socket).filter((frame) => frame.kind === FabricKind.Data)).toHaveLength(0);
    socket.bufferedAmount = 0;
    await sending;

    const beforeReceive = decoded(socket).length;
    const received: string[] = [];
    stream.onData((payload) => received.push(text(payload)));
    socket.receive({
      kind: FabricKind.Data,
      streamId: stream.id,
      value: 1n,
      payload: bytes("reply"),
    });
    await vi.waitFor(() => expect(received).toEqual(["reply"]));
    expect(
      decoded(socket)
        .slice(beforeReceive)
        .some((frame) => frame.kind === FabricKind.WindowUpdate),
    ).toBe(false);
    stack.endpoint.close();
  });

  it("resets only an over-credit or maliciously updated stream", async () => {
    const stack = harness([id(72), id(73)], { initialStreamCredit: 4 });
    const socket = await connect(stack.endpoint, stack.sockets);
    const flooded = stack.endpoint.open("route:flooded");
    const healthy = stack.endpoint.open("route:healthy");
    socket.receive({ kind: FabricKind.Accept, streamId: flooded.id, value: 4n, payload: bytes() });
    socket.receive({ kind: FabricKind.Accept, streamId: healthy.id, value: 4n, payload: bytes() });
    await Promise.all([flooded.accepted, healthy.accepted]);

    socket.receive({
      kind: FabricKind.Data,
      streamId: flooded.id,
      value: 1n,
      payload: bytes("flood"),
    });
    expect(await flooded.done).toEqual({
      type: "reset",
      code: BigInt(FabricReset.ProtocolViolation),
    });
    expect(stack.endpoint.connectionState).toBe("open");

    healthy.send(bytes("x"));
    socket.receive({
      kind: FabricKind.WindowUpdate,
      streamId: healthy.id,
      value: 2n,
      payload: bytes(),
    });
    expect(await healthy.done).toEqual({
      type: "reset",
      code: BigInt(FabricReset.ProtocolViolation),
    });
    expect(stack.endpoint.connectionState).toBe("open");
    expect(stack.endpoint.activeStreamCount).toBe(0);
    stack.endpoint.close();
  });

  it("fails excessive initial credit closed at stream scope", async () => {
    expect(
      () =>
        harness([], {
          initialStreamCredit: FABRIC_MAX_STREAM_CREDIT + 1,
        }),
    ).toThrow(FabricStateError);

    const stack = harness([id(74), id(75)]);
    const socket = await connect(stack.endpoint, stack.sockets);
    const malicious = stack.endpoint.open("route:malicious");
    const healthy = stack.endpoint.open("route:healthy");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: malicious.id,
      value: BigInt(FABRIC_MAX_STREAM_CREDIT) + 1n,
      payload: bytes(),
    });
    socket.receive({
      kind: FabricKind.Accept,
      streamId: healthy.id,
      value: CREDIT,
      payload: bytes(),
    });
    expect(await malicious.done).toEqual({
      type: "reset",
      code: BigInt(FabricReset.ProtocolViolation),
    });
    await healthy.accepted;
    healthy.send(bytes("still healthy"));
    expect(stack.endpoint.connectionState).toBe("open");
    stack.endpoint.close();
  });

  it("accepts peer-originated operations on that same endpoint", async () => {
    const stack = harness([id(10)]);
    const socket = await connect(stack.endpoint, stack.sockets);
    const incoming: FabricStream[] = [];
    let hello = "";
    stack.endpoint.onIncoming((stream, opaqueHello) => {
      incoming.push(stream);
      hello = text(opaqueHello);
      stream.accept(bytes("service-ready"));
      stream.send(bytes("from-service"));
    });

    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(90),
      value: CREDIT,
      payload: bytes("opaque-service-hello"),
    });

    const frames = await waitForFrames(socket, 2);
    expect(hello).toBe("opaque-service-hello");
    expect(incoming[0]?.direction).toBe("incoming");
    expect(frames.map((frame) => [frame.kind, frame.streamId, frame.value])).toEqual([
      [FabricKind.Accept, id(90), CREDIT],
      [FabricKind.Data, id(90), 1n],
    ]);
    expect(text(frames[0]!.payload)).toBe("service-ready");
    expect(text(frames[1]!.payload)).toBe("from-service");

    // Being a responder did not turn the socket into a responder-only channel.
    const outgoing = stack.endpoint.open("route:outgoing-too");
    expect(outgoing.id).toBe(id(10));
    expect(stack.sockets).toHaveLength(1);
    stack.endpoint.close();
  });

  it("bounds both sides of operation metadata without closing the endpoint", async () => {
    const stack = harness([id(11)]);
    const socket = await connect(stack.endpoint, stack.sockets);
    const incoming: FabricStream[] = [];
    stack.endpoint.onIncoming((stream) => {
      incoming.push(stream);
    });

    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(92),
      value: CREDIT,
      payload: new Uint8Array(FABRIC_MAX_OPERATION_METADATA_BYTES + 1),
    });
    let frames = await waitForFrames(socket, 1);
    expect(frames[0]).toMatchObject({
      kind: FabricKind.Reset,
      streamId: id(92),
      value: BigInt(FabricReset.ProtocolViolation),
    });
    expect(incoming).toHaveLength(0);

    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(93),
      value: CREDIT,
      payload: bytes("within-bound"),
    });
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(() =>
      incoming[0]!.accept(
        new Uint8Array(FABRIC_MAX_OPERATION_METADATA_BYTES + 1),
      ),
    ).toThrow(FabricStateError);
    incoming[0]!.reset(FabricReset.RouteDenied);

    const outgoing = stack.endpoint.open("route:oversized-accept");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: outgoing.id,
      value: CREDIT,
      payload: new Uint8Array(FABRIC_MAX_OPERATION_METADATA_BYTES + 1),
    });
    expect(await outgoing.done).toEqual({
      type: "reset",
      code: BigInt(FabricReset.ProtocolViolation),
    });
    expect(stack.endpoint.connectionState).toBe("open");
    frames = decoded(socket);
    expect(frames.filter((frame) => frame.kind === FabricKind.Reset)).toHaveLength(3);
    stack.endpoint.close();
  });

  it("refuses INCOMING safely when no application service is registered", async () => {
    const stack = harness([]);
    const socket = await connect(stack.endpoint, stack.sockets);

    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(31),
      value: CREDIT,
      payload: bytes("this is never interpreted"),
    });

    const [reset] = await waitForFrames(socket, 1);
    expect(reset).toMatchObject({
      kind: FabricKind.Reset,
      streamId: id(31),
      value: BigInt(FabricReset.RouteDenied),
    });
    expect(stack.endpoint.connectionState).toBe("open");
    expect(stack.endpoint.activeStreamCount).toBe(0);
    stack.endpoint.close();
  });

  it("contains a synchronous incoming-handler failure to that stream", async () => {
    const errors: unknown[] = [];
    const stack = harness([id(32)], {
      onError: (error) => {
        errors.push(error);
        throw new Error("broken observer");
      },
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    const healthy = stack.endpoint.open("route:healthy");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: healthy.id,
      value: CREDIT,
      payload: bytes("ready"),
    });
    await healthy.accepted;

    stack.endpoint.onIncoming(() => {
      throw new Error("service dispatcher failed synchronously");
    });
    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(91),
      value: CREDIT,
      payload: bytes("opaque"),
    });

    const frames = await waitForFrames(socket, 2);
    expect(frames[1]).toMatchObject({
      kind: FabricKind.Reset,
      streamId: id(91),
      value: BigInt(FabricReset.RouteDenied),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      new Error("service dispatcher failed synchronously"),
    );
    expect(stack.endpoint.connectionState).toBe("open");

    healthy.send(bytes("still usable"));
    expect(decoded(socket).at(-1)).toMatchObject({
      kind: FabricKind.Data,
      streamId: healthy.id,
      value: 1n,
    });
    stack.endpoint.close();
  });

  it("contains unknown ids and invalid stream states without damaging another flow", async () => {
    const stack = harness([id(1), id(2)]);
    const socket = await connect(stack.endpoint, stack.sockets);

    socket.receive({
      kind: FabricKind.Data,
      streamId: id(999),
      value: 1n,
      payload: bytes("guess"),
    });
    let frames = await waitForFrames(socket, 1);
    expect(frames[0]).toMatchObject({
      kind: FabricKind.Reset,
      streamId: id(999),
      value: BigInt(FabricReset.UnknownStream),
    });

    const broken = stack.endpoint.open("route:broken");
    socket.receive({
      kind: FabricKind.Data,
      streamId: broken.id,
      value: 1n,
      payload: bytes("DATA before ACCEPT"),
    });
    await expect(broken.accepted).rejects.toBeInstanceOf(FabricStreamResetError);
    await expect(broken.accepted).rejects.toMatchObject({
      code: BigInt(FabricReset.ProtocolViolation),
    });
    expect(await broken.done).toEqual({
      type: "reset",
      code: BigInt(FabricReset.ProtocolViolation),
    });

    const healthy = stack.endpoint.open("route:healthy");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: healthy.id,
      value: CREDIT,
      payload: bytes("ok"),
    });
    expect(text(await healthy.accepted)).toBe("ok");
    expect(stack.endpoint.connectionState).toBe("open");

    frames = decoded(socket);
    expect(frames.some((frame) => frame.streamId === broken.id && frame.kind === FabricKind.Reset)).toBe(true);
    stack.endpoint.close();
  });

  it("rejects out-of-order DATA and preserves FIN half-close semantics", async () => {
    const stack = harness([id(5)]);
    const socket = await connect(stack.endpoint, stack.sockets);
    const stream = stack.endpoint.open("route:half-close");
    socket.receive({ kind: FabricKind.Accept, streamId: stream.id, value: CREDIT, payload: bytes() });
    await stream.accepted;

    stream.finish();
    expect(stream.phase).toBe("halfClosedLocal");
    expect(() => stream.send(bytes("too late"))).toThrow(FabricStateError);

    const received: string[] = [];
    stream.onData((payload) => received.push(text(payload)));
    socket.receive({ kind: FabricKind.Data, streamId: stream.id, value: 1n, payload: bytes("last") });
    socket.receive({ kind: FabricKind.Fin, streamId: stream.id, value: 0n, payload: bytes() });
    expect(await stream.done).toEqual({ type: "finished" });
    expect(received).toEqual(["last"]);

    // A separate stream demonstrates sequence enforcement without turning the
    // endpoint failure into a connection failure.
    const otherStack = harness([id(6)]);
    const otherSocket = await connect(otherStack.endpoint, otherStack.sockets);
    const other = otherStack.endpoint.open("route:sequence");
    otherSocket.receive({ kind: FabricKind.Accept, streamId: other.id, value: CREDIT, payload: bytes() });
    await other.accepted;
    otherSocket.receive({ kind: FabricKind.Data, streamId: other.id, value: 2n, payload: bytes("gap") });
    expect(await other.done).toEqual({
      type: "reset",
      code: BigInt(FabricReset.ProtocolViolation),
    });
    expect(otherStack.endpoint.connectionState).toBe("open");

    stack.endpoint.close();
    otherStack.endpoint.close();
  });

  it("never reuses a locally allocated id, including after a stream closes", async () => {
    const stack = harness([id(7), id(7), id(8)]);
    const socket = await connect(stack.endpoint, stack.sockets);
    const first = stack.endpoint.open("route:first");
    socket.receive({
      kind: FabricKind.Reset,
      streamId: first.id,
      value: BigInt(FabricReset.TargetOffline),
      payload: bytes(),
    });
    await first.done;

    const second = stack.endpoint.open("route:second");
    expect(first.id).toBe(id(7));
    expect(second.id).toBe(id(8));
    stack.endpoint.close();
  });

  it("never reuses an INCOMING id during one connection", async () => {
    const stack = harness([]);
    const socket = await connect(stack.endpoint, stack.sockets);

    // The first one is refused because there is no service. A later reuse on
    // this same connection is still a duplicate, not a fresh operation.
    socket.receive({ kind: FabricKind.Incoming, streamId: id(55), value: CREDIT, payload: bytes() });
    socket.receive({ kind: FabricKind.Incoming, streamId: id(55), value: CREDIT, payload: bytes() });
    const frames = await waitForFrames(socket, 2);
    expect(frames.map((frame) => frame.value)).toEqual([
      BigInt(FabricReset.RouteDenied),
      BigInt(FabricReset.DuplicateStream),
    ]);

    // An invalid INCOMING and an unknown non-opening frame also reserve their
    // ids, so neither can later be relabelled as a fresh operation.
    socket.receive({ kind: FabricKind.Incoming, streamId: id(56), value: 0n, payload: bytes() });
    socket.receive({ kind: FabricKind.Incoming, streamId: id(56), value: CREDIT, payload: bytes() });
    socket.receive({ kind: FabricKind.Data, streamId: id(57), value: 1n, payload: bytes() });
    socket.receive({ kind: FabricKind.Incoming, streamId: id(57), value: CREDIT, payload: bytes() });
    const allFrames = await waitForFrames(socket, 6);
    expect(allFrames.slice(2).map((frame) => frame.value)).toEqual([
      BigInt(FabricReset.ProtocolViolation),
      BigInt(FabricReset.DuplicateStream),
      BigInt(FabricReset.UnknownStream),
      BigInt(FabricReset.DuplicateStream),
    ]);
    stack.endpoint.close();
  });

  it("bounds active streams without disturbing an existing operation", async () => {
    const stack = harness([id(58), id(59)], {
      maxActiveStreams: 1,
      maxRememberedStreamIds: 8,
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    const active = stack.endpoint.open("route:active");
    expect(() => stack.endpoint.open("route:excess")).toThrow(/too many Fabric streams/);

    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(90),
      value: CREDIT,
      payload: bytes(),
    });
    const frames = await waitForFrames(socket, 2);
    expect(frames[1]).toMatchObject({
      kind: FabricKind.Reset,
      streamId: id(90),
      value: BigInt(FabricReset.TooSlow),
    });
    expect(stack.endpoint.activeStreamCount).toBe(1);

    socket.receive({
      kind: FabricKind.Accept,
      streamId: active.id,
      value: CREDIT,
      payload: bytes(),
    });
    await active.accepted;
    active.send(bytes("still healthy"));
    expect(stack.endpoint.connectionState).toBe("open");
    stack.endpoint.close();
  });

  it("contains an asynchronous DATA consumer failure even when error reporting throws", async () => {
    const errors: unknown[] = [];
    const stack = harness([id(33)], {
      onError: (error) => {
        errors.push(error);
        throw new Error("broken observer");
      },
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    const stream = stack.endpoint.open("route:failing-consumer");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: stream.id,
      value: CREDIT,
      payload: bytes(),
    });
    await stream.accepted;
    stream.onData(async () => {
      throw new Error("consumer failed asynchronously");
    });

    socket.receive({
      kind: FabricKind.Data,
      streamId: stream.id,
      value: 1n,
      payload: bytes("x"),
    });

    await expect(stream.done).resolves.toEqual({
      type: "reset",
      code: BigInt(FabricReset.TooSlow),
    });
    expect(errors).toEqual([new Error("consumer failed asynchronously")]);
    expect(stack.endpoint.connectionState).toBe("open");
    stack.endpoint.close();
  });

  it("closes before hostile unknown stream ids can grow tombstones without bound", async () => {
    const stack = harness([], {
      maxActiveStreams: 1,
      maxRememberedStreamIds: 2,
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    for (const streamId of [id(91), id(92), id(93)]) {
      socket.receive({
        kind: FabricKind.Data,
        streamId,
        value: 1n,
        payload: bytes("x"),
      });
    }

    await vi.waitFor(() =>
      expect(socket.closes.at(-1)).toEqual({
        code: 1002,
        reason: "Fabric stream id budget was exhausted",
      }),
    );
    expect(decoded(socket)).toHaveLength(2);
    expect(stack.endpoint.connectionState).toBe("closed");
  });

  it("bounds frames queued behind asynchronous Blob decoding", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        await held;
        return super.arrayBuffer();
      }
    }

    const stack = harness([], {
      maxQueuedInboundFrames: 1,
      maxQueuedInboundBytes: 1024,
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    const ping = encodeFabricFrame({
      kind: FabricKind.Ping,
      streamId: "0".repeat(32),
      value: 1n,
      payload: bytes(),
    });
    const pingBuffer = ping.buffer.slice(
      ping.byteOffset,
      ping.byteOffset + ping.byteLength,
    ) as ArrayBuffer;
    socket.onmessage?.({ data: new SlowBlob([pingBuffer]) });
    socket.onmessage?.({ data: new SlowBlob([pingBuffer]) });

    expect(socket.closes.at(-1)).toEqual({
      code: 1013,
      reason: "Fabric inbound queue is full",
    });
    release();
    await held;
  });

  it("does not count synchronous ArrayBuffer bursts against the async Blob queue", async () => {
    const stack = harness([], {
      maxQueuedInboundFrames: 1,
      maxQueuedInboundBytes: 1,
    });
    const socket = await connect(stack.endpoint, stack.sockets);

    for (let value = 1n; value <= 128n; value += 1n) {
      socket.receive({
        kind: FabricKind.Ping,
        streamId: "0".repeat(32),
        value,
        payload: bytes(),
      });
    }

    await vi.waitFor(() =>
      expect(decoded(socket).filter((frame) => frame.kind === FabricKind.Pong)).toHaveLength(128),
    );
    expect(socket.closes).toEqual([]);
    expect(stack.endpoint.connectionState).toBe("open");
    stack.endpoint.close();
  });

  it("fails the connection before a slow WebSocket can buffer without bound", async () => {
    const stack = harness([id(94)], { maxBufferedBytes: 128 });
    const socket = await connect(stack.endpoint, stack.sockets);
    socket.bufferedAmount = 128;

    expect(() => stack.endpoint.open("route:blocked")).toThrow(/too slow/);
    expect(socket.closes.at(-1)).toEqual({ code: undefined, reason: undefined });
    expect(stack.endpoint.connectionState).toBe("closed");
  });

  it("reports a connect timeout itself even when socket.close fires synchronously", async () => {
    const stack = harness([], { connectTimeoutMs: 1 });
    const opening = stack.endpoint.connect();
    await expect(opening).rejects.toMatchObject({
      code: null,
      reason: "connect timeout",
    });
    expect(stack.sockets[0]?.closes).toContainEqual({
      code: 4008,
      reason: "connect timeout",
    });
    expect(stack.endpoint.connectionState).toBe("closed");
  });

  it("does not create a socket if closed while awaiting a fresh redial URL", async () => {
    const timers = new ManualReconnectTimer();
    let resolveRedial!: (url: string) => void;
    const redial = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRedial = resolve;
        }),
    );
    const stack = harness([], {
      redial,
      reconnect: {
        initialDelayMs: 10,
        maxDelayMs: 10,
        jitterRatio: 0,
        timer: timers.timer,
      },
    });
    const firstSocket = await connect(stack.endpoint, stack.sockets);
    firstSocket.peerClose();

    const reconnecting = stack.endpoint.connect();
    expect(timers.activeCount).toBe(1);
    timers.runNext();
    await vi.waitFor(() => expect(redial).toHaveBeenCalledTimes(1));
    stack.endpoint.close();
    resolveRedial("wss://relay.test/fabric/v2?ticket=fresh");

    await expect(reconnecting).rejects.toBeInstanceOf(FabricStateError);
    expect(stack.sockets).toHaveLength(1);
    expect(stack.endpoint.connectionState).toBe("closed");
  });

  it("coalesces transient recovery with exponential jitter and never replays old operations", async () => {
    const timers = new ManualReconnectTimer();
    const random = [0, 1];
    let admission = 0;
    const redial = vi.fn(async () => {
      admission += 1;
      return `wss://relay.test/fabric/v2?ticket=fresh-${admission}`;
    });
    const errors: unknown[] = [];
    const stack = harness([id(11), id(12), id(13)], {
      redial,
      onError: (error) => errors.push(error),
      reconnect: {
        initialDelayMs: 100,
        maxDelayMs: 800,
        jitterRatio: 0.25,
        random: () => random.shift() ?? 0.5,
        timer: timers.timer,
      },
    });
    const firstSocket = await connect(stack.endpoint, stack.sockets);
    const accepted = stack.endpoint.open("route:accepted");
    const opening = stack.endpoint.open("route:still-opening");
    firstSocket.receive({
      kind: FabricKind.Accept,
      streamId: accepted.id,
      value: CREDIT,
      payload: bytes(),
    });
    await accepted.accepted;
    accepted.send(bytes("already sent once"));
    let acceptedCompletions = 0;
    void accepted.done.then(() => {
      acceptedCompletions += 1;
    });

    firstSocket.peerClose(1006, "wifi changed");
    const acceptedResult = await accepted.done;
    const openingResult = await opening.done;
    expect(acceptedResult.type).toBe("connectionClosed");
    expect(openingResult.type).toBe("connectionClosed");
    await expect(opening.accepted).rejects.toBeInstanceOf(FabricConnectionError);
    expect(stack.endpoint.activeStreamCount).toBe(0);
    expect(stack.sockets).toHaveLength(1);
    expect(acceptedCompletions).toBe(1);
    expect(timers.delays).toEqual([75]);
    expect(timers.activeCount).toBe(1);

    const recovery = stack.endpoint.connect();
    expect(stack.endpoint.connect()).toBe(recovery);
    timers.runNext();
    await vi.waitFor(() => expect(stack.sockets).toHaveLength(2));
    const failedRecoverySocket = stack.sockets[1]!;
    failedRecoverySocket.networkError();
    await vi.waitFor(() => expect(timers.delays).toEqual([75, 250]));
    expect(timers.activeCount).toBe(1);

    timers.runNext();
    await vi.waitFor(() => expect(stack.sockets).toHaveLength(3));
    const recoveredSocket = stack.sockets[2]!;
    recoveredSocket.open();
    await recovery;

    expect(redial).toHaveBeenCalledTimes(2);
    expect(stack.urls).toEqual([
      "wss://relay.test/fabric/v2?ticket=first",
      "wss://relay.test/fabric/v2?ticket=fresh-1",
      "wss://relay.test/fabric/v2?ticket=fresh-2",
    ]);
    expect(failedRecoverySocket.sent).toHaveLength(0);
    expect(recoveredSocket.sent).toHaveLength(0);
    expect(errors).toHaveLength(1);

    // Repeated stale events cannot complete an old operation twice or leak an
    // OPEN/DATA frame into the recovered epoch.
    firstSocket.onclose?.({ code: 1006, reason: "late duplicate close" });
    firstSocket.receive({ kind: FabricKind.Data, streamId: accepted.id, value: 1n, payload: bytes("late") });
    await Promise.resolve();
    expect(acceptedCompletions).toBe(1);
    expect(recoveredSocket.sent).toHaveLength(0);
    expect(() => accepted.send(bytes("stale"))).toThrow(FabricStateError);

    const fresh = stack.endpoint.open("route:fresh");
    expect(fresh.id).toBe(id(13));
    expect(decoded(recoveredSocket)).toHaveLength(1);
    stack.endpoint.close();
  });

  it.each([1001, 1011, 1012, 1013])(
    "recovers transient Relay close %i with one fresh admission",
    async (closeCode) => {
    const timers = new ManualReconnectTimer();
    const redial = vi.fn(async () => "wss://relay.test/fabric/v2?ticket=after-restart");
    const stack = harness([], {
      redial,
      reconnect: {
        initialDelayMs: 20,
        maxDelayMs: 20,
        jitterRatio: 0,
        timer: timers.timer,
      },
    });
    const firstSocket = await connect(stack.endpoint, stack.sockets);
    firstSocket.peerClose(closeCode, "service restart");

    const recovery = stack.endpoint.connect();
    expect(timers.delays).toEqual([20]);
    timers.runNext();
    await vi.waitFor(() => expect(stack.sockets).toHaveLength(2));
    stack.sockets[1]!.open();
    await recovery;

    expect(redial).toHaveBeenCalledTimes(1);
    expect(stack.urls.at(-1)).toBe("wss://relay.test/fabric/v2?ticket=after-restart");
    stack.endpoint.close();
    },
  );

  it.each([4403, 4408] as const)(
    "treats authority close %i as terminal and never redials",
    async (code) => {
      const timers = new ManualReconnectTimer();
      const redial = vi.fn(async () => "wss://relay.test/fabric/v2?ticket=forbidden");
      const stack = harness([id(21)], {
        redial,
        reconnect: { timer: timers.timer },
      });
      const firstSocket = await connect(stack.endpoint, stack.sockets);
      const stream = stack.endpoint.open("route:terminal");

      firstSocket.peerClose(code, code === 4403 ? "revoked" : "expired");
      const outcome = await stream.done;
      expect(outcome.type).toBe("connectionClosed");
      if (outcome.type !== "connectionClosed") throw new Error("expected connection closure");
      expect(outcome.error.revoked).toBe(code === 4403);
      expect(outcome.error.expired).toBe(code === 4408);
      expect(timers.activeCount).toBe(0);
      expect(redial).not.toHaveBeenCalled();
      await expect(stack.endpoint.connect()).rejects.toMatchObject({ code });
      expect(stack.sockets).toHaveLength(1);
      stack.endpoint.close();
    },
  );

  it("cancels a pending recovery when the caller closes the endpoint", async () => {
    const timers = new ManualReconnectTimer();
    const redial = vi.fn(async () => "wss://relay.test/fabric/v2?ticket=too-late");
    const stack = harness([], {
      redial,
      reconnect: {
        initialDelayMs: 50,
        maxDelayMs: 50,
        jitterRatio: 0,
        timer: timers.timer,
      },
    });
    const socket = await connect(stack.endpoint, stack.sockets);
    socket.peerClose(1006, "offline");
    const recovery = stack.endpoint.connect();
    expect(timers.activeCount).toBe(1);

    stack.endpoint.close();
    await expect(recovery).rejects.toBeInstanceOf(FabricStateError);
    expect(timers.activeCount).toBe(0);
    expect(redial).not.toHaveBeenCalled();
    await expect(stack.endpoint.connect()).rejects.toBeInstanceOf(FabricStateError);
  });

  it("does not retry a possibly spent endpoint URL when no redial source exists", async () => {
    const stack = harness([]);
    const first = stack.endpoint.connect();
    const refused = expect(first).rejects.toBeInstanceOf(FabricConnectionError);
    await vi.waitFor(() => expect(stack.sockets).toHaveLength(1));
    stack.sockets[0]!.peerClose(1006, "upgrade failed");
    await refused;

    await expect(stack.endpoint.connect()).rejects.toThrow(/fresh Fabric endpoint URL/);
    expect(stack.urls).toEqual(["wss://relay.test/fabric/v2?ticket=first"]);
  });

  it("closes the whole endpoint on malformed non-binary input", async () => {
    const stack = harness([id(70)]);
    const socket = await connect(stack.endpoint, stack.sockets);
    const stream = stack.endpoint.open("route:open");

    socket.receive("not binary");
    const outcome = await stream.done;
    expect(outcome.type).toBe("connectionClosed");
    expect(socket.closes.at(-1)).toEqual({
      code: 1003,
      reason: "Fabric message is not binary",
    });
    expect(stack.endpoint.connectionState).toBe("closed");
  });

  it.each([FabricKind.Ping, FabricKind.Pong])(
    "rejects payload-bearing control frame kind %i",
    async (kind) => {
      const stack = harness([]);
      const socket = await connect(stack.endpoint, stack.sockets);

      socket.receive({
        kind,
        streamId: id(0),
        value: 1n,
        payload: bytes("must-not-bypass-flow-control"),
      });

      await vi.waitFor(() =>
        expect(socket.closes.at(-1)).toEqual({
          code: 1002,
          reason: `Fabric ${kind === FabricKind.Ping ? "PING" : "PONG"} payload must be empty`,
        }),
      );
      expect(stack.endpoint.connectionState).toBe("closed");
    },
  );
});

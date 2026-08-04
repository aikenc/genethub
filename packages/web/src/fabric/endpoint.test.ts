import { describe, expect, it, vi } from "vitest";

import {
  FabricConnectionError,
  FabricEndpoint,
  FabricStateError,
  FabricStreamResetError,
  type FabricSocketCloseEvent,
  type FabricSocketLike,
  type FabricStream,
} from "./endpoint";
import {
  decodeFabricFrame,
  encodeFabricFrame,
  FabricKind,
  type FabricFrame,
  FabricReset,
} from "./frame";

const bytes = (text = "") => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const id = (value: number) => value.toString(16).padStart(32, "0");

class FakeFabricSocket implements FabricSocketLike {
  binaryType = "blob";
  readyState = 0;
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
      value: 0n,
      payload: bytes("second-ready"),
    });
    socket.receive({
      kind: FabricKind.Accept,
      streamId: id(1),
      value: 0n,
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
      value: 0n,
      payload: bytes("opaque-service-hello"),
    });

    const frames = await waitForFrames(socket, 2);
    expect(hello).toBe("opaque-service-hello");
    expect(incoming[0]?.direction).toBe("incoming");
    expect(frames.map((frame) => [frame.kind, frame.streamId, frame.value])).toEqual([
      [FabricKind.Accept, id(90), 0n],
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

  it("refuses INCOMING safely when no application service is registered", async () => {
    const stack = harness([]);
    const socket = await connect(stack.endpoint, stack.sockets);

    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(31),
      value: 0n,
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
    const stack = harness([id(32)], { onError: (error) => errors.push(error) });
    const socket = await connect(stack.endpoint, stack.sockets);
    const healthy = stack.endpoint.open("route:healthy");
    socket.receive({
      kind: FabricKind.Accept,
      streamId: healthy.id,
      value: 0n,
      payload: bytes("ready"),
    });
    await healthy.accepted;

    stack.endpoint.onIncoming(() => {
      throw new Error("service dispatcher failed synchronously");
    });
    socket.receive({
      kind: FabricKind.Incoming,
      streamId: id(91),
      value: 0n,
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
      value: 0n,
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
    socket.receive({ kind: FabricKind.Accept, streamId: stream.id, value: 0n, payload: bytes() });
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
    otherSocket.receive({ kind: FabricKind.Accept, streamId: other.id, value: 0n, payload: bytes() });
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
    socket.receive({ kind: FabricKind.Incoming, streamId: id(55), value: 0n, payload: bytes() });
    socket.receive({ kind: FabricKind.Incoming, streamId: id(55), value: 0n, payload: bytes() });
    const frames = await waitForFrames(socket, 2);
    expect(frames.map((frame) => frame.value)).toEqual([
      BigInt(FabricReset.RouteDenied),
      BigInt(FabricReset.DuplicateStream),
    ]);

    // An invalid INCOMING and an unknown non-opening frame also reserve their
    // ids, so neither can later be relabelled as a fresh operation.
    socket.receive({ kind: FabricKind.Incoming, streamId: id(56), value: 1n, payload: bytes() });
    socket.receive({ kind: FabricKind.Incoming, streamId: id(56), value: 0n, payload: bytes() });
    socket.receive({ kind: FabricKind.Data, streamId: id(57), value: 1n, payload: bytes() });
    socket.receive({ kind: FabricKind.Incoming, streamId: id(57), value: 0n, payload: bytes() });
    const allFrames = await waitForFrames(socket, 6);
    expect(allFrames.slice(2).map((frame) => frame.value)).toEqual([
      BigInt(FabricReset.ProtocolViolation),
      BigInt(FabricReset.DuplicateStream),
      BigInt(FabricReset.UnknownStream),
      BigInt(FabricReset.DuplicateStream),
    ]);
    stack.endpoint.close();
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
    let resolveRedial!: (url: string) => void;
    const redial = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRedial = resolve;
        }),
    );
    const stack = harness([], { redial });
    const firstSocket = await connect(stack.endpoint, stack.sockets);
    firstSocket.peerClose();

    const reconnecting = stack.endpoint.connect();
    await vi.waitFor(() => expect(redial).toHaveBeenCalledTimes(1));
    stack.endpoint.close();
    resolveRedial("wss://relay.test/fabric/v2?ticket=fresh");

    await expect(reconnecting).rejects.toBeInstanceOf(FabricStateError);
    expect(stack.sockets).toHaveLength(1);
    expect(stack.endpoint.connectionState).toBe("closed");
  });

  it("fails every stream on disconnect and reconnects without replaying any operation", async () => {
    const redial = vi.fn(async () => "wss://relay.test/fabric/v2?ticket=fresh");
    const stack = harness([id(11), id(12), id(13)], { redial });
    const firstSocket = await connect(stack.endpoint, stack.sockets);
    const accepted = stack.endpoint.open("route:accepted");
    const opening = stack.endpoint.open("route:still-opening");
    firstSocket.receive({
      kind: FabricKind.Accept,
      streamId: accepted.id,
      value: 0n,
      payload: bytes(),
    });
    await accepted.accepted;

    firstSocket.peerClose(1006, "wifi changed");
    const acceptedResult = await accepted.done;
    const openingResult = await opening.done;
    expect(acceptedResult.type).toBe("connectionClosed");
    expect(openingResult.type).toBe("connectionClosed");
    await expect(opening.accepted).rejects.toBeInstanceOf(FabricConnectionError);
    expect(stack.endpoint.activeStreamCount).toBe(0);
    expect(stack.sockets).toHaveLength(1);

    const secondSocket = await connect(stack.endpoint, stack.sockets, 1);
    expect(redial).toHaveBeenCalledTimes(1);
    expect(stack.urls).toEqual([
      "wss://relay.test/fabric/v2?ticket=first",
      "wss://relay.test/fabric/v2?ticket=fresh",
    ]);
    // Nothing from the old epoch is implicitly replayed. The caller has to get
    // a new route and decide whether an idempotent operation should resume.
    expect(secondSocket.sent).toHaveLength(0);

    firstSocket.receive({
      kind: FabricKind.Data,
      streamId: accepted.id,
      value: 1n,
      payload: bytes("late old-epoch data"),
    });
    await Promise.resolve();
    expect(secondSocket.sent).toHaveLength(0);
    expect(() => accepted.send(bytes("stale"))).toThrow(FabricStateError);

    const fresh = stack.endpoint.open("route:fresh");
    expect(fresh.id).toBe(id(13));
    expect(decoded(secondSocket)).toHaveLength(1);
    stack.endpoint.close();
  });

  it("marks relay expiry distinctly and requires a new endpoint credential", async () => {
    const redial = vi.fn(async () => "wss://relay.test/fabric/v2?ticket=after-expiry");
    const stack = harness([id(21)], { redial });
    const firstSocket = await connect(stack.endpoint, stack.sockets);
    const stream = stack.endpoint.open("route:expires-with-endpoint");

    firstSocket.peerClose(4408, "expired");
    const outcome = await stream.done;
    expect(outcome.type).toBe("connectionClosed");
    if (outcome.type !== "connectionClosed") throw new Error("expected connection closure");
    expect(outcome.error.expired).toBe(true);
    expect(outcome.error.revoked).toBe(false);

    await connect(stack.endpoint, stack.sockets, 1);
    expect(redial).toHaveBeenCalledTimes(1);
    stack.endpoint.close();
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
});

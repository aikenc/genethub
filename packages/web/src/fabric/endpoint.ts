import {
  decodeFabricFrame,
  encodeFabricFrame,
  encodeFabricOpenPayload,
  FabricKind,
  type FabricFrame,
  type FabricRandomFill,
  FabricReset,
  newFabricStreamId,
  FABRIC_ZERO_STREAM_ID,
} from "./frame";

export type FabricConnectionState = "idle" | "connecting" | "open" | "closed";
export type FabricStreamDirection = "outgoing" | "incoming";
export type FabricStreamPhase =
  | "opening"
  | "incoming"
  | "active"
  | "halfClosedLocal"
  | "halfClosedRemote"
  | "closed";

export type FabricStreamResult =
  | { type: "finished" }
  | { type: "reset"; code: bigint }
  | { type: "connectionClosed"; error: FabricConnectionError };

export interface FabricSocketCloseEvent {
  code: number;
  reason: string;
  wasClean?: boolean;
}

/** The browser WebSocket surface used by Fabric, kept small for tests/embedders. */
export interface FabricSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: FabricSocketCloseEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface FabricEndpointOptions {
  /** The first short-lived endpoint URL. It is attempted at most once. */
  url: string;
  /** Supplies a fresh endpoint URL after any previous dial was attempted. */
  redial?: () => Promise<string>;
  socketFactory?: (url: string) => FabricSocketLike;
  /** Deterministic id source for tests. Production callers should omit it. */
  streamId?: () => string;
  randomFill?: FabricRandomFill;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  onError?: (error: unknown) => void;
}

export class FabricConnectionError extends Error {
  readonly expired: boolean;
  readonly revoked: boolean;

  constructor(
    message: string,
    readonly code: number | null,
    readonly reason: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "FabricConnectionError";
    this.expired = code === 4408;
    this.revoked = code === 4403;
  }
}

export class FabricStreamResetError extends Error {
  constructor(readonly code: bigint) {
    super(`Fabric stream was reset (${code})`);
    this.name = "FabricStreamResetError";
  }
}

export class FabricStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FabricStateError";
  }
}

type IncomingHandler = (stream: FabricStream, opaqueHello: Uint8Array) => void | Promise<void>;
type DataHandler = (payload: Uint8Array) => void;
type FinishHandler = () => void;

const EMPTY = new Uint8Array();
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const SOCKET_OPEN = 1;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * One operation carried by a FabricEndpoint.
 *
 * It deliberately exposes only opaque bytes. Resource selection, capabilities
 * and end-to-end encryption belong above this transport and cannot be inferred
 * from a route ticket or from an accepted stream.
 */
export class FabricStream {
  private phase_: FabricStreamPhase;
  private localSequence = 0n;
  private remoteSequence = 0n;
  private localFin = false;
  private remoteFin = false;
  private acceptedSettled = false;
  private completed = false;
  private readonly acceptance = deferred<Uint8Array>();
  private readonly completion = deferred<FabricStreamResult>();
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly finishHandlers = new Set<FinishHandler>();

  readonly accepted = this.acceptance.promise;
  readonly done = this.completion.promise;

  constructor(
    private readonly endpoint: FabricEndpoint,
    readonly id: string,
    readonly direction: FabricStreamDirection,
    readonly connectionEpoch: symbol,
  ) {
    this.phase_ = direction === "outgoing" ? "opening" : "incoming";
    // A caller is free to observe only `done`. Marking the internal promise as
    // handled prevents a reset-before-accept from becoming a global unhandled
    // rejection; awaiting `accepted` still receives the same rejection.
    void this.accepted.catch(() => {});
  }

  get phase(): FabricStreamPhase {
    return this.phase_;
  }

  /** Accepts an INCOMING stream. Outgoing streams are accepted by their peer. */
  accept(opaqueReply: Uint8Array = EMPTY): void {
    this.endpoint.accept(this, opaqueReply);
  }

  /** Sends one opaque DATA record with a stream-local monotonic sequence. */
  send(payload: Uint8Array): void {
    this.endpoint.sendData(this, payload);
  }

  /** Half-closes this direction. The peer may continue sending until its FIN. */
  finish(): void {
    this.endpoint.finish(this);
  }

  /** Aborts this operation without affecting other streams on the endpoint. */
  reset(code: FabricReset = FabricReset.EndpointClosed): void {
    this.endpoint.reset(this, BigInt(code));
  }

  onData(handler: DataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onRemoteFinish(handler: FinishHandler): () => void {
    this.finishHandlers.add(handler);
    return () => this.finishHandlers.delete(handler);
  }

  /** @internal */
  activate(payload: Uint8Array): void {
    if (this.phase_ !== "opening" && this.phase_ !== "incoming") return;
    this.phase_ = "active";
    if (!this.acceptedSettled) {
      this.acceptedSettled = true;
      this.acceptance.resolve(payload.slice());
    }
  }

  /** @internal */
  nextLocalSequence(): bigint {
    this.localSequence += 1n;
    return this.localSequence;
  }

  /** @internal */
  receiveData(sequence: bigint, payload: Uint8Array): boolean {
    if (
      (this.phase_ !== "active" && this.phase_ !== "halfClosedLocal") ||
      this.remoteFin ||
      sequence !== this.remoteSequence + 1n
    ) {
      return false;
    }
    this.remoteSequence = sequence;
    for (const handler of this.dataHandlers) {
      try {
        handler(payload.slice());
      } catch (error) {
        this.endpoint.reportListenerError(error);
      }
    }
    return true;
  }

  /** @internal */
  markLocalFin(): boolean {
    if (
      this.localFin ||
      (this.phase_ !== "active" && this.phase_ !== "halfClosedRemote")
    ) {
      return false;
    }
    this.localFin = true;
    if (this.remoteFin) this.complete({ type: "finished" });
    else this.phase_ = "halfClosedLocal";
    return true;
  }

  /** @internal */
  markRemoteFin(): boolean {
    if (
      this.remoteFin ||
      (this.phase_ !== "active" && this.phase_ !== "halfClosedLocal")
    ) {
      return false;
    }
    this.remoteFin = true;
    for (const handler of this.finishHandlers) {
      try {
        handler();
      } catch (error) {
        this.endpoint.reportListenerError(error);
      }
    }
    if (this.localFin) this.complete({ type: "finished" });
    else this.phase_ = "halfClosedRemote";
    return true;
  }

  /** @internal */
  failReset(code: bigint): void {
    if (this.completed) return;
    if (!this.acceptedSettled) {
      this.acceptedSettled = true;
      this.acceptance.reject(new FabricStreamResetError(code));
    }
    this.complete({ type: "reset", code });
  }

  /** @internal */
  failConnection(error: FabricConnectionError): void {
    if (this.completed) return;
    if (!this.acceptedSettled) {
      this.acceptedSettled = true;
      this.acceptance.reject(error);
    }
    this.complete({ type: "connectionClosed", error });
  }

  /** @internal */
  canSend(): boolean {
    return !this.localFin && (this.phase_ === "active" || this.phase_ === "halfClosedRemote");
  }

  /** @internal */
  isCompleted(): boolean {
    return this.completed;
  }

  private complete(result: FabricStreamResult): void {
    if (this.completed) return;
    this.completed = true;
    this.phase_ = "closed";
    this.completion.resolve(result);
  }
}

/**
 * A single physical `/fabric/v2` endpoint WebSocket with many operation flows.
 *
 * Reconnect is explicit. Every attempted endpoint credential is considered
 * spent, all streams fail when that socket goes away, and no OPEN or DATA is
 * replayed onto the next connection. This is essential for commands whose
 * execution outcome is unknown after a disconnect.
 */
export class FabricEndpoint {
  private socket: FabricSocketLike | null = null;
  private epoch: symbol | null = null;
  private streams = new Map<string, FabricStream>();
  private usedInEpoch = new Set<string>();
  private readonly allocatedIds = new Set<string>();
  private readonly stateHandlers = new Set<(state: FabricConnectionState) => void>();
  private incomingHandler: IncomingHandler | null = null;
  private state_: FabricConnectionState = "idle";
  private connecting: Promise<void> | null = null;
  private dialAttempted = false;
  private stopped = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private inbound: { epoch: symbol; tail: Promise<void> } | null = null;

  constructor(private readonly options: FabricEndpointOptions) {}

  get connectionState(): FabricConnectionState {
    return this.state_;
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  onStateChange(handler: (state: FabricConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Registers the sole service dispatcher for peer-originated operations. */
  onIncoming(handler: IncomingHandler): () => void {
    if (this.incomingHandler && this.incomingHandler !== handler) {
      throw new FabricStateError("a Fabric incoming handler is already registered");
    }
    this.incomingHandler = handler;
    return () => {
      if (this.incomingHandler === handler) this.incomingHandler = null;
    };
  }

  /** Opens the first socket, or explicitly reconnects with a freshly minted URL. */
  connect(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(
        new FabricStateError("this Fabric endpoint was closed permanently"),
      );
    }
    if (this.state_ === "open") return Promise.resolve();
    if (this.connecting) return this.connecting;

    const attempt = this.dial();
    this.connecting = attempt;
    const clear = () => {
      if (this.connecting === attempt) this.connecting = null;
    };
    // `finally` would create a second rejected promise nobody owns when a dial
    // fails. Two explicit branches clean up without manufacturing an
    // unhandled rejection beside the one returned to the caller.
    void attempt.then(clear, clear);
    return attempt;
  }

  /** Starts an operation without opening another physical WebSocket. */
  open(routeTicket: string, opaqueHello: Uint8Array = EMPTY): FabricStream {
    this.requireOpen();
    // Validate a one-shot ticket before reserving an id. A typo should not burn
    // either resource locally.
    const payload = encodeFabricOpenPayload(routeTicket, opaqueHello);
    const streamId = this.allocateStreamId();
    const stream = new FabricStream(this, streamId, "outgoing", this.epoch!);
    this.streams.set(streamId, stream);
    try {
      this.sendFrame({
        kind: FabricKind.Open,
        streamId,
        value: 0n,
        payload,
      });
    } catch (error) {
      this.retire(stream);
      stream.failConnection(this.connectionError(error));
      throw error;
    }
    return stream;
  }

  /** Permanently closes this endpoint object. A new object is needed afterwards. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    const socket = this.socket;
    const epoch = this.epoch;
    const error = new FabricConnectionError(
      "Fabric endpoint was closed",
      1000,
      "client closed",
    );
    if (epoch) this.drop(epoch, error);
    else this.setState("closed");
    socket?.close(1000, "client closed");
  }

  /** @internal */
  accept(stream: FabricStream, opaqueReply: Uint8Array): void {
    this.requireCurrent(stream);
    if (stream.direction !== "incoming" || stream.phase !== "incoming") {
      throw new FabricStateError("only a pending INCOMING stream can be accepted");
    }
    this.sendFrame({
      kind: FabricKind.Accept,
      streamId: stream.id,
      value: 0n,
      payload: opaqueReply,
    });
    stream.activate(opaqueReply);
  }

  /** @internal */
  sendData(stream: FabricStream, payload: Uint8Array): void {
    this.requireCurrent(stream);
    if (!stream.canSend()) {
      throw new FabricStateError(`cannot send DATA while stream is ${stream.phase}`);
    }
    this.sendFrame({
      kind: FabricKind.Data,
      streamId: stream.id,
      value: stream.nextLocalSequence(),
      payload,
    });
  }

  /** @internal */
  finish(stream: FabricStream): void {
    this.requireCurrent(stream);
    if (!stream.markLocalFin()) {
      throw new FabricStateError(`cannot send FIN while stream is ${stream.phase}`);
    }
    this.sendFrame({
      kind: FabricKind.Fin,
      streamId: stream.id,
      value: 0n,
      payload: EMPTY,
    });
    if (stream.isCompleted()) this.retire(stream);
  }

  /** @internal */
  reset(stream: FabricStream, code: bigint): void {
    this.requireCurrent(stream);
    if (code <= 0n || code > 0xffff_ffff_ffff_ffffn) {
      throw new FabricStateError("a Fabric reset code must be a non-zero uint64");
    }
    this.sendFrame({
      kind: FabricKind.Reset,
      streamId: stream.id,
      value: code,
      payload: EMPTY,
    });
    this.retire(stream);
    stream.failReset(code);
  }

  /** @internal */
  reportListenerError(error: unknown): void {
    this.options.onError?.(error);
  }

  private async dial(): Promise<void> {
    this.setState("connecting");
    let url: string;
    try {
      if (!this.dialAttempted) url = this.options.url;
      else if (this.options.redial) url = await this.options.redial();
      else {
        throw new FabricStateError(
          "a fresh Fabric endpoint URL is required after the first dial attempt",
        );
      }
      if (!url) throw new FabricStateError("Fabric endpoint URL is empty");
      if (this.stopped) {
        throw new FabricStateError("this Fabric endpoint was closed permanently");
      }
    } catch (cause) {
      this.setState("closed");
      throw cause;
    }
    // Consider it spent before constructing the socket. Whether a failed
    // handshake reached the authority is unknowable from a browser.
    this.dialAttempted = true;

    const factory =
      this.options.socketFactory ??
      ((target: string) => new WebSocket(target) as unknown as FabricSocketLike);
    let socket: FabricSocketLike;
    try {
      socket = factory(url);
    } catch (cause) {
      this.setState("closed");
      throw this.connectionError(cause);
    }

    const epoch = Symbol("fabric-connection");
    this.socket = socket;
    this.epoch = epoch;
    this.streams = new Map();
    this.usedInEpoch = new Set();
    this.inbound = { epoch, tail: Promise.resolve() };
    socket.binaryType = "arraybuffer";

    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const rejectOnce = (error: FabricConnectionError) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      this.clearConnectTimer();
      this.connectTimer = setTimeout(() => {
        const error = new FabricConnectionError(
          "Fabric endpoint did not open before its deadline",
          null,
          "connect timeout",
        );
        rejectOnce(error);
        this.drop(epoch, error);
        socket.close(4008, "connect timeout");
      }, this.options.connectTimeoutMs ?? 5_000);

      socket.onopen = () => {
        if (!this.isCurrent(socket, epoch) || this.stopped) return;
        this.clearConnectTimer();
        opened = true;
        settled = true;
        this.setState("open");
        resolve();
      };
      socket.onmessage = (event) => this.enqueueMessage(socket, epoch, event.data);
      socket.onclose = (event) => {
        const error = new FabricConnectionError(
          closeMessage(event.code, event.reason),
          event.code,
          event.reason,
        );
        this.drop(epoch, error);
        if (!opened) rejectOnce(error);
      };
      socket.onerror = (cause) => {
        if (!this.isCurrent(socket, epoch)) return;
        const error = new FabricConnectionError(
          "Fabric endpoint WebSocket failed",
          null,
          "socket error",
          { cause },
        );
        if (!opened) rejectOnce(error);
        this.drop(epoch, error);
        socket.close();
      };
    });
  }

  private enqueueMessage(socket: FabricSocketLike, epoch: symbol, data: unknown): void {
    const queue = this.inbound;
    if (!queue || queue.epoch !== epoch) return;
    queue.tail = queue.tail
      .then(async () => {
        if (!this.isCurrent(socket, epoch)) return;
        const bytes = await messageBytes(data);
        if (!this.isCurrent(socket, epoch)) return;
        if (bytes.byteLength > (this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)) {
          this.protocolClose(socket, epoch, 1009, "Fabric frame is too large");
          return;
        }
        const frame = decodeFabricFrame(bytes);
        if (!frame) {
          this.protocolClose(socket, epoch, 1002, "malformed Fabric frame");
          return;
        }
        this.receive(frame);
      })
      .catch((cause: unknown) => {
        if (!this.isCurrent(socket, epoch)) return;
        this.protocolClose(socket, epoch, 1003, "Fabric message is not binary", cause);
      });
  }

  private receive(frame: FabricFrame): void {
    switch (frame.kind) {
      case FabricKind.Incoming:
        this.receiveIncoming(frame);
        return;
      case FabricKind.Accept:
        this.receiveAccept(frame);
        return;
      case FabricKind.Data:
        this.receiveData(frame);
        return;
      case FabricKind.WindowUpdate:
        this.receiveWindowUpdate(frame);
        return;
      case FabricKind.Fin:
        this.receiveFin(frame);
        return;
      case FabricKind.Reset:
        this.receiveReset(frame);
        return;
      case FabricKind.Ping:
        this.sendFrame({
          kind: FabricKind.Pong,
          streamId: FABRIC_ZERO_STREAM_ID,
          value: frame.value,
          payload: frame.payload,
        });
        return;
      case FabricKind.Pong:
        return;
      case FabricKind.Open:
        // Route tickets go endpoint -> Relay. Receiving one would blur the
        // authority boundary, so fail the connection instead of guessing.
        this.closeCurrentProtocol("Relay sent an OPEN frame to an endpoint");
        return;
    }
  }

  private receiveIncoming(frame: FabricFrame): void {
    if (frame.value !== 0n) {
      this.sendUnknownReset(frame.streamId, FabricReset.ProtocolViolation);
      return;
    }
    if (this.usedInEpoch.has(frame.streamId)) {
      const existing = this.streams.get(frame.streamId);
      if (existing) {
        this.retire(existing);
        existing.failReset(BigInt(FabricReset.DuplicateStream));
      }
      this.sendUnknownReset(frame.streamId, FabricReset.DuplicateStream);
      return;
    }

    this.usedInEpoch.add(frame.streamId);
    const stream = new FabricStream(this, frame.streamId, "incoming", this.epoch!);
    this.streams.set(frame.streamId, stream);
    const handler = this.incomingHandler;
    if (!handler) {
      this.reset(stream, BigInt(FabricReset.RouteDenied));
      return;
    }
    // Put invocation itself behind a promise boundary: a service that throws
    // synchronously rejects only this operation instead of escaping into the
    // socket's inbound-frame queue and closing the whole endpoint.
    void Promise.resolve()
      .then(() => handler(stream, frame.payload.slice()))
      .catch((error: unknown) => {
        this.reportListenerError(error);
        if (this.streams.get(stream.id) === stream && stream.phase === "incoming") {
          this.reset(stream, BigInt(FabricReset.RouteDenied));
        }
      });
  }

  private receiveAccept(frame: FabricFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return this.sendUnknownReset(frame.streamId);
    if (
      stream.direction !== "outgoing" ||
      stream.phase !== "opening" ||
      frame.value !== 0n
    ) {
      this.failProtocol(stream);
      return;
    }
    stream.activate(frame.payload);
  }

  private receiveData(frame: FabricFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return this.sendUnknownReset(frame.streamId);
    if (!stream.receiveData(frame.value, frame.payload)) this.failProtocol(stream);
  }

  private receiveWindowUpdate(frame: FabricFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return this.sendUnknownReset(frame.streamId);
    if (
      (stream.phase !== "active" &&
        stream.phase !== "halfClosedLocal" &&
        stream.phase !== "halfClosedRemote") ||
      frame.value === 0n ||
      frame.payload.byteLength !== 0
    ) {
      this.failProtocol(stream);
    }
    // Credit accounting belongs in the later bounded scheduling layer. A valid
    // update is accepted but cannot silently enable unbounded buffering here.
  }

  private receiveFin(frame: FabricFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return this.sendUnknownReset(frame.streamId);
    if (frame.value !== 0n || frame.payload.byteLength !== 0 || !stream.markRemoteFin()) {
      this.failProtocol(stream);
      return;
    }
    if (stream.isCompleted()) this.retire(stream);
  }

  private receiveReset(frame: FabricFrame): void {
    const stream = this.streams.get(frame.streamId);
    // RESET is terminal and deliberately unanswered, otherwise two endpoints
    // can bounce UnknownStream at each other forever after a race.
    if (!stream) {
      this.usedInEpoch.add(frame.streamId);
      return;
    }
    if (frame.value === 0n || frame.payload.byteLength !== 0) {
      this.failProtocol(stream);
      return;
    }
    this.retire(stream);
    stream.failReset(frame.value);
  }

  private failProtocol(stream: FabricStream): void {
    if (this.streams.get(stream.id) !== stream) return;
    this.sendFrame({
      kind: FabricKind.Reset,
      streamId: stream.id,
      value: BigInt(FabricReset.ProtocolViolation),
      payload: EMPTY,
    });
    this.retire(stream);
    stream.failReset(BigInt(FabricReset.ProtocolViolation));
  }

  private sendUnknownReset(
    streamId: string,
    code: FabricReset = FabricReset.UnknownStream,
  ): void {
    // Any operation id observed on this connection is tombstoned, including a
    // malformed or out-of-order first frame. It can never later be redefined
    // as a different INCOMING operation on the same socket.
    this.usedInEpoch.add(streamId);
    this.sendFrame({
      kind: FabricKind.Reset,
      streamId,
      value: BigInt(code),
      payload: EMPTY,
    });
  }

  private allocateStreamId(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const streamId = (
        this.options.streamId
          ? this.options.streamId()
          : newFabricStreamId(this.options.randomFill)
      ).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(streamId) || streamId === FABRIC_ZERO_STREAM_ID) {
        throw new FabricStateError("the Fabric stream id source returned an invalid id");
      }
      // Never reuse an id produced by this endpoint object, even after a
      // reconnect. Epoch isolation already makes reuse routable; refusing it
      // also makes stale-frame tests and operation logs unambiguous.
      if (this.allocatedIds.has(streamId) || this.usedInEpoch.has(streamId)) continue;
      this.allocatedIds.add(streamId);
      this.usedInEpoch.add(streamId);
      return streamId;
    }
    throw new FabricStateError("the Fabric stream id source repeatedly returned used ids");
  }

  private sendFrame(frame: FabricFrame): void {
    const socket = this.socket;
    if (!socket || this.state_ !== "open" || socket.readyState !== SOCKET_OPEN) {
      throw new FabricStateError("Fabric endpoint is not open");
    }
    try {
      socket.send(encodeFabricFrame(frame));
    } catch (cause) {
      const epoch = this.epoch;
      const error = this.connectionError(cause);
      if (epoch) this.drop(epoch, error);
      socket.close();
      throw error;
    }
  }

  private requireOpen(): void {
    if (!this.socket || !this.epoch || this.state_ !== "open") {
      throw new FabricStateError("Fabric endpoint is not open");
    }
  }

  private requireCurrent(stream: FabricStream): void {
    this.requireOpen();
    if (
      stream.connectionEpoch !== this.epoch ||
      this.streams.get(stream.id) !== stream ||
      stream.isCompleted()
    ) {
      throw new FabricStateError("Fabric stream does not belong to the current connection");
    }
  }

  private retire(stream: FabricStream): void {
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
  }

  private drop(epoch: symbol, error: FabricConnectionError): void {
    if (this.epoch !== epoch) return;
    this.clearConnectTimer();
    this.socket = null;
    this.epoch = null;
    this.inbound = null;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.failConnection(error);
    this.setState("closed");
  }

  private protocolClose(
    socket: FabricSocketLike,
    epoch: symbol,
    code: number,
    reason: string,
    cause?: unknown,
  ): void {
    const error = new FabricConnectionError(reason, code, reason, { cause });
    this.drop(epoch, error);
    socket.close(code, reason);
  }

  private closeCurrentProtocol(reason: string): void {
    const socket = this.socket;
    const epoch = this.epoch;
    if (socket && epoch) this.protocolClose(socket, epoch, 1002, reason);
  }

  private isCurrent(socket: FabricSocketLike, epoch: symbol): boolean {
    return this.socket === socket && this.epoch === epoch;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private setState(state: FabricConnectionState): void {
    if (this.state_ === state) return;
    this.state_ = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  private connectionError(cause: unknown): FabricConnectionError {
    return cause instanceof FabricConnectionError
      ? cause
      : new FabricConnectionError(
          cause instanceof Error ? cause.message : "Fabric WebSocket send failed",
          null,
          "socket error",
          { cause },
        );
  }
}

async function messageBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data).slice();
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError("Fabric WebSocket messages must be binary");
}

function closeMessage(code: number, reason: string): string {
  if (code === 4408) return "Fabric endpoint credential expired";
  if (code === 4403) return "Fabric endpoint was revoked";
  return reason ? `Fabric endpoint closed (${code}: ${reason})` : `Fabric endpoint closed (${code})`;
}

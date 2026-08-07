import type {
  ExchangeRequestHead,
  ExchangeResponseHead,
} from "@genehub/proto";

import type { ChannelDirection, ChannelSessionKey } from "../devices/proof";
import {
  DATA_PLANE_VERSION,
  DataKind,
  DataReset,
  decodeDataFrame,
  encodeDataFrame,
  INITIAL_STREAM_WINDOW_BYTES,
  MAX_DATA_PAYLOAD_BYTES,
  MAX_FINITE_EXCHANGE_BODY_BYTES,
  type DataFrame,
} from "./frame";
import { openDataRecord, sealDataRecord } from "./secure";

export interface RecordCarrier {
  send(record: Uint8Array): void | Promise<void>;
  onRecord(handler: (record: Uint8Array) => void): () => void;
  onClose(handler: (reason?: unknown) => void): () => void;
  close(reason?: string): void;
}

export type DataEndpointRole = "client" | "server";
export type DataEndpointState = "open" | "closed";

export interface DataEndpointOptions {
  role: DataEndpointRole;
  carrier: RecordCarrier;
  key: ChannelSessionKey;
  maxActiveStreams?: number;
  maxQueuedBytes?: number;
  maxReceiveBytesPerStream?: number;
  onError?: (error: unknown) => void;
}

export class DataPlaneError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "DataPlaneError";
  }
}

export class DataStreamResetError extends DataPlaneError {
  constructor(readonly code: number) {
    super(`logical stream was reset (${code})`);
    this.name = "DataStreamResetError";
  }
}

interface PendingFrame {
  frame: DataFrame;
  bytes: number;
  resolve(): void;
  reject(error: unknown): void;
}

interface DataChunk {
  bytes: Uint8Array;
  credit: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** One independent request/response or long-lived duplex flow. */
export class DataStream {
  private localSequence = 0;
  private remoteSequence = 0;
  private outboundCredit = INITIAL_STREAM_WINDOW_BYTES;
  private localFin = false;
  private remoteFin = false;
  private closed = false;
  private sentBytes = 0;
  private receivedBytes = 0;
  private totalReceivedBytes = 0;
  private readonly chunks: DataChunk[] = [];
  private readonly chunkWaiters: Array<ReturnType<typeof deferred<IteratorResult<Uint8Array>>>> = [];
  private readonly creditWaiters: Array<() => void> = [];
  private readonly responseHead_ = deferred<ExchangeResponseHead>();
  private responseHeadSettled = false;
  private responseHeadValue: ExchangeResponseHead | null = null;
  private readonly completion = deferred<void>();

  readonly responseHead = this.responseHead_.promise;
  readonly done = this.completion.promise;

  constructor(
    private readonly endpoint: DataEndpoint,
    readonly id: number,
    readonly direction: "outgoing" | "incoming",
    readonly requestHead: ExchangeRequestHead,
    initialOutboundCredit = INITIAL_STREAM_WINDOW_BYTES,
  ) {
    this.outboundCredit = initialOutboundCredit;
    // A consumer may only await `done`; resets before a response head must not
    // become a process-wide unhandled rejection.
    void this.responseHead.catch(() => {});
    void this.done.catch(() => {});
  }

  /** Server-side response head. Exactly one is allowed. */
  async respond(head: ExchangeResponseHead): Promise<void> {
    if (this.direction !== "incoming" || this.responseHeadSettled || this.closed) {
      throw new DataPlaneError("this stream cannot send another response head");
    }
    this.responseHeadSettled = true;
    this.responseHeadValue = head;
    await this.endpoint.sendFrame(this, {
      kind: DataKind.Head,
      streamId: this.id,
      value: INITIAL_STREAM_WINDOW_BYTES,
      payload: encodeHead(head),
    });
  }

  /** Writes bytes with stream-local credit and automatic bounded slicing. */
  async write(bytes: Uint8Array): Promise<void> {
    if (
      this.localFin ||
      this.closed ||
      (this.direction === "incoming" && !this.responseHeadSettled)
    ) {
      throw new DataPlaneError("stream write side is closed or has no response head");
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      while (this.outboundCredit === 0) await this.waitForCredit();
      const length = Math.min(
        MAX_DATA_PAYLOAD_BYTES,
        this.outboundCredit,
        bytes.byteLength - offset,
      );
      const payload = bytes.slice(offset, offset + length);
      this.outboundCredit -= length;
      this.localSequence += 1;
      await this.endpoint.sendFrame(this, {
        kind: DataKind.Data,
        streamId: this.id,
        value: this.localSequence,
        payload,
      });
      this.sentBytes += length;
      offset += length;
    }
  }

  async finish(): Promise<void> {
    if (this.localFin || this.closed) return;
    const expected = this.localBodyLength();
    if (
      (this.direction === "incoming" && !this.responseHeadSettled) ||
      (expected !== undefined && expected !== this.sentBytes)
    ) {
      throw new DataPlaneError("stream body length does not match its head");
    }
    this.localFin = true;
    await this.endpoint.sendFrame(this, {
      kind: DataKind.Fin,
      streamId: this.id,
      value: 0,
      payload: EMPTY,
    });
    this.maybeComplete();
  }

  reset(code: number = DataReset.Cancelled): void {
    if (this.closed) return;
    // A terminal reset must survive retiring the stream's queued business
    // frames. Sending it through that same per-stream queue would let retire()
    // remove the reset whenever another frame was already in flight.
    this.endpoint.sendReset(this, code);
    this.fail(new DataStreamResetError(code));
  }

  /** Body chunks; consuming one returns its credit independently of handlers. */
  body(): AsyncIterable<Uint8Array> {
    const stream = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => stream.nextChunk(),
          return: async () => {
            stream.reset(DataReset.Cancelled);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /** @internal */
  receiveHead(head: ExchangeResponseHead, credit: number): boolean {
    if (
      this.direction !== "outgoing" ||
      this.responseHeadSettled ||
      credit < 1 ||
      credit > INITIAL_STREAM_WINDOW_BYTES
    ) {
      return false;
    }
    this.responseHeadSettled = true;
    this.responseHeadValue = head;
    this.outboundCredit = credit;
    this.wakeCredit();
    this.responseHead_.resolve(head);
    return true;
  }

  /** @internal */
  receiveData(sequence: number, bytes: Uint8Array): boolean {
    if (
      this.closed ||
      this.remoteFin ||
      (this.direction === "outgoing" && !this.responseHeadSettled) ||
      sequence !== this.remoteSequence + 1 ||
      bytes.byteLength === 0 ||
      this.receivedBytes + bytes.byteLength > this.endpoint.maxReceiveBytesPerStream ||
      !Number.isSafeInteger(this.totalReceivedBytes + bytes.byteLength)
    ) {
      return false;
    }
    this.remoteSequence = sequence;
    this.receivedBytes += bytes.byteLength;
    this.totalReceivedBytes += bytes.byteLength;
    const waiter = this.chunkWaiters.shift();
    if (waiter) {
      this.returnCredit(bytes.byteLength);
      waiter.resolve({ done: false, value: bytes.slice() });
    } else {
      this.chunks.push({ bytes: bytes.slice(), credit: bytes.byteLength });
    }
    return true;
  }

  /** @internal */
  addCredit(value: number): boolean {
    if (
      this.closed ||
      value < 1 ||
      this.outboundCredit + value > INITIAL_STREAM_WINDOW_BYTES
    ) {
      return false;
    }
    this.outboundCredit += value;
    this.wakeCredit();
    return true;
  }

  /** @internal */
  receiveFin(): boolean {
    const expected = this.remoteBodyLength();
    if (
      this.closed ||
      this.remoteFin ||
      (this.direction === "outgoing" && !this.responseHeadSettled) ||
      (expected !== undefined && expected !== this.totalReceivedBytes)
    ) {
      return false;
    }
    this.remoteFin = true;
    while (this.chunkWaiters.length > 0 && this.chunks.length === 0) {
      this.chunkWaiters.shift()!.resolve({ done: true, value: undefined });
    }
    this.maybeComplete();
    return true;
  }

  /** @internal */
  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.responseHead_.reject(error);
    for (const waiter of this.chunkWaiters.splice(0)) waiter.reject(error);
    this.completion.reject(error);
    this.wakeCredit();
    this.endpoint.retire(this);
  }

  private async nextChunk(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.chunks.shift();
    if (chunk) {
      this.returnCredit(chunk.credit);
      return { done: false, value: chunk.bytes };
    }
    if (this.remoteFin || this.closed) return { done: true, value: undefined };
    const waiter = deferred<IteratorResult<Uint8Array>>();
    this.chunkWaiters.push(waiter);
    return waiter.promise;
  }

  private returnCredit(value: number): void {
    this.receivedBytes -= value;
    void this.endpoint
      .sendFrame(this, {
        kind: DataKind.WindowUpdate,
        streamId: this.id,
        value,
        payload: EMPTY,
      })
      .catch((error: unknown) => this.fail(error));
  }

  private waitForCredit(): Promise<void> {
    if (this.closed) return Promise.reject(new DataPlaneError("stream is closed"));
    return new Promise((resolve) => this.creditWaiters.push(resolve));
  }

  private wakeCredit(): void {
    for (const wake of this.creditWaiters.splice(0)) wake();
  }

  private maybeComplete(): void {
    if (!this.localFin || !this.remoteFin || this.closed) return;
    this.closed = true;
    if (!this.responseHeadSettled && this.direction === "outgoing") {
      this.responseHead_.reject(new DataPlaneError("stream finished without a response head"));
    }
    this.completion.resolve();
    this.endpoint.retire(this);
  }

  private localBodyLength(): number | undefined {
    return this.direction === "outgoing"
      ? this.requestHead.bodyLength
      : this.responseHeadValue?.bodyLength;
  }

  private remoteBodyLength(): number | undefined {
    return this.direction === "outgoing"
      ? this.responseHeadValue?.bodyLength
      : this.requestHead.bodyLength;
  }
}

/**
 * One secure peer link with fair, bounded logical streams.
 *
 * Carrier callbacks only authenticate/decode one frame and place it in a
 * stream queue. Business handlers run from the incoming callback's own task.
 */
export class DataEndpoint {
  private readonly streams = new Map<number, DataStream>();
  private readonly queues = new Map<number, PendingFrame[]>();
  private readonly runnable: number[] = [];
  private readonly incomingHandlers = new Set<(stream: DataStream) => void>();
  private readonly closeHandlers = new Set<(reason?: unknown) => void>();
  private queuedBytes = 0;
  private sending = false;
  private sendSequence = 0;
  private receiveSequence = 0;
  private nextStreamId: number;
  private state_: DataEndpointState = "open";
  private receiveTail: Promise<void> = Promise.resolve();
  private transmitTail: Promise<void> = Promise.resolve();
  private readonly stopRecord: () => void;
  private readonly stopClose: () => void;

  readonly maxReceiveBytesPerStream: number;

  constructor(private readonly options: DataEndpointOptions) {
    this.nextStreamId = options.role === "client" ? 1 : 2;
    this.maxReceiveBytesPerStream =
      options.maxReceiveBytesPerStream ?? INITIAL_STREAM_WINDOW_BYTES;
    if (
      this.maxReceiveBytesPerStream < MAX_DATA_PAYLOAD_BYTES ||
      this.maxReceiveBytesPerStream > 4 * 1024 * 1024
    ) {
      throw new RangeError("invalid per-stream receive budget");
    }
    this.stopRecord = options.carrier.onRecord((record) => this.receive(record));
    this.stopClose = options.carrier.onClose((reason) => this.closeFromCarrier(reason));
  }

  get state(): DataEndpointState {
    return this.state_;
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  open(head: ExchangeRequestHead): DataStream {
    if (this.state_ !== "open") throw new DataPlaneError("data endpoint is closed");
    if (this.streams.size >= (this.options.maxActiveStreams ?? 256)) {
      throw new DataPlaneError("too many logical streams are active");
    }
    const canonicalHead = requestHeadOf(head);
    const payload = encodeHead(canonicalHead);
    const id = this.allocateStreamId();
    const stream = new DataStream(this, id, "outgoing", canonicalHead);
    this.streams.set(id, stream);
    void this.sendFrame(stream, {
      kind: DataKind.Open,
      streamId: id,
      value: INITIAL_STREAM_WINDOW_BYTES,
      payload,
    }).catch((error: unknown) => stream.fail(error));
    return stream;
  }

  onIncoming(handler: (stream: DataStream) => void): () => void {
    this.incomingHandlers.add(handler);
    return () => this.incomingHandlers.delete(handler);
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(reason = "endpoint closed"): void {
    if (this.state_ === "closed") return;
    this.closeInternal(new DataPlaneError(reason));
    this.options.carrier.close(reason);
  }

  /** @internal */
  sendFrame(stream: DataStream, frame: DataFrame): Promise<void> {
    if (this.state_ !== "open" || this.streams.get(stream.id) !== stream) {
      return Promise.reject(new DataPlaneError("logical stream is no longer active"));
    }
    const bytes = 16 + frame.payload.byteLength;
    if (this.queuedBytes + bytes > (this.options.maxQueuedBytes ?? 4 * 1024 * 1024)) {
      return Promise.reject(new DataPlaneError("data endpoint send queue is full"));
    }
    const pending = deferred<void>();
    const queue = this.queues.get(stream.id) ?? [];
    const wasEmpty = queue.length === 0;
    queue.push({ frame, bytes, resolve: () => pending.resolve(), reject: pending.reject });
    this.queues.set(stream.id, queue);
    this.queuedBytes += bytes;
    if (wasEmpty) this.runnable.push(stream.id);
    this.pump();
    return pending.promise;
  }

  /** @internal */
  sendReset(stream: DataStream, code: number): void {
    if (
      this.state_ !== "open" ||
      this.streams.get(stream.id) !== stream ||
      !Number.isSafeInteger(code) ||
      code < 1 ||
      code > 0xffff_ffff
    ) {
      return;
    }
    void this.sendRaw({
      kind: DataKind.Reset,
      streamId: stream.id,
      value: code,
      payload: EMPTY,
    }).catch((error: unknown) => this.report(error));
  }

  /** @internal */
  retire(stream: DataStream): void {
    if (this.streams.get(stream.id) !== stream) return;
    this.streams.delete(stream.id);
    const queued = this.queues.get(stream.id) ?? [];
    this.queues.delete(stream.id);
    this.removeRunnable(stream.id);
    for (const pending of queued) {
      this.queuedBytes -= pending.bytes;
      pending.reject(new DataPlaneError("logical stream ended before its frame was sent"));
    }
  }

  private receive(record: Uint8Array): void {
    if (this.state_ !== "open") return;
    // Ordered carriers and a single promise chain make authentication order
    // explicit without ever awaiting a business handler in this callback.
    const sequence = this.receiveSequence + 1;
    this.receiveSequence = sequence;
    this.receiveTail = this.receiveTail
      .then(async () => {
        const plaintext = await openDataRecord(
          this.options.key,
          this.inboundDirection(),
          sequence,
          record,
        );
        const frame = decodeDataFrame(plaintext);
        if (!frame) throw new DataPlaneError("peer sent a malformed logical frame");
        this.dispatch(frame);
      })
      .catch((error: unknown) => this.protocolFailure(error));
  }

  private dispatch(frame: DataFrame): void {
    if (frame.kind === DataKind.Ping) {
      void this.sendControl(DataKind.Pong, frame.value).catch((error: unknown) =>
        this.report(error),
      );
      return;
    }
    if (frame.kind === DataKind.Pong) return;

    if (frame.kind === DataKind.Open) {
      if (this.streams.has(frame.streamId) || !this.isRemoteStreamId(frame.streamId)) {
        throw new DataPlaneError("peer reused or forged a logical stream id");
      }
      if (this.streams.size >= (this.options.maxActiveStreams ?? 256)) {
        void this.sendRaw({
          kind: DataKind.Reset,
          streamId: frame.streamId,
          value: DataReset.Refused,
          payload: EMPTY,
        }).catch((error: unknown) => this.report(error));
        return;
      }
      const head = requestHeadOf(decodeHead(frame.payload));
      if (frame.value < 1 || frame.value > INITIAL_STREAM_WINDOW_BYTES) {
        throw new DataPlaneError("peer advertised an invalid stream window");
      }
      const stream = new DataStream(
        this,
        frame.streamId,
        "incoming",
        head,
        frame.value,
      );
      this.streams.set(frame.streamId, stream);
      queueMicrotask(() => {
        if (this.streams.get(frame.streamId) !== stream) return;
        for (const handler of this.incomingHandlers) {
          try {
            handler(stream);
          } catch (error) {
            this.report(error);
            stream.reset(DataReset.Refused);
          }
        }
      });
      return;
    }

    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if (frame.kind !== DataKind.Reset) {
        void this.sendRaw({
          kind: DataKind.Reset,
          streamId: frame.streamId,
          value: DataReset.ProtocolViolation,
          payload: EMPTY,
        }).catch((error: unknown) => this.report(error));
      }
      return;
    }
    let valid = false;
    switch (frame.kind) {
      case DataKind.Head:
        valid = stream.receiveHead(
          responseHeadOf(decodeHead(frame.payload)),
          frame.value,
        );
        break;
      case DataKind.Data:
        valid = stream.receiveData(frame.value, frame.payload);
        break;
      case DataKind.WindowUpdate:
        valid = frame.payload.byteLength === 0 && stream.addCredit(frame.value);
        break;
      case DataKind.Fin:
        valid =
          frame.value === 0 && frame.payload.byteLength === 0 && stream.receiveFin();
        break;
      case DataKind.Reset:
        if (frame.value > 0 && frame.payload.byteLength === 0) {
          stream.fail(new DataStreamResetError(frame.value));
          valid = true;
        }
        break;
      default:
        break;
    }
    if (!valid) {
      stream.reset(DataReset.ProtocolViolation);
      throw new DataPlaneError("peer sent an invalid logical stream transition");
    }
  }

  private pump(): void {
    if (this.sending || this.state_ !== "open") return;
    this.sending = true;
    void (async () => {
      try {
        while (this.runnable.length > 0 && this.state_ === "open") {
          const id = this.runnable.shift()!;
          const queue = this.queues.get(id);
          if (!queue || queue.length === 0) continue;
          const pending = queue.shift()!;
          this.queuedBytes -= pending.bytes;
          if (queue.length > 0) this.runnable.push(id);
          else this.queues.delete(id);
          try {
            await this.transmit(pending.frame);
            pending.resolve();
          } catch (error) {
            pending.reject(error);
            throw error;
          }
        }
      } catch (error) {
        this.protocolFailure(error);
      } finally {
        this.sending = false;
        if (this.runnable.length > 0 && this.state_ === "open") this.pump();
      }
    })();
  }

  private sendControl(kind: typeof DataKind.Ping | typeof DataKind.Pong, value: number) {
    return this.sendRaw({ kind, streamId: 0, value, payload: EMPTY });
  }

  private async sendRaw(frame: DataFrame): Promise<void> {
    if (this.state_ !== "open") return;
    await this.transmit(frame);
  }

  /** One crypto/write chain also covers control frames emitted by the reader. */
  private transmit(frame: DataFrame): Promise<void> {
    const sent = this.transmitTail.then(async () => {
      if (this.state_ !== "open") throw new DataPlaneError("data endpoint is closed");
      this.sendSequence += 1;
      const record = await sealDataRecord(
        this.options.key,
        this.outboundDirection(),
        this.sendSequence,
        encodeDataFrame(frame),
      );
      await this.options.carrier.send(record);
    });
    // Keep the chain usable for teardown diagnostics; the returned promise
    // still carries the original failure to the responsible stream/control.
    this.transmitTail = sent.catch(() => {});
    return sent;
  }

  private allocateStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    if (id === 0 || this.nextStreamId > 0xffff_fffd) {
      throw new DataPlaneError("logical stream id space is exhausted");
    }
    return id;
  }

  private isRemoteStreamId(id: number): boolean {
    return id > 0 && id % 2 !== (this.options.role === "client" ? 1 : 0);
  }

  private outboundDirection(): ChannelDirection {
    return this.options.role === "client" ? "client-to-daemon" : "daemon-to-client";
  }

  private inboundDirection(): ChannelDirection {
    return this.options.role === "client" ? "daemon-to-client" : "client-to-daemon";
  }

  private removeRunnable(id: number): void {
    for (let index = this.runnable.length - 1; index >= 0; index -= 1) {
      if (this.runnable[index] === id) this.runnable.splice(index, 1);
    }
  }

  private closeFromCarrier(reason?: unknown): void {
    if (this.state_ === "closed") return;
    this.closeInternal(
      new DataPlaneError("the peer carrier closed", { cause: reason }),
    );
  }

  private protocolFailure(error: unknown): void {
    this.report(error);
    if (this.state_ === "closed") return;
    this.closeInternal(
      error instanceof Error
        ? error
        : new DataPlaneError("data-plane protocol failure", { cause: error }),
    );
    this.options.carrier.close("data-plane protocol failure");
  }

  private closeInternal(error: unknown): void {
    this.state_ = "closed";
    this.stopRecord();
    this.stopClose();
    for (const stream of [...this.streams.values()]) stream.fail(error);
    for (const queue of this.queues.values()) {
      for (const pending of queue) pending.reject(error);
    }
    this.queues.clear();
    this.runnable.length = 0;
    this.queuedBytes = 0;
    for (const handler of this.closeHandlers) {
      try {
        handler(error);
      } catch (listenerError) {
        this.report(listenerError);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Observability never participates in the endpoint state machine.
    }
  }
}

const EMPTY = new Uint8Array();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encodeHead(value: unknown): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(value));
  if (encoded.byteLength > 8 * 1024) throw new DataPlaneError("exchange head is too large");
  return encoded;
}

function decodeHead(payload: Uint8Array): unknown {
  if (payload.byteLength === 0 || payload.byteLength > 8 * 1024) {
    throw new DataPlaneError("exchange head has an invalid length");
  }
  try {
    return JSON.parse(decoder.decode(payload)) as unknown;
  } catch (error) {
    throw new DataPlaneError("exchange head is not valid UTF-8 JSON", { cause: error });
  }
}

function requestHeadOf(value: unknown): ExchangeRequestHead {
  if (!isRecord(value)) throw new DataPlaneError("invalid exchange request head");
  const bodyLength = value.bodyLength;
  const timeoutMs = value.timeoutMs;
  if (
    value.version !== DATA_PLANE_VERSION ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    encoder.encode(value.method).byteLength > 128 ||
    !optionalLength(bodyLength, 3 * 1024 * 1024) ||
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) ||
        (timeoutMs as number) < 1 ||
        (timeoutMs as number) > 3_600_000))
  ) {
    throw new DataPlaneError("invalid exchange request head");
  }
  return value as unknown as ExchangeRequestHead;
}

function responseHeadOf(value: unknown): ExchangeResponseHead {
  if (!isRecord(value)) throw new DataPlaneError("invalid exchange response head");
  if (
    !Number.isInteger(value.status) ||
    (value.status as number) < 100 ||
    (value.status as number) > 599 ||
    !optionalLength(value.bodyLength, MAX_FINITE_EXCHANGE_BODY_BYTES) ||
    (value.error !== undefined && !isRecord(value.error))
  ) {
    throw new DataPlaneError("invalid exchange response head");
  }
  return value as unknown as ExchangeResponseHead;
}

function optionalLength(value: unknown, maximum: number): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= maximum)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type {
  HelloResult,
  PeerHello,
  ProtocolError,
  Reply,
  Request,
  SequencedEvent,
  ServerFrame,
} from "@genehub/proto";

import {
  channelServerProof,
  deriveChannelSessionKey,
  deviceChannelContext,
  hostedChannelContext,
} from "../devices/proof";
import {
  DATA_PLANE_VERSION,
  DataEndpoint,
  collectBody,
  type DataStream,
  type RecordCarrier,
} from "../dataplane";
import { WEB_PROTOCOL_VERSION } from "./codec";
import type { WebSocketLike } from "./client";

interface Sent {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

export const TEST_PEER_SECRET = "a".repeat(64);

export interface FakePeerOptions {
  /** PSK expected by the fake peer. */
  secret?: string;
  identity?: Partial<HelloResult>;
  /** Identity is normally the one daemon RPC the fake answers itself. */
  autoIdentity?: boolean;
  /**
   * `protocol.identity` is answered automatically so current daemons stay
   * the default. Set false to emulate an older peer that returns 404.
   */
  autoProtocolIdentity?: boolean;
}

/**
 * A small in-memory v3 daemon behind a WebSocket-shaped carrier.
 *
 * Tests still decide exactly when the socket opens, authenticates, replies and
 * drops, but the bytes between those decisions are the real bounded E2EE data
 * frames. This keeps higher-level tests from silently preserving an obsolete
 * wire protocol.
 */
export class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  binaryType = "arraybuffer";
  bufferedAmount = 0;
  readonly sent: Sent[] = [];
  closed = false;

  private hello: PeerHello | null = null;
  private endpoint: DataEndpoint | null = null;
  private events: DataStream | null = null;
  private readonly streams = new Map<string, DataStream>();
  private recordHandler: ((record: Uint8Array) => void) | null = null;
  private readonly carrierCloseHandlers = new Set<(reason?: unknown) => void>();
  /** A suspended page's carrier: records arrive, nothing ever answers. */
  private silent = false;

  constructor(private readonly options: FakePeerOptions = {}) {}

  /** Stops answering RPCs without closing, the way a frozen carrier does. */
  silence(): void {
    this.silent = true;
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    const bytes = immediateBytes(data);
    if (!this.hello) {
      const hello = JSON.parse(new TextDecoder().decode(bytes)) as PeerHello;
      this.hello = hello;
      this.sent.push({
        id: "hello",
        type: "hello",
        payload: hello as unknown as Record<string, unknown>,
      });
      return;
    }
    if (!this.recordHandler) {
      // Application bytes before the peer welcome are always a protocol bug.
      this.close(1002, "encrypted record before peer welcome");
      return;
    }
    this.recordHandler(bytes);
  }

  /** Closes, optionally the way a peer that explained itself would. */
  close(code?: number | { code: number; reason: string }, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const event =
      typeof code === "object"
        ? code
        : code === undefined
          ? {}
          : { code, reason: reason ?? "" };
    for (const handler of this.carrierCloseHandlers) handler(event);
    this.onclose?.(event);
  }

  /** The WebSocket transport accepting the connection. */
  open(): void {
    this.onopen?.({});
  }

  /**
   * Completes the real v3 PSK transcript and starts an in-memory server
   * DataEndpoint. A different secret is useful for authentication-failure
   * tests.
   */
  acceptHandshake(
    secret = this.options.secret ?? TEST_PEER_SECRET,
    identity: Partial<HelloResult> = {},
  ): void {
    this.background(this.accept(secret, identity));
  }

  /** Answers an RPC captured by `lastOf`. */
  reply(id: string, payload: Reply | undefined): void {
    const bytes = payload === undefined
      ? new Uint8Array()
      : new TextEncoder().encode(JSON.stringify(payload));
    this.background(this.respond(id, { status: 200, metadata: null }, bytes));
  }

  /** Returns a protocol error on one captured logical stream. */
  fail(id: string, code = "internal", message = "nope"): void {
    this.background(
      this.respond(
        id,
        {
          status: code === "unauthorized" ? 401 : 400,
          metadata: null,
          error: { code: code as ProtocolError["code"], message },
        },
        new Uint8Array(),
      ),
    );
  }

  /** Responds to a non-RPC exchange, including Asset Preview. */
  respondExchange(
    id: string,
    status: number,
    metadata: unknown,
    bytes: Uint8Array = new Uint8Array(),
  ): void {
    this.background(
      this.respond(
        id,
        { status, metadata: metadata as never, bodyLength: bytes.byteLength },
        bytes,
      ),
    );
  }

  /** Pushes a session event over the long-lived encrypted event stream. */
  event(sessionId: string, event: SequencedEvent): void {
    this.deliver({ type: "event", topic: `session:${sessionId}`, payload: event });
  }

  /** Pushes any server event using the event stream's length-delimited codec. */
  deliver(frame: ServerFrame): void {
    const stream = this.events;
    if (!stream) throw new Error("the client has not opened its event stream");
    const body = new TextEncoder().encode(JSON.stringify(frame));
    const packet = new Uint8Array(4 + body.byteLength);
    new DataView(packet.buffer).setUint32(0, body.byteLength, false);
    packet.set(body, 4);
    this.background(stream.write(packet));
  }

  /** The last business request or exchange of a given type. */
  lastOf(type: string): Sent {
    const found = [...this.sent].reverse().find((message) => message.type === type);
    if (!found) {
      throw new Error(
        `no ${type} was sent; saw ${this.sent.map((message) => message.type).join(", ")}`,
      );
    }
    return found;
  }

  private async accept(secret: string, identity: Partial<HelloResult>): Promise<void> {
    const hello = this.hello;
    if (!hello || this.closed) throw new Error("the client has not sent PeerHello");
    const context = contextOf(hello);
    const serverNonce = "b".repeat(32);
    const [proof, key] = await Promise.all([
      channelServerProof(secret, context, nonceOf(hello), serverNonce),
      deriveChannelSessionKey(secret, context, nonceOf(hello), serverNonce),
    ]);
    if (this.closed) return;

    const carrier: RecordCarrier = {
      send: (record) => {
        const copy = record.slice();
        queueMicrotask(() => this.onmessage?.({ data: copy }));
      },
      onRecord: (handler) => {
        this.recordHandler = handler;
        return () => {
          if (this.recordHandler === handler) this.recordHandler = null;
        };
      },
      onClose: (handler) => {
        this.carrierCloseHandlers.add(handler);
        return () => this.carrierCloseHandlers.delete(handler);
      },
      close: (reason) => this.close(1000, reason),
    };
    this.endpoint = new DataEndpoint({
      role: "server",
      carrier,
      key,
      maxReceiveBytesPerStream: 64 * 1024 * 1024,
    });
    this.endpoint.onIncoming((stream) => {
      void this.handle(stream, identity).catch(() => {});
    });
    const welcome = new TextEncoder().encode(
      JSON.stringify({ version: DATA_PLANE_VERSION, serverNonce, proof }),
    );
    this.onmessage?.({ data: welcome });
  }

  private async handle(stream: DataStream, identity: Partial<HelloResult>): Promise<void> {
    const method = stream.requestHead.method;
    if (method === "events") {
      await collectBody(stream.body(), 1);
      await stream.respond({
        status: 200,
        metadata: { codec: "json-u32be" },
        bodyLength: undefined,
      });
      this.events = stream;
      return;
    }

    const body = await collectBody(stream.body(), 4 * 1024 * 1024);
    const id = String(stream.id);
    if (method === "protocol.identity") {
      this.sent.push({ id, type: method });
      this.streams.set(id, stream);
      if (this.options.autoProtocolIdentity === false) {
        await this.respond(
          id,
          {
            status: 404,
            metadata: null,
            error: { code: "notFound", message: "unknown exchange method" },
          },
          new Uint8Array(),
        );
        return;
      }
      await this.respond(
        id,
        { status: 200, metadata: null },
        new TextEncoder().encode(
          JSON.stringify({
            webProtocol:
              identity.webProtocol ??
              this.options.identity?.webProtocol ??
              WEB_PROTOCOL_VERSION,
          }),
        ),
      );
      return;
    }
    if (method === "rpc") {
      const request = JSON.parse(new TextDecoder().decode(body)) as Request;
      this.sent.push({
        id,
        type: request.type,
        ...(!("payload" in request) || request.payload === undefined
          ? {}
          : { payload: request.payload as unknown as Record<string, unknown> }),
      });
      this.streams.set(id, stream);
      if (this.silent) return;
      if (request.type === "connection.identity" && this.options.autoIdentity !== false) {
        this.reply(id, {
          type: "hello",
          data: {
            daemonVersion: "test",
            webProtocol: WEB_PROTOCOL_VERSION,
            machineId: "m_test",
            machineName: "测试机器",
            fingerprint: "AAAA-BBBB",
            transport: this.hello?.auth.type === "loopback" ? "loopback" : "forwarded",
            rtcSupported: false,
            ...this.options.identity,
            ...identity,
          },
        });
      }
      return;
    }

    this.sent.push({
      id,
      type: method,
      payload: stream.requestHead.metadata as unknown as Record<string, unknown>,
    });
    this.streams.set(id, stream);
  }

  private async respond(
    id: string,
    head: {
      status: number;
      metadata: unknown;
      bodyLength?: number;
      error?: ProtocolError;
    },
    bytes: Uint8Array,
  ): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(`no logical stream ${id} is waiting for a reply`);
    this.streams.delete(id);
    await stream.respond({
      status: head.status,
      metadata: head.metadata as never,
      bodyLength: head.bodyLength ?? bytes.byteLength,
      error: head.error,
    });
    if (bytes.byteLength > 0) await stream.write(bytes);
    await stream.finish();
  }

  /**
   * Public fake-peer controls stay synchronous for tests, while their real
   * encrypted writes are asynchronous. Closing the carrier in the same turn
   * legitimately rejects an in-flight write; consume only that shutdown race
   * and keep every error from a live fake peer visible to Vitest.
   */
  private background(task: Promise<void>): void {
    void task.catch((error) => {
      if (this.closed) return;
      queueMicrotask(() => {
        throw error;
      });
    });
  }
}

/** Hands out independently configured sockets in dial order. */
export function socketQueue(options: FakePeerOptions = {}): {
  factory: (url: string) => WebSocketLike;
  sockets: FakeSocket[];
  urls: string[];
  latest(): FakeSocket;
} {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  return {
    factory: (url) => {
      urls.push(url);
      const socket = new FakeSocket(options);
      sockets.push(socket);
      return socket;
    },
    sockets,
    urls,
    latest() {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error("nothing has connected yet");
      return socket;
    },
  };
}

function contextOf(hello: PeerHello): string {
  switch (hello.auth.type) {
    case "loopback":
      return "loopback";
    case "device":
      return deviceChannelContext(hello.auth.deviceId);
    case "hosted":
      return hostedChannelContext(hello.auth.capabilityId);
    case "invite":
      return `invite:${hello.auth.inviteId}`;
  }
}

function nonceOf(hello: PeerHello): string {
  return hello.auth.nonce;
}

function immediateBytes(data: string | ArrayBuffer | ArrayBufferView | Blob): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  }
  throw new TypeError("FakeSocket only accepts synchronously readable WebSocket messages");
}

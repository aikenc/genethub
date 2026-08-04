import type {
  HelloResult,
  ProtocolError,
  Reply,
  Request,
  SequencedEvent,
  ServerFrame,
  UpdateDownload,
} from "@genehub/proto";

import {
  channelClientProof,
  channelServerProof,
  deriveChannelSessionKey,
  deviceChannelContext,
  hostedChannelContext,
  openChannelFrame,
  randomNonce,
  sealChannelFrame,
  type ChannelSessionKey,
} from "../devices/proof";

export const PROTOCOL_VERSION = 2;

export interface HostedChannelCredential {
  capabilityId: string;
  secret: string;
}

export interface LocalServerProof {
  proof: string;
  challenge: string;
  pid: number;
  machineId: string;
  fingerprint: string;
  /** Unix seconds; the proof is rejected locally once this deadline passes. */
  expiresAt: number;
}

export interface ProtocolDial {
  url: string;
  channelCredential?: HostedChannelCredential;
  localServerProof?: LocalServerProof;
}

export type ConnectionState =
  "connecting" | "ready" | "reconnecting" | "closed";

export interface ClientOptions {
  url: string;
  /**
   * Where to dial on a *retry*, when the address above cannot be used twice.
   *
   * A forwarding ticket is spent by the connection that used it, so a client
   * that redialled `url` would fail every attempt after the first — one wifi
   * hiccup and the session is over with no sign of why. Absent means the
   * address keeps working, which is true of a loopback port and of a pairing
   * credential.
   */
  redial?: (signal?: AbortSignal) => Promise<string | ProtocolDial>;
  clientName?: string;
  /**
   * Present when this browser paired with the machine earlier. Required by a
   * machine reached through a rendezvous relay, which vouches for nobody.
   */
  credential?: { deviceId: string; secret: string };
  /** Fresh on every hosted reconnect and never placed in the Relay URL. */
  channelCredential?: HostedChannelCredential;
  /** Listener proof obtained out-of-band from the owner-only local shell. */
  localServerProof?: LocalServerProof;
  /** Injected in tests, and by the desktop host when it wants its own socket. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Delay before each reconnection attempt. Also injected in tests. */
  backoffMs?: (attempt: number) => number;
  /**
   * How long a socket may stay in CONNECTING before it is replaced.
   *
   * Some WebKit releases can strand a WebSocket without firing either
   * `error` or `close`. Without a deadline that leaves the whole workbench on
   * “connecting” forever, and a one-use relay ticket is never exchanged for a
   * fresh one.
   */
  connectTimeoutMs?: number;
  /** Total time allowed for minting the next one-use address. */
  redialTimeoutMs?: number;
  /** How long an opened socket may stay silent before completing Hello. */
  helloTimeoutMs?: number;
  /** Deadline for a request after its bytes have been handed to WebSocket. */
  requestTimeoutMs?: number;
  /** Maximum requests retained while no authenticated socket is available. */
  maxQueuedRequests?: number;
  /** Maximum unresolved business requests, including ones already sent. */
  maxPendingRequests?: number;
  /** Total plaintext bytes retained by queued, pending or encrypting requests. */
  maxPendingBytes?: number;
  /** Maximum authenticated frames waiting for ordered WebCrypto processing. */
  maxReceiveBacklogFrames?: number;
  /** Maximum encoded bytes retained by the ordered receive chain. */
  maxReceiveBacklogBytes?: number;
  /** Maximum time a request may wait for a connection before being rejected. */
  maxQueueAgeMs?: number;
  now?: () => number;
  /** Observability hook; callback failures never change transport state. */
  onError?: (error: unknown) => void;
}

/** The slice of `WebSocket` this client uses, so a fake is cheap to write. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * Events arrive addressed to a topic, `session:<id>`. Subscriptions are keyed
 * by the session id itself, because that is what every caller has.
 */
function sessionOf(topic: string): string {
  return topic.startsWith("session:") ? topic.slice("session:".length) : topic;
}

export class ProtocolError_ extends Error {
  constructor(public readonly detail: ProtocolError) {
    super(detail.message);
    this.name = "ProtocolError";
  }
}

/**
 * The request reached a socket, but that connection disappeared before a
 * result arrived. Retrying automatically would be unsafe for commands: the
 * daemon may already have applied the operation.
 */
export class ConnectionOutcomeUnknownError extends Error {
  constructor() {
    super(
      "the connection was lost after the request was sent; its outcome is unknown",
    );
    this.name = "ConnectionOutcomeUnknownError";
  }
}

export class ClientRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRequestTimeoutError";
  }
}

export class ClientRequestTooLargeError extends Error {
  constructor() {
    super("request is too large for one authenticated channel frame");
    this.name = "ClientRequestTooLargeError";
  }
}

export const MAX_AUTHENTICATED_PLAINTEXT_BYTES = 2_900_000;
export const MAX_CHANNEL_WIRE_BYTES = 4 * 1024 * 1024;

function validHostedCredential(
  credential: unknown,
): credential is HostedChannelCredential {
  if (typeof credential !== "object" || credential === null) return false;
  const candidate = credential as Record<string, unknown>;
  return (
    typeof candidate.capabilityId === "string" &&
    candidate.capabilityId.length > 0 &&
    candidate.capabilityId.length <= 256 &&
    typeof candidate.secret === "string" &&
    candidate.secret.length > 0 &&
    candidate.secret.length <= 512
  );
}

function validLocalServerProof(
  proof: unknown,
): proof is LocalServerProof {
  if (typeof proof !== "object" || proof === null) return false;
  const candidate = proof as Record<string, unknown>;
  return (
    typeof candidate.proof === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.proof) &&
    typeof candidate.challenge === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.challenge) &&
    Number.isSafeInteger(candidate.pid) &&
    (candidate.pid as number) > 0 &&
    typeof candidate.machineId === "string" &&
    candidate.machineId.length > 0 &&
    candidate.machineId.length <= 256 &&
    typeof candidate.fingerprint === "string" &&
    candidate.fingerprint.length > 0 &&
    candidate.fingerprint.length <= 256 &&
    Number.isSafeInteger(candidate.expiresAt) &&
    (candidate.expiresAt as number) > 0
  );
}

export class ClientQueueFullError extends Error {
  constructor() {
    super("too many requests are already waiting for the connection");
    this.name = "ClientQueueFullError";
  }
}

type Pending = {
  resolve: (reply: Reply | undefined) => void;
  reject: (error: unknown) => void;
  kind: "request" | "handshake";
  sentEpoch: symbol | null;
  timer: ReturnType<typeof setTimeout> | null;
  deadlineAt: number;
  bytes: number;
  pendingActive: boolean;
  sendActive: boolean;
  accounted: boolean;
};

type Queued = { id: string; frame: string };

interface Subscription {
  /** Last sequence number applied, so a reconnect asks for the gap only. */
  seq: number;
  onEvent(event: SequencedEvent): void;
  /**
   * Called after a reconnect. `reset` means the gap was too old and the
   * snapshot is a fresh start rather than a continuation.
   */
  onResync(snapshot: unknown, replayed: SequencedEvent[], reset: boolean): void;
  /** One gap repair per session; later notices only request another pass. */
  resync: Promise<void> | null;
  /** An event/desync arrived while the current repair was in flight. */
  needsResync: boolean;
}

/**
 * The daemon connection.
 *
 * Reconnection is the interesting part. A dropped socket must not lose events
 * and must not replay ones already shown, so every subscription remembers the
 * last sequence number it applied and asks for the gap by number rather than
 * by time. When the gap is older than the daemon's retained window it says so,
 * and the caller starts from the snapshot instead of quietly missing history.
 */
export class Client {
  private socket: WebSocketLike | null = null;
  private socketEpoch: symbol | null = null;
  private activeChannelCredential: HostedChannelCredential | undefined;
  private activeLocalServerProof: LocalServerProof | undefined;
  private channelKey: ChannelSessionKey | null = null;
  private outboundSequence = 0;
  private inboundSequence = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private receiveChain: Promise<void> = Promise.resolve();
  private receiveBacklogFrames = 0;
  private receiveBacklogBytes = 0;
  private keyReady: Promise<void> = Promise.resolve();
  private releaseKeyReady: (() => void) | null = null;
  private expectedHello: { id: string; epoch: symbol } | null = null;
  private readonly pending = new Map<string, Pending>();
  private pendingRequestBytes = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly ptyListeners = new Set<
    (ptyId: string, data: string | null) => void
  >();
  private readonly noticeListeners = new Set<
    (level: string, message: string) => void
  >();
  private readonly downloadListeners = new Set<
    (download: UpdateDownload) => void
  >();
  private nextId = 1;
  private attempt = 0;
  private stopped = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private redialGeneration = 0;
  private redialInFlight = false;
  private redialAbort: AbortController | null = null;
  private redialTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Queued[] = [];
  private state: ConnectionState = "connecting";
  /** Why the connection gave up, when it did so for a reason worth showing. */
  failure: ProtocolError | null = null;
  /** What the daemon said it is, including the key fingerprint to compare. */
  identity: HelloResult | null = null;

  constructor(private readonly options: ClientOptions) {
    this.activeChannelCredential = options.channelCredential;
    this.activeLocalServerProof = options.localServerProof;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onPty(listener: (ptyId: string, data: string | null) => void): () => void {
    this.ptyListeners.add(listener);
    return () => this.ptyListeners.delete(listener);
  }

  onNotice(listener: (level: string, message: string) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /**
   * How far the machine has got fetching an installer.
   *
   * Pushed rather than polled, and to every client rather than the one that
   * asked: the download outlives the panel the button was on.
   */
  onUpdateDownload(listener: (download: UpdateDownload) => void): () => void {
    this.downloadListeners.add(listener);
    return () => this.downloadListeners.delete(listener);
  }

  connect(): void {
    if (this.stopped || this.socket || this.redialInFlight) return;
    this.clearRetryTimer();
    const { url, redial } = this.options;
    if (this.attempt === 0 || !redial) {
      this.dial(url);
      return;
    }

    // Asking where to dial can itself fail — the control plane that mints the
    // address may be the thing that is down. That is a dropped connection like
    // any other, so it backs off and asks again rather than giving up here.
    this.redialInFlight = true;
    const generation = ++this.redialGeneration;
    const controller = new AbortController();
    this.redialAbort = controller;
    this.redialTimer = setTimeout(() => {
      if (this.stopped || generation !== this.redialGeneration) return;
      this.redialTimer = null;
      controller.abort();
      this.redialAbort = null;
      this.redialInFlight = false;
      this.redialGeneration += 1;
      this.scheduleReconnect();
    }, this.options.redialTimeoutMs ?? 10_000);
    void Promise.resolve()
      .then(() => redial(controller.signal))
      .then(
      (fresh) => {
        if (this.stopped || generation !== this.redialGeneration) return;
        this.clearRedialTimer();
        this.redialAbort = null;
        this.redialInFlight = false;
        if (typeof fresh === "string") {
          // A hosted reconnect must rotate its secret with its URL. A string
          // remains valid only for loopback/rendezvous callers using no hosted
          // credential.
          if (this.activeChannelCredential || this.activeLocalServerProof)
            return this.authenticationFailed();
          this.dial(fresh);
        } else {
          if (
            typeof fresh !== "object" ||
            fresh === null ||
            typeof fresh.url !== "string" ||
            fresh.url.length === 0 ||
            fresh.url.length > 8_192
          ) {
            return this.authenticationFailed();
          }
          if (this.activeChannelCredential) {
            if (!validHostedCredential(fresh.channelCredential) || fresh.localServerProof) {
              return this.authenticationFailed();
            }
          } else if (this.activeLocalServerProof) {
            if (
              !validLocalServerProof(fresh.localServerProof) ||
              fresh.channelCredential ||
              fresh.localServerProof.challenge ===
                this.activeLocalServerProof.challenge ||
              fresh.localServerProof.proof === this.activeLocalServerProof.proof
            ) {
              return this.authenticationFailed();
            }
          }
          this.activeChannelCredential = fresh.channelCredential;
          this.activeLocalServerProof = fresh.localServerProof;
          this.dial(fresh.url);
        }
      },
      () => {
        if (this.stopped || generation !== this.redialGeneration) return;
        this.clearRedialTimer();
        this.redialAbort = null;
        this.redialInFlight = false;
        this.scheduleReconnect();
      },
      );
  }

  private dial(url: string): void {
    const factory =
      this.options.socketFactory ??
      ((at: string) => new WebSocket(at) as WebSocketLike);
    let socket: WebSocketLike;
    try {
      socket = factory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const epoch = Symbol("protocol-connection");
    this.socket = socket;
    this.socketEpoch = epoch;
    this.channelKey = null;
    this.outboundSequence = 0;
    this.inboundSequence = 0;
    this.sendChain = Promise.resolve();
    this.receiveChain = Promise.resolve();
    this.receiveBacklogFrames = 0;
    this.receiveBacklogBytes = 0;
    if (this.options.credential || this.activeChannelCredential) {
      this.keyReady = new Promise<void>((resolve) => {
        this.releaseKeyReady = resolve;
      });
    } else {
      this.keyReady = Promise.resolve();
      this.releaseKeyReady = null;
    }
    this.expectedHello = null;
    this.clearConnectTimer();
    this.connectTimer = setTimeout(
      () => this.abandon(socket),
      this.options.connectTimeoutMs ?? 5_000,
    );

    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.clearConnectTimer();
      void this.handshake(socket, epoch);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== "string") {
        this.authenticationFailed(socket, epoch);
        return;
      }
      const raw = event.data;
      const rawBytes = new TextEncoder().encode(raw).byteLength;
      if (rawBytes > MAX_CHANNEL_WIRE_BYTES) {
        this.authenticationFailed(socket, epoch);
        return;
      }
      if (!this.channelKey && !this.releaseKeyReady) {
        void this.receive(raw, socket, epoch).catch(() =>
          this.authenticationFailed(socket, epoch),
        );
        return;
      }
      if (
        this.receiveBacklogFrames >= (this.options.maxReceiveBacklogFrames ?? 64) ||
        this.receiveBacklogBytes + rawBytes >
          (this.options.maxReceiveBacklogBytes ?? 8 * 1024 * 1024)
      ) {
        this.authenticationFailed(socket, epoch);
        return;
      }
      this.receiveBacklogFrames += 1;
      this.receiveBacklogBytes += rawBytes;
      this.receiveChain = this.receiveChain
        .then(() => this.receive(raw, socket, epoch))
        .catch(() => this.authenticationFailed(socket, epoch))
        .finally(() => {
          if (this.socketEpoch !== epoch) return;
          this.receiveBacklogFrames -= 1;
          this.receiveBacklogBytes -= rawBytes;
        });
    };
    socket.onclose = () => this.dropped(socket);
    socket.onerror = () => socket.close();
  }

  close(): void {
    this.stopped = true;
    this.clearConnectTimer();
    this.clearRetryTimer();
    this.redialGeneration += 1;
    this.redialAbort?.abort();
    this.redialAbort = null;
    this.clearRedialTimer();
    this.redialInFlight = false;
    this.setState("closed");
    this.socket?.close();
    this.socket = null;
    this.socketEpoch = null;
    this.releaseKeyReady?.();
    this.releaseKeyReady = null;
    this.queue = [];
    for (const pending of this.pending.values()) {
      this.clearPendingTimer(pending);
      this.finishPendingReservation(pending);
      const { reject } = pending;
      reject(new Error("the connection was closed"));
    }
    this.pending.clear();
  }

  /** Sends a request and resolves with its reply. */
  async call(request: Request): Promise<Reply | undefined> {
    const id = String(this.nextId++);
    const frame = JSON.stringify({ id, ...request });
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    if (frameBytes > MAX_AUTHENTICATED_PLAINTEXT_BYTES) {
      throw new ClientRequestTooLargeError();
    }
    const readyEpoch =
      this.state === "ready" && this.socket ? this.socketEpoch : null;
    const businessPending = [...this.pending.values()].filter(
      (pending) => pending.kind === "request",
    ).length;
    if (businessPending >= (this.options.maxPendingRequests ?? 128)) {
      throw new ClientQueueFullError();
    }
    if (
      this.pendingRequestBytes + frameBytes >
      (this.options.maxPendingBytes ?? 16 * 1024 * 1024)
    ) {
      throw new ClientQueueFullError();
    }
    if (
      !readyEpoch &&
      this.queue.length >= (this.options.maxQueuedRequests ?? 128)
    ) {
      throw new ClientQueueFullError();
    }
    const promise = new Promise<Reply | undefined>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        kind: "request",
        sentEpoch: null,
        timer: null,
        deadlineAt:
          (this.options.now?.() ?? Date.now()) +
          (readyEpoch
            ? (this.options.requestTimeoutMs ?? 60_000)
            : Math.min(
                this.options.maxQueueAgeMs ?? 30_000,
                this.options.requestTimeoutMs ?? 60_000,
              )),
        bytes: frameBytes,
        pendingActive: true,
        sendActive: false,
        accounted: true,
      };
      this.pendingRequestBytes += frameBytes;
      this.pending.set(id, pending);
      if (!readyEpoch) {
        this.armPending(
          id,
          pending,
          this.options.maxQueueAgeMs ?? 30_000,
          "the request waited too long for a connection",
        );
      }
    });

    if (readyEpoch) this.sendRequest(id, frame, readyEpoch);
    // Queued rather than rejected: a request typed during a blip should land
    // when the socket comes back, not fail in the user's face.
    else this.queue.push({ id, frame });

    return promise;
  }

  /**
   * Subscribes to a session. Returns the initial snapshot; later reconnects
   * deliver theirs through `onResync`.
   */
  async subscribe(
    sessionId: string,
    handlers: Pick<Subscription, "onEvent" | "onResync">,
  ): Promise<{
    snapshot: unknown;
    replayed: SequencedEvent[];
    reset: boolean;
  }> {
    const subscription: Subscription = {
      seq: 0,
      ...handlers,
      resync: null,
      needsResync: false,
    };
    this.subscriptions.set(sessionId, subscription);

    const reply = await this.call({
      type: "subscribe",
      payload: { sessionId, sinceSeq: 0 },
    });
    if (reply?.type !== "subscribed") {
      this.subscriptions.delete(sessionId);
      throw new Error(`unexpected reply to subscribe: ${reply?.type}`);
    }
    for (const event of reply.data.replayed) subscription.seq = event.seq;
    return {
      snapshot: reply.data.snapshot,
      replayed: reply.data.replayed,
      reset: reply.data.reset,
    };
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.subscriptions.delete(sessionId);
    await this.call({ type: "unsubscribe", payload: { sessionId } });
  }

  // -------------------------------------------------------------------------

  private async handshake(socket: WebSocketLike, epoch: symbol): Promise<void> {
    const credential = this.options.credential;
    const channelCredential = this.activeChannelCredential;
    const localServerProof = this.activeLocalServerProof;
    if (
      (channelCredential && !validHostedCredential(channelCredential)) ||
      (localServerProof && !validLocalServerProof(localServerProof))
    ) {
      this.authenticationFailed();
      return;
    }
    if (
      [credential, channelCredential, localServerProof].filter(Boolean).length > 1
    ) {
      this.authenticationFailed();
      return;
    }
    const secret = credential?.secret ?? channelCredential?.secret;
    const context = credential
      ? deviceChannelContext(credential.deviceId)
      : channelCredential
        ? hostedChannelContext(channelCredential.capabilityId)
        : null;
    const id = String(this.nextId++);
    const promise = new Promise<Reply | undefined>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        kind: "handshake",
        sentEpoch: epoch,
        timer: null,
        deadlineAt:
          (this.options.now?.() ?? Date.now()) +
          (this.options.helloTimeoutMs ?? 10_000),
        bytes: 0,
        pendingActive: true,
        sendActive: false,
        accounted: false,
      };
      this.pending.set(id, pending);
      this.expectedHello = { id, epoch };
      this.armPending(
        id,
        pending,
        this.options.helloTimeoutMs ?? 10_000,
        "the daemon did not answer Hello before its deadline",
        () => this.abandon(socket),
      );
    });
    // Proof generation crosses an asynchronous WebCrypto boundary. Install the
    // epoch/correlation gate before that await: a Relay controls delivery timing
    // and must not be able to resolve an ordinary queued RPC with plaintext in
    // the small window between WebSocket open and Hello being sent.
    void promise.catch(() => {});
    try {
      const nonce = secret && context ? randomNonce() : null;
      const clientProof =
        secret && context && nonce
          ? await channelClientProof(secret, context, nonce)
          : null;
      const frame = JSON.stringify({
        id,
        type: "hello",
        payload: {
          // Remote-facing client labels are fixed; a person's chosen name is
          // business metadata and only travels after encryption is active.
          clientName: secret
            ? "genehub-client"
            : (this.options.clientName ?? "genehub-web"),
          protocolVersion: PROTOCOL_VERSION,
          device:
            credential && nonce && clientProof
              ? {
                  deviceId: credential.deviceId,
                  nonce,
                  proof: clientProof,
                }
              : undefined,
          channel:
            channelCredential && nonce && clientProof
              ? {
                  capabilityId: channelCredential.capabilityId,
                  nonce,
                  proof: clientProof,
                }
              : undefined,
        },
      });
      if (this.socket !== socket || this.socketEpoch !== epoch || this.stopped)
        return;
      socket.send(frame);
      const reply = await promise;
      if (reply?.type !== "hello") {
        throw new ProtocolError_({
          code: "protocolVersion",
          message: "the daemon did not complete the Hello handshake",
        });
      }
      if (secret && context && nonce) {
        if (!reply.data.serverNonce) {
          throw new ProtocolError_({
            code: "unauthorized",
            message: "the daemon omitted its channel challenge",
          });
        }
        const expected = await channelServerProof(
          secret,
          context,
          nonce,
          reply.data.serverNonce,
        );
        if (reply.data.proof !== expected) {
          throw new ProtocolError_({
            code: "unauthorized",
            message: "对面不是你配对过的那台机器，连接已断开",
          });
        }
        this.channelKey = await deriveChannelSessionKey(
          secret,
          context,
          nonce,
          reply.data.serverNonce,
        );
        this.releaseKeyReady?.();
        this.releaseKeyReady = null;
        this.expectedHello = null;
        const identityId = String(this.nextId++);
        const identityFrame = JSON.stringify({
          id: identityId,
          type: "connection.identity",
        });
        const identityPromise = new Promise<Reply | undefined>(
          (resolve, reject) => {
            this.pending.set(identityId, {
              resolve,
              reject,
              kind: "handshake",
              sentEpoch: null,
              timer: null,
              deadlineAt:
                (this.options.now?.() ?? Date.now()) +
                (this.options.helloTimeoutMs ?? 10_000),
              bytes: 0,
              pendingActive: true,
              sendActive: false,
              accounted: false,
            });
          },
        );
        this.sendRequest(identityId, identityFrame, epoch);
        const identity = await identityPromise;
        if (identity?.type !== "hello") {
          throw new ProtocolError_({
            code: "unauthorized",
            message: "the daemon did not return its encrypted identity",
          });
        }
        this.identity = identity.data;
      } else if (localServerProof) {
        const now = this.options.now?.() ?? Date.now();
        if (
          !validLocalServerProof(localServerProof) ||
          localServerProof.expiresAt * 1000 <= now ||
          reply.data.protocolVersion !== PROTOCOL_VERSION ||
          reply.data.transport !== "loopback" ||
          reply.data.machineId !== localServerProof.machineId ||
          reply.data.fingerprint !== localServerProof.fingerprint ||
          reply.data.serverNonce !== undefined ||
          reply.data.proof !== localServerProof.proof
        ) {
          throw new ProtocolError_({
            code: "unauthorized",
            message: "本地端口没有证明它是桌面端启动的 daemon，连接已中止",
          });
        }
        this.expectedHello = null;
        this.identity = reply.data;
      } else {
        this.expectedHello = null;
        this.identity = reply.data;
      }
    } catch (error) {
      this.releaseKeyReady?.();
      this.releaseKeyReady = null;
      if (this.socket !== socket || this.socketEpoch !== epoch || this.stopped)
        return;
      // A refused handshake is not something retrying fixes: the versions do
      // not match, or the credential is wrong. Stop, and keep the reason so the
      // UI can say which of those it was instead of spinning forever.
      if (error instanceof ProtocolError_) {
        this.failure = error.detail;
        this.close();
      } else {
        this.abandon(socket);
      }
      return;
    }

    if (this.socket !== socket || this.socketEpoch !== epoch || this.stopped)
      return;
    this.attempt = 0;
    this.setState("ready");
    this.flushQueue(socket, epoch);
    await this.resubscribe();
  }

  /** Asks for the gap on every open session. */
  private async resubscribe(): Promise<void> {
    for (const sessionId of [...this.subscriptions.keys()]) {
      await this.fillGap(sessionId);
    }
  }

  /**
   * Asks for whatever happened on one session since the last sequence number
   * this client saw.
   *
   * The same request serves a reconnect and a dropped-events notice, because
   * they are the same situation: this client's view stops at some sequence
   * number and the daemon's does not.
   */
  private async fillGap(sessionId: string): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;
    subscription.needsResync = true;
    if (subscription.resync) return subscription.resync;

    const repair = (async () => {
      while (
        this.subscriptions.get(sessionId) === subscription &&
        subscription.needsResync
      ) {
        subscription.needsResync = false;
        const reply = await this.call({
          type: "subscribe",
          payload: { sessionId, sinceSeq: subscription.seq },
        }).catch(() => undefined);
        if (reply?.type !== "subscribed") return;

        for (const event of reply.data.replayed) {
          if (event.seq > subscription.seq) subscription.seq = event.seq;
        }
        this.callListener(() =>
          subscription.onResync(
            reply.data.snapshot,
            reply.data.replayed,
            reply.data.reset,
          ),
        );
      }
    })();
    subscription.resync = repair;
    try {
      await repair;
    } finally {
      if (subscription.resync === repair) subscription.resync = null;
    }
  }

  private async receive(
    raw: string,
    socket: WebSocketLike,
    epoch: symbol,
  ): Promise<void> {
    if (this.socket !== socket || this.socketEpoch !== epoch) return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      if (this.channelKey || this.state !== "ready")
        throw new Error("malformed authenticated channel frame");
      return;
    }

    if (frame.type === "authenticated" && !this.channelKey && this.releaseKeyReady) {
      await this.keyReady;
      if (this.socket !== socket || this.socketEpoch !== epoch) return;
    }

    const channelKey = this.channelKey;
    if (channelKey) {
      if (frame.type !== "authenticated") {
        throw new Error("unsigned frame after channel authentication");
      }
      const expected = this.inboundSequence + 1;
      if (!Number.isSafeInteger(expected) || frame.sequence !== expected) {
        throw new Error("replayed or out-of-order channel frame");
      }
      const plaintext = await openChannelFrame(
        channelKey,
        "daemon-to-client",
        frame.sequence,
        frame.body,
        frame.mac,
      );
      if (
        this.socket !== socket ||
        this.socketEpoch !== epoch ||
        this.channelKey !== channelKey
      )
        return;
      frame = JSON.parse(plaintext) as ServerFrame;
      if (frame.type === "authenticated") {
        throw new Error("nested authenticated channel frame");
      }
      this.inboundSequence = expected;
    } else if (frame.type === "authenticated") {
      throw new Error("authenticated frame arrived before Hello completed");
    } else if (this.state !== "ready") {
      const expected = this.expectedHello;
      if (
        !expected ||
        expected.epoch !== epoch ||
        frame.type !== "result" ||
        frame.id !== expected.id ||
        this.pending.get(frame.id)?.kind !== "handshake"
      ) {
        throw new Error("unexpected plaintext frame during Hello");
      }
    }

    switch (frame.type) {
      case "result": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        this.finishPendingReservation(pending);
        this.clearPendingTimer(pending);
        if (frame.ok) pending.resolve(frame.payload);
        else {
          pending.reject(
            new ProtocolError_(
              frame.error ?? {
                code: "internal",
                message: "the daemon reported a failure",
              },
            ),
          );
        }
        return;
      }
      case "event": {
        const sessionId = sessionOf(frame.topic);
        const subscription = this.subscriptions.get(sessionId);
        if (!subscription) return;
        // Out-of-order or duplicate events are dropped rather than applied:
        // the sequence number is the only thing that decides what is new.
        if (frame.payload.seq <= subscription.seq) return;
        if (
          subscription.resync ||
          frame.payload.seq !== subscription.seq + 1
        ) {
          void this.fillGap(sessionId);
          return;
        }
        subscription.seq = frame.payload.seq;
        this.callListener(() => subscription.onEvent(frame.payload));
        return;
      }
      case "pty":
        for (const listener of this.ptyListeners)
          this.callListener(() => listener(frame.ptyId, frame.data));
        return;
      case "ptyClosed":
        for (const listener of this.ptyListeners)
          this.callListener(() => listener(frame.ptyId, null));
        return;
      case "notice":
        for (const listener of this.noticeListeners)
          this.callListener(() => listener(frame.level, frame.message));
        return;
      case "updateDownload":
        for (const listener of this.downloadListeners)
          this.callListener(() => listener(frame.download));
        return;
      case "desync":
        // The daemon fell behind and dropped events for this session. Nothing
        // to tell the person: the hole is closable from here, with the same
        // request used after a reconnect.
        void this.fillGap(frame.sessionId);
        return;
    }
  }

  /**
   * Gives up a socket WebKit left suspended in CONNECTING.
   *
   * Its handlers are detached first because `close()` may synchronously fire
   * `onclose` in a test double and asynchronously in a browser. Either way one
   * failed dial must schedule exactly one retry.
   */
  private abandon(socket: WebSocketLike): void {
    if (this.stopped || this.socket !== socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    this.dropped(socket);
  }

  private dropped(socket?: WebSocketLike): void {
    if (this.stopped || (socket && this.socket !== socket)) return;
    this.clearConnectTimer();
    const epoch = this.socketEpoch;
    this.setState("reconnecting");
    this.socket = null;
    this.socketEpoch = null;
    this.redialGeneration += 1;
    this.redialInFlight = false;
    this.releaseKeyReady?.();
    this.releaseKeyReady = null;

    // A sent command is never moved back into the offline queue. Its side
    // effects may have happened even though the result was lost.
    if (epoch) {
      for (const [id, pending] of this.pending) {
        if (pending.sentEpoch !== epoch) continue;
        this.pending.delete(id);
        this.finishPendingReservation(pending);
        this.clearPendingTimer(pending);
        pending.reject(
          pending.kind === "handshake"
            ? new Error("the connection was lost during Hello")
            : new ConnectionOutcomeUnknownError(),
        );
      }
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.socket || this.retryTimer !== null) return;
    this.setState("reconnecting");
    const backoff =
      this.options.backoffMs ??
      ((attempt) => Math.min(1000 * 2 ** attempt, 15_000));
    const delay = backoff(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearRedialTimer(): void {
    if (this.redialTimer === null) return;
    clearTimeout(this.redialTimer);
    this.redialTimer = null;
  }

  private sendRequest(id: string, frame: string, epoch: symbol): void {
    const plainPending = this.pending.get(id);
    const plainSocket = this.socket;
    if (
      !this.channelKey &&
      plainPending &&
      plainSocket &&
      this.socketEpoch === epoch
    ) {
      plainPending.sentEpoch = epoch;
      this.armPending(
        id,
        plainPending,
        this.options.requestTimeoutMs ?? 60_000,
        "the daemon did not answer the request before its deadline",
      );
      try {
        plainSocket.send(frame);
      } catch {
        this.pending.delete(id);
        this.finishPendingReservation(plainPending);
        this.clearPendingTimer(plainPending);
        plainPending.reject(new ConnectionOutcomeUnknownError());
        this.abandon(plainSocket);
      }
      return;
    }
    if (plainPending) {
      // From the moment encryption is scheduled, a disconnect makes the
      // outcome conservatively unknown. Otherwise a socket drop during slow
      // WebCrypto leaves this request neither queued nor rejectable.
      plainPending.sentEpoch = epoch;
      plainPending.sendActive = true;
      this.armPending(
        id,
        plainPending,
        this.options.requestTimeoutMs ?? 60_000,
        "the daemon did not answer the request before its deadline",
      );
    }
    const operation = this.sendChain.then(async () => {
      const pending = this.pending.get(id);
      const socket = this.socket;
      if (!pending || !socket || this.socketEpoch !== epoch) return;
      let wire = frame;
      const channelKey = this.channelKey;
      if (channelKey) {
        const sequence = this.outboundSequence + 1;
        if (!Number.isSafeInteger(sequence)) {
          throw new Error("channel sequence exhausted");
        }
        const sealed = await sealChannelFrame(
          channelKey,
          "client-to-daemon",
          sequence,
          frame,
        );
        if (
          this.socket !== socket ||
          this.socketEpoch !== epoch ||
          this.channelKey !== channelKey
        )
          return;
        if (this.pending.get(id) !== pending) return;
        wire = JSON.stringify({
          id,
          type: "authenticated",
          payload: { sequence, body: sealed.body, mac: sealed.mac },
        });
        this.outboundSequence = sequence;
      }
      try {
        socket.send(wire);
      } catch {
        this.pending.delete(id);
        this.finishPendingReservation(pending);
        this.clearPendingTimer(pending);
        pending.reject(new ConnectionOutcomeUnknownError());
        this.abandon(socket);
      }
    });
    const socket = this.socket;
    this.sendChain = operation
      .catch(() => this.authenticationFailed(socket, epoch))
      .finally(() => {
        if (plainPending) this.finishSendReservation(plainPending);
      });
  }

  private flushQueue(socket: WebSocketLike, epoch: symbol): void {
    while (this.queue.length > 0) {
      if (this.socket !== socket || this.socketEpoch !== epoch) return;
      const queued = this.queue.shift();
      if (!queued) return;
      this.sendRequest(queued.id, queued.frame, epoch);
    }
  }

  private armPending(
    id: string,
    pending: Pending,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void,
  ): void {
    this.clearPendingTimer(pending);
    pending.timer = setTimeout(
      () => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        this.finishPendingReservation(pending);
        this.queue = this.queue.filter((entry) => entry.id !== id);
        pending.timer = null;
        pending.reject(new ClientRequestTimeoutError(message));
        onTimeout?.();
      },
      Math.max(
        1,
        Math.min(
          timeoutMs,
          pending.deadlineAt - (this.options.now?.() ?? Date.now()),
        ),
      ),
    );
  }

  private clearPendingTimer(pending: Pending): void {
    if (pending.timer === null) return;
    clearTimeout(pending.timer);
    pending.timer = null;
  }

  private finishPendingReservation(pending: Pending): void {
    pending.pendingActive = false;
    this.maybeReleaseReservation(pending);
  }

  private finishSendReservation(pending: Pending): void {
    pending.sendActive = false;
    this.maybeReleaseReservation(pending);
  }

  private maybeReleaseReservation(pending: Pending): void {
    if (!pending.accounted || pending.pendingActive || pending.sendActive) return;
    pending.accounted = false;
    this.pendingRequestBytes = Math.max(
      0,
      this.pendingRequestBytes - pending.bytes,
    );
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners)
      this.callListener(() => listener(state));
  }

  private callListener(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // Observability is outside the connection state machine too.
      }
    }
  }

  private authenticationFailed(
    socket?: WebSocketLike | null,
    epoch?: symbol | null,
  ): void {
    if (
      this.stopped ||
      (socket !== undefined && socket !== null && this.socket !== socket) ||
      (epoch !== undefined && epoch !== null && this.socketEpoch !== epoch)
    )
      return;
    this.failure = {
      code: "unauthorized",
      message: "通道消息无法验证，连接已安全关闭",
    };
    this.close();
  }
}

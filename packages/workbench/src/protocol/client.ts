import type {
  AssetPreviewError,
  AssetPreviewMetadata,
  BackgroundProcess,
  HelloResult,
  PeerWelcome,
  ProtocolError,
  Reply,
  Request,
  SequencedEvent,
  ServerFrame,
  SupportDiagnostics,
  UpdateDownload,
} from "@genehub/proto";

import {
  DATA_PLANE_VERSION,
  DataEndpoint,
  DataPlaneError,
  DataReset,
  openFabricDataLink,
  WebSocketRecordCarrier,
  binaryMessage,
  collectBody,
  collectBodyExact,
  openRtcDataLink,
  preparePeerHandshake,
  type DataStream,
  type FabricDataLink,
  type PeerCredential,
  type RtcDataLink,
} from "../dataplane";
import type { BinaryWebSocketLike } from "../dataplane/websocket";
import {
  WEB_PROTOCOL_VERSION,
  UnsupportedBusinessProtocolError,
  protocolCodec,
  type ProtocolCodec,
} from "./codec";

export { WEB_PROTOCOL_VERSION } from "./codec";
export const MAX_RPC_BODY_BYTES = 2_900_000;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const PREVIEW_HEAD_TIMEOUT_MS = 60_000;
const PREVIEW_STALL_TIMEOUT_MS = 60_000;
const MAX_EVENT_BYTES = 3 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A carrier that dies before this point is flapping, not a healthy recovery. */
const STABLE_AFTER_MS = 30_000;
/**
 * How often an idle ready connection is asked to prove it is still alive.
 * Mobile browsers — iOS Safari above all — suspend the page and let the
 * carrier die without ever firing close, so without this the workbench only
 * learns the connection is gone when the next user request times out.
 */
const HEARTBEAT_MS = 25_000;
/** A heartbeat that takes this long is a dead carrier, not a slow peer. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

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
  expiresAt: number;
}

export interface InviteChannelCredential {
  inviteId: string;
  secret: string;
}

export interface ProtocolDial {
  url: string;
  fabricRouteTicket?: string;
  channelCredential?: HostedChannelCredential;
  localServerProof?: LocalServerProof;
}

export type ConnectionState = "connecting" | "ready" | "reconnecting" | "closed";
export type RtcState =
  | "disabled"
  | "unavailable"
  | "standby"
  | "connecting"
  | "connected"
  | "failed";

export type ClientDiagnosticKind = "connection" | "transport" | "rtc" | "operation" | "error";
export type ClientDiagnosticDetail = Record<string, string | number | boolean | null>;

/** Safe, transport-independent evidence emitted by the business client. */
export interface ClientDiagnosticEvent {
  at: string;
  kind: ClientDiagnosticKind;
  detail: ClientDiagnosticDetail;
}

export interface ClientOptions {
  url: string;
  redial?: (signal?: AbortSignal) => Promise<string | ProtocolDial>;
  clientName?: string;
  credential?: { deviceId: string; secret: string };
  channelCredential?: HostedChannelCredential;
  fabricRouteTicket?: string;
  localServerProof?: LocalServerProof;
  inviteCredential?: InviteChannelCredential;
  rtcEnabled?: boolean;
  /** Test/embedding seam; production uses the browser WebRTC implementation. */
  rtcFactory?: (
    base: DataEndpoint,
    diagnosticId?: string,
    onDiagnostic?: (detail: ClientDiagnosticDetail) => void,
  ) => Promise<RtcDataLink>;
  socketFactory?: (url: string) => WebSocketLike;
  backoffMs?: (attempt: number) => number;
  connectTimeoutMs?: number;
  redialTimeoutMs?: number;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxQueuedRequests?: number;
  maxPendingRequests?: number;
  maxPendingBytes?: number;
  maxQueueAgeMs?: number;
  /** Idle liveness probe cadence; 0 disables it. Defaults to 25s. */
  heartbeatMs?: number;
  /** Deadline for a single liveness probe. Defaults to 10s. */
  heartbeatTimeoutMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  onDiagnostic?: (event: ClientDiagnosticEvent) => void;
}

export interface WebSocketLike extends BinaryWebSocketLike {}

export interface CloseReason {
  code?: number;
  reason?: string;
}

export interface AssetPreviewResult {
  metadata: AssetPreviewMetadata;
  bytes: Uint8Array;
  transfer: AssetPreviewTransferStats;
}

export type AssetPreviewTransport = "websocket" | "fabric" | "rtc";

/** User-facing measurements for the entry file of one Preview request. */
export interface AssetPreviewTransferStats {
  transport: AssetPreviewTransport;
  responseBytes: number;
  /** Request start through exact body completion: the user's total wait. */
  elapsedMs: number;
  /** Request start through the first non-empty DATA chunk; null for an empty body. */
  firstByteMs: number | null;
  /** Response-head acceptance through exact body completion. */
  transferMs: number;
  /** Body bytes divided by transferMs; null when the clock cannot resolve it. */
  averageBytesPerSecond: number | null;
  chunkCount: number;
  largestChunkBytes: number;
}

export class ProtocolError_ extends Error {
  constructor(public readonly detail: ProtocolError) {
    super(detail.message);
    this.name = "ProtocolError";
  }
}

export class AssetPreviewError_ extends Error {
  constructor(
    public readonly detail: AssetPreviewError,
    public readonly status: number,
    public readonly sourceBytes?: number,
  ) {
    super(previewErrorMessage(detail, sourceBytes));
    this.name = "AssetPreviewError";
  }
}

export class ConnectionOutcomeUnknownError extends Error {
  constructor(public readonly close?: CloseReason) {
    const detail = describeClose(close);
    super(`the connection was lost after the request was sent${detail}; its outcome is unknown`);
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
    super("request is too large for the data-plane RPC exchange");
    this.name = "ClientRequestTooLargeError";
  }
}

export class ClientQueueFullError extends Error {
  constructor() {
    super("too many requests are already waiting for this peer");
    this.name = "ClientQueueFullError";
  }
}

interface Subscription {
  seq: number;
  onEvent(event: SequencedEvent): void;
  onResync(snapshot: unknown, replayed: SequencedEvent[], reset: boolean): void;
  resync: Promise<void> | null;
  needsResync: boolean;
  expandLastRound: boolean;
}

interface PendingCall {
  id: string;
  operation: string;
  queuedAt: number;
  request: Request;
  bytes: number;
  resolve(value: Reply | undefined): void;
  reject(error: unknown): void;
  queueTimer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

function sessionOf(topic: string): string {
  return topic.startsWith("session:") ? topic.slice("session:".length) : topic;
}

/**
 * Business client over protocol v3. WebSocket/Fabric/RTC are only carriers;
 * RPC, events and Preview each use independent E2EE logical streams.
 */
export class Client {
  private socket: WebSocketLike | null = null;
  private fabricLink: FabricDataLink | null = null;
  private dialingTransport = false;
  private endpoint: DataEndpoint | null = null;
  private epoch: symbol | null = null;
  private activeChannelCredential: HostedChannelCredential | undefined;
  private activeLocalServerProof: LocalServerProof | undefined;
  private activeFabricRouteTicket: string | undefined;
  private readonly queue: PendingCall[] = [];
  private readonly active = new Set<PendingCall>();
  private pendingBytes = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly rtcListeners = new Set<(state: RtcState) => void>();
  private readonly ptyListeners = new Set<(ptyId: string, data: string | null) => void>();
  private readonly noticeListeners = new Set<(level: string, message: string) => void>();
  private readonly downloadListeners = new Set<(download: UpdateDownload) => void>();
  private readonly processListeners = new Set<(processes: BackgroundProcess[]) => void>();
  private state: ConnectionState = "connecting";
  private stopped = false;
  private attempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private redialTimer: ReturnType<typeof setTimeout> | null = null;
  private redialAbort: AbortController | null = null;
  private redialGeneration = 0;
  private redialing = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInFlight = false;
  private lifecycleCleanup: (() => void) | null = null;
  private lastClose: CloseReason | undefined;
  private rtcEnabled: boolean;
  private rtcState_: RtcState;
  private rtcLink: RtcDataLink | null = null;
  private rtcGeneration = 0;
  private connectionEpoch = 0;
  private connectionAttemptId: string | null = null;
  private carrier: "websocket" | "fabric" | null = null;
  private businessCodec: ProtocolCodec = protocolCodec(WEB_PROTOCOL_VERSION);

  failure: ProtocolError | null = null;
  identity: HelloResult | null = null;

  constructor(private readonly options: ClientOptions) {
    this.activeChannelCredential = options.channelCredential;
    this.activeLocalServerProof = options.localServerProof;
    this.activeFabricRouteTicket = options.fabricRouteTicket ?? embeddedFabricRoute(options.url);
    this.rtcEnabled = options.rtcEnabled !== false;
    this.rtcState_ = this.rtcEnabled ? "standby" : "disabled";
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get lastCloseReason(): CloseReason | undefined {
    return this.lastClose;
  }

  get rtcState(): RtcState {
    return this.rtcState_;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onRtcStateChange(listener: (state: RtcState) => void): () => void {
    this.rtcListeners.add(listener);
    return () => this.rtcListeners.delete(listener);
  }

  setRtcEnabled(enabled: boolean): void {
    if (this.rtcEnabled === enabled) return;
    this.rtcEnabled = enabled;
    if (!enabled) {
      this.closeRtc();
      this.setRtcState("disabled");
      return;
    }
    this.setRtcState("standby");
    if (this.endpoint && this.epoch && this.identity && this.state === "ready") {
      void this.startRtc(this.endpoint, this.epoch);
    }
  }

  onPty(listener: (ptyId: string, data: string | null) => void): () => void {
    this.ptyListeners.add(listener);
    return () => this.ptyListeners.delete(listener);
  }

  onNotice(listener: (level: string, message: string) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  onUpdateDownload(listener: (download: UpdateDownload) => void): () => void {
    this.downloadListeners.add(listener);
    return () => this.downloadListeners.delete(listener);
  }

  onBackgroundProcesses(listener: (processes: BackgroundProcess[]) => void): () => void {
    this.processListeners.add(listener);
    return () => this.processListeners.delete(listener);
  }

  connect(): void {
    if (this.stopped || this.socket || this.fabricLink || this.dialingTransport || this.redialing) return;
    this.attachLifecycle();
    this.clearRetryTimer();
    if (this.attempt === 0 || !this.options.redial) {
      this.dial({
        url: this.options.url,
        channelCredential: this.activeChannelCredential,
        localServerProof: this.activeLocalServerProof,
        fabricRouteTicket: this.activeFabricRouteTicket,
      });
      return;
    }
    this.redial();
  }

  close(): void {
    if (this.stopped && this.state === "closed") return;
    this.stopped = true;
    this.redialGeneration += 1;
    this.redialAbort?.abort();
    this.redialAbort = null;
    this.redialing = false;
    this.clearTimers();
    this.detachLifecycle();
    const endpoint = this.endpoint;
    const socket = this.socket;
    const fabricLink = this.fabricLink;
    this.endpoint = null;
    this.socket = null;
    this.fabricLink = null;
    this.dialingTransport = false;
    this.epoch = null;
    this.closeRtc();
    endpoint?.close("client closed");
    socket?.close(1000, "client closed");
    fabricLink?.close();
    this.rejectQueued(new Error("the connection was closed"));
    this.setState("closed");
  }

  async call(request: Request): Promise<Reply | undefined> {
    const operation = request.type;
    const id = diagnosticId("op");
    const queuedAt = this.now();
    const bytes = encoder.encode(JSON.stringify(request)).byteLength;
    if (bytes > MAX_RPC_BODY_BYTES) {
      this.diagnostic("operation", {
        operation,
        requestId: id,
        phase: "rejected",
        outcome: "too-large",
        requestBytes: bytes,
      });
      throw new ClientRequestTooLargeError();
    }
    if (
      this.queue.length + this.active.size >= (this.options.maxPendingRequests ?? 128) ||
      this.pendingBytes + bytes > (this.options.maxPendingBytes ?? 16 * 1024 * 1024)
    ) {
      this.diagnostic("operation", {
        operation,
        requestId: id,
        phase: "rejected",
        outcome: "queue-full",
        requestBytes: bytes,
      });
      throw new ClientQueueFullError();
    }
    if (!this.endpoint && this.queue.length >= (this.options.maxQueuedRequests ?? 128)) {
      this.diagnostic("operation", {
        operation,
        requestId: id,
        phase: "rejected",
        outcome: "queue-full",
        requestBytes: bytes,
      });
      throw new ClientQueueFullError();
    }
    return new Promise<Reply | undefined>((resolve, reject) => {
      const pending: PendingCall = {
        id,
        operation,
        queuedAt,
        request,
        bytes,
        resolve,
        reject,
        queueTimer: null,
        started: false,
      };
      this.pendingBytes += bytes;
      const endpoint = this.state === "ready" ? this.requestEndpoint() : null;
      const epoch = endpoint ? this.epoch : null;
      if (endpoint && epoch) {
        this.startCall(pending, endpoint, epoch);
      } else {
        pending.queueTimer = setTimeout(() => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.release(pending);
          this.diagnostic("operation", {
            operation,
            requestId: id,
            phase: "finish",
            outcome: "queue-timeout",
            queueMs: Math.round(this.now() - queuedAt),
            requestBytes: bytes,
          });
          reject(new ClientRequestTimeoutError("the request waited too long for a connection"));
        }, this.options.maxQueueAgeMs ?? 30_000);
        this.queue.push(pending);
      }
    });
  }

  async preview(workspaceHandle: string, path: string): Promise<AssetPreviewResult> {
    const endpoint = this.requireReadyEndpoint();
    const requestId = diagnosticId("preview");
    const started = this.now();
    const transport = this.transportFor(endpoint);
    this.diagnostic("operation", {
      operation: "asset.preview",
      requestId,
      phase: "start",
      transport,
      path,
    });
    const stream = endpoint.open({
      version: DATA_PLANE_VERSION,
      method: "asset.preview",
      metadata: {
        source: { kind: "workspaceFile", workspaceHandle, path },
        diagnosticId: requestId,
      },
      bodyLength: 0,
    });
    const operation = (async () => {
      const observed = {
        firstByteAt: null as number | null,
        chunkCount: 0,
        largestChunkBytes: 0,
      };
      const head = await withTimeout(
        (async () => {
          await stream.finish();
          return stream.responseHead;
        })(),
        PREVIEW_HEAD_TIMEOUT_MS,
        "asset preview response head timed out",
        () => stream.reset(DataReset.Timeout),
      );
      if (head.status !== 200) {
        const metadata = asRecord(head.metadata);
        throw new AssetPreviewError_(
          previewError(metadata.error),
          head.status,
          typeof metadata.sourceBytes === "number" ? metadata.sourceBytes : undefined,
        );
      }
      if (
        typeof head.bodyLength !== "number" ||
        !Number.isSafeInteger(head.bodyLength) ||
        head.bodyLength < 0 ||
        head.bodyLength > MAX_PREVIEW_BYTES
      ) {
        stream.reset(DataReset.TooLarge);
        throw new AssetPreviewError_("tooLarge", 413, head.bodyLength);
      }
      const metadata = previewMetadata(head.metadata);
      const bodyStarted = this.now();
      const now = () => this.now();
      const measuredBody = (async function* () {
        for await (const chunk of stream.body()) {
          const at = now();
          if (chunk.byteLength > 0 && observed.firstByteAt === null) {
            observed.firstByteAt = at;
          }
          observed.chunkCount += 1;
          observed.largestChunkBytes = Math.max(
            observed.largestChunkBytes,
            chunk.byteLength,
          );
          yield chunk;
        }
      })();
      const bytes = await collectBodyExact(measuredBody, head.bodyLength, MAX_PREVIEW_BYTES, {
        stallTimeoutMs: PREVIEW_STALL_TIMEOUT_MS,
        onStall: () => stream.reset(DataReset.Timeout),
        stallError: () => new ClientRequestTimeoutError("asset preview stalled"),
      });
      if (
        bytes.byteLength !== head.bodyLength ||
        metadata.sourceBytes !== bytes.byteLength
      ) {
        throw new DataPlaneError("the preview body does not match its exact metadata");
      }
      const finished = this.now();
      const elapsedMs = Math.max(0, finished - started);
      const transferMs = Math.max(0, finished - bodyStarted);
      return {
        metadata,
        bytes,
        transfer: {
          transport,
          responseBytes: bytes.byteLength,
          elapsedMs,
          firstByteMs:
            observed.firstByteAt === null
              ? null
              : Math.max(0, observed.firstByteAt - started),
          transferMs,
          averageBytesPerSecond:
            bytes.byteLength > 0 && transferMs > 0
              ? (bytes.byteLength * 1_000) / transferMs
              : null,
          chunkCount: observed.chunkCount,
          largestChunkBytes: observed.largestChunkBytes,
        },
      };
    })();
    try {
      const result = await operation;
      this.diagnostic("operation", {
        operation: "asset.preview",
        requestId,
        phase: "finish",
        outcome: "ok",
        transport,
        path,
        durationMs: Math.round(this.now() - started),
        responseBytes: result.bytes.byteLength,
        firstByteMs: result.transfer.firstByteMs,
        transferMs: Math.round(result.transfer.transferMs),
        averageBytesPerSecond:
          result.transfer.averageBytesPerSecond === null
            ? null
            : Math.round(result.transfer.averageBytesPerSecond),
        chunks: result.transfer.chunkCount,
        largestChunkBytes: result.transfer.largestChunkBytes,
      });
      return result;
    } catch (error) {
      this.diagnostic("operation", {
        operation: "asset.preview",
        requestId,
        phase: "finish",
        outcome: errorName(error),
        transport,
        path,
        durationMs: Math.round(this.now() - started),
      });
      throw error;
    }
  }

  /** Fetches only the daemon's bounded allowlisted ring, never its raw log. */
  async diagnostics(): Promise<SupportDiagnostics> {
    const reply = await this.call({ type: "diagnostics.snapshot" });
    if (reply?.type !== "diagnostics") {
      throw new Error(`unexpected reply to diagnostics.snapshot: ${reply?.type}`);
    }
    return reply.data;
  }

  /**
   * Opens the Qwen3-ASR speech stream. The community model runtime terminates
   * at a user device; this logical stream can travel over loopback, Fabric or
   * RTC without exposing runtime-specific transport to the UI.
   */
  openSpeechStream(): DataStream {
    return this.requireReadyEndpoint().open({
      version: DATA_PLANE_VERSION,
      method: "speech.transcribe",
      metadata: null,
    });
  }

  /**
   * Opens the daemon `shell.run` stream. argv is a list, never a command line;
   * the request body is the command's already-decided standard input.
   * The same method the CLI publishes as `genet shell`.
   */
  openShellStream(request: {
    workspaceId: string;
    argv: string[];
    cwd?: string | null;
    env?: Record<string, string>;
    timeoutMs?: number | null;
  }): DataStream {
    return this.requireReadyEndpoint().open({
      version: DATA_PLANE_VERSION,
      method: "shell.run",
      metadata: {
        workspaceId: request.workspaceId,
        argv: request.argv,
        cwd: request.cwd ?? null,
        env: request.env ?? {},
        timeoutMs: request.timeoutMs ?? null,
      },
    });
  }

  async subscribe(
    sessionId: string,
    handlers: Pick<Subscription, "onEvent" | "onResync">,
    options: { expandLastRound?: boolean } = {},
  ): Promise<{ snapshot: unknown; replayed: SequencedEvent[]; reset: boolean }> {
    const subscription: Subscription = {
      seq: 0,
      ...handlers,
      resync: null,
      needsResync: false,
      expandLastRound: options.expandLastRound ?? true,
    };
    this.subscriptions.set(sessionId, subscription);
    const reply = await this.call({
      type: "subscribe",
      payload: { sessionId, sinceSeq: 0, expandLastRound: subscription.expandLastRound },
    });
    if (reply?.type !== "subscribed") {
      this.subscriptions.delete(sessionId);
      throw new Error(`unexpected reply to subscribe: ${reply?.type}`);
    }
    for (const event of reply.data.replayed) subscription.seq = Math.max(subscription.seq, event.seq);
    return { snapshot: reply.data.snapshot, replayed: reply.data.replayed, reset: reply.data.reset };
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.subscriptions.delete(sessionId);
    await this.call({ type: "unsubscribe", payload: { sessionId } });
  }

  private dial(dial: ProtocolDial): void {
    this.activeChannelCredential = dial.channelCredential;
    this.activeLocalServerProof = dial.localServerProof;
    this.activeFabricRouteTicket = dial.fabricRouteTicket;
    this.connectionEpoch += 1;
    this.connectionAttemptId = diagnosticId("conn");
    this.carrier = dial.fabricRouteTicket ? "fabric" : "websocket";
    this.diagnostic("transport", {
      phase: "dial",
      transport: this.carrier,
      attempt: this.attempt,
    });
    if (dial.fabricRouteTicket) {
      this.dialFabric(dial);
      return;
    }
    let socket: WebSocketLike;
    try {
      const factory =
        this.options.socketFactory ?? ((url: string) => new WebSocket(url) as WebSocketLike);
      socket = factory(dial.url);
    } catch (error) {
      this.diagnostic("transport", {
        phase: "dial-failed",
        transport: "websocket",
        outcome: errorName(error),
      });
      this.scheduleReconnect();
      return;
    }
    if ("binaryType" in socket) socket.binaryType = "arraybuffer";
    const epoch = Symbol("data-plane-peer");
    this.socket = socket;
    this.epoch = epoch;
    this.endpoint = null;
    this.connectTimer = setTimeout(
      () => this.dropSocket(socket, epoch),
      this.options.connectTimeoutMs ?? 5_000,
    );
    socket.onopen = () => {
      if (!this.isCurrent(socket, epoch)) return;
      this.clearConnectTimer();
      void this.establish(socket, epoch).catch((error: unknown) => {
        if (!this.isCurrent(socket, epoch)) return;
        if (fatalConnectionError(error)) {
          this.failClosed(error.message);
        } else {
          this.report(error);
          this.dropSocket(socket, epoch);
        }
      });
    };
    socket.onclose = (event) => this.dropped(socket, epoch, asCloseReason(event));
    socket.onerror = () => this.dropSocket(socket, epoch);
  }

  private dialFabric(dial: ProtocolDial): void {
    const epoch = Symbol("fabric-data-peer");
    this.epoch = epoch;
    this.endpoint = null;
    this.dialingTransport = true;
    let credential: PeerCredential;
    try {
      credential = this.peerCredential();
    } catch (error) {
      this.dialingTransport = false;
      if (error instanceof PeerAuthenticationError) {
        this.failClosed(error.message);
      } else {
        this.report(error);
        this.droppedTransport(epoch);
      }
      return;
    }
    void openFabricDataLink({
      url: dial.url,
      routeTicket: dial.fabricRouteTicket!,
      credential,
      clientName: this.options.clientName,
      rtcSupported: this.rtcEnabled && rtcAvailableHere(),
      ...(this.options.socketFactory
        ? { socketFactory: this.options.socketFactory as unknown as (url: string) => import("../fabric").FabricSocketLike }
        : {}),
      onError: (error) => this.report(error),
    }).then(
      async (link) => {
        this.dialingTransport = false;
        if (!this.isCurrentEpoch(epoch)) {
          link.close();
          return;
        }
        this.fabricLink = link;
        this.endpoint = link.endpoint;
        link.endpoint.onClose((reason) => {
          if (this.fabricLink !== link || this.epoch !== epoch) return;
          this.report(reason);
          this.droppedTransport(epoch, this.lastClose);
        });
        try {
          await this.activateEndpoint(link.endpoint, epoch);
        } catch (error) {
          if (!this.isCurrentEpoch(epoch)) return;
          if (fatalConnectionError(error)) this.failClosed(error.message);
          else {
            this.report(error);
            link.close();
            this.droppedTransport(epoch);
          }
        }
      },
      (error: unknown) => {
        this.dialingTransport = false;
        if (!this.isCurrentEpoch(epoch)) return;
        this.report(error);
        this.droppedTransport(epoch);
      },
    );
  }

  private async establish(socket: WebSocketLike, epoch: symbol): Promise<void> {
    const credential = this.peerCredential();
    const prepared = await preparePeerHandshake(credential, {
      clientName: this.options.clientName,
      rtcSupported: this.rtcEnabled && rtcAvailableHere(),
    });
    const welcomeBytes = nextBinaryMessage(
      socket,
      this.options.helloTimeoutMs ?? 10_000,
    );
    socket.send(encoder.encode(JSON.stringify(prepared.hello)));
    const welcomeWire = await welcomeBytes;
    let welcome: PeerWelcome;
    try {
      welcome = JSON.parse(decoder.decode(welcomeWire)) as PeerWelcome;
    } catch (cause) {
      throw new PeerAuthenticationError("the daemon returned an invalid peer welcome", { cause });
    }
    let handshake;
    try {
      handshake = await prepared.complete(welcome);
    } catch (cause) {
      throw new PeerAuthenticationError("对面没有通过端到端身份验证，连接已中止", { cause });
    }
    if (!this.isCurrent(socket, epoch)) return;

    const carrier = new WebSocketRecordCarrier(socket);
    const endpoint = new DataEndpoint({
      role: "client",
      carrier,
      key: handshake.key,
      maxBulkStreamWindowBytes: handshake.maxBulkStreamWindowBytes,
      maxReceiveBytesPerStream: 64 * 1024 * 1024,
      onError: (error) => this.report(error),
    });
    this.endpoint = endpoint;
    endpoint.onClose((reason) => {
      if (this.epoch !== epoch) return;
      this.report(reason);
      this.dropped(socket, epoch, closeReasonFromUnknown(reason) ?? this.lastClose);
    });

    await this.activateEndpoint(endpoint, epoch);
  }

  private async activateEndpoint(endpoint: DataEndpoint, epoch: symbol): Promise<void> {
    // Pairing is a deliberately tiny bootstrap session. The daemon permits
    // exactly one encrypted device.claim RPC and reveals identity in that
    // reply, so opening the normal identity/events streams here would widen
    // the invitation's authority for no product benefit.
    if (this.options.inviteCredential) {
      this.failure = null;
      this.attempt = 0;
      this.setState("ready");
      this.flushQueue(endpoint, epoch);
      return;
    }

    this.businessCodec = protocolCodec(await this.protocolIdentityOn(endpoint));
    const identity = await this.rpc(endpoint, { type: "connection.identity" });
    if (identity?.type !== "hello") {
      throw new PeerAuthenticationError("the encrypted peer identity was not returned");
    }
    this.verifyIdentity(identity.data);
    if (!this.isCurrentEpoch(epoch) || this.endpoint !== endpoint) return;
    this.identity = identity.data;
    this.failure = null;
    // Completing E2EE proves identity, but not that the carrier is healthy.
    // A relay that kills every fresh channel must keep escalating backoff
    // instead of returning to a one-second reconnect loop after each Hello.
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.attempt = 0;
    }, STABLE_AFTER_MS);
    this.setState("ready");
    this.scheduleHeartbeat();
    this.flushQueue(endpoint, epoch);
    void this.runEvents(endpoint, epoch);
    void this.resubscribe();
    void this.startRtc(endpoint, epoch);
  }

  private peerCredential(): PeerCredential {
    const candidates: PeerCredential[] = [];
    if (this.options.credential) {
      candidates.push({ kind: "device", ...this.options.credential });
    }
    if (this.activeChannelCredential) {
      candidates.push({ kind: "hosted", ...this.activeChannelCredential });
    }
    if (this.activeLocalServerProof) {
      if (!validLocalServerProof(this.activeLocalServerProof, this.options.now?.() ?? Date.now())) {
        throw new PeerAuthenticationError("本地 daemon 的一次性连接凭证已失效");
      }
      candidates.push({ kind: "loopback", secret: this.activeLocalServerProof.proof });
    }
    if (this.options.inviteCredential) {
      candidates.push({ kind: "invite", ...this.options.inviteCredential });
    }
    if (candidates.length !== 1 || !validPeerCredential(candidates[0]!)) {
      throw new PeerAuthenticationError("this endpoint requires exactly one valid E2EE credential");
    }
    return candidates[0]!;
  }

  private verifyIdentity(identity: HelloResult): void {
    const expected = this.activeLocalServerProof;
    if (
      expected &&
      (identity.transport !== "loopback" ||
        identity.machineId !== expected.machineId ||
        identity.fingerprint !== expected.fingerprint)
    ) {
      throw new PeerAuthenticationError("本地端口返回了不匹配的 daemon 身份");
    }
  }

  private startCall(pending: PendingCall, endpoint: DataEndpoint, epoch: symbol): void {
    pending.started = true;
    if (pending.queueTimer !== null) clearTimeout(pending.queueTimer);
    pending.queueTimer = null;
    this.active.add(pending);
    const started = this.now();
    const transport = this.transportFor(endpoint);
    this.diagnostic("operation", {
      ...diagnosticContext(pending.request),
      operation: pending.operation,
      requestId: pending.id,
      phase: "start",
      transport,
      queueMs: Math.round(started - pending.queuedAt),
      requestBytes: pending.bytes,
    });
    void this.rpc(endpoint, pending.request, undefined, pending.id)
      .then((reply) => {
        this.diagnostic("operation", {
          ...diagnosticContext(pending.request),
          operation: pending.operation,
          requestId: pending.id,
          phase: "finish",
          outcome: "ok",
          transport,
          durationMs: Math.round(this.now() - started),
          requestBytes: pending.bytes,
        });
        pending.resolve(reply);
      }, (error: unknown) => {
        this.diagnostic("operation", {
          ...diagnosticContext(pending.request),
          operation: pending.operation,
          requestId: pending.id,
          phase: "finish",
          outcome: errorName(error),
          transport,
          durationMs: Math.round(this.now() - started),
          requestBytes: pending.bytes,
        });
        if (
          error instanceof ProtocolError_ ||
          error instanceof ClientRequestTimeoutError ||
          this.stopped
        ) {
          pending.reject(error);
        } else if (this.epoch !== epoch || endpoint.state === "closed") {
          pending.reject(new ConnectionOutcomeUnknownError(this.lastClose));
        } else {
          pending.reject(error);
        }
      })
      .finally(() => {
        this.active.delete(pending);
        this.release(pending);
      });
  }

  private async rpc(
    endpoint: DataEndpoint,
    request: Request,
    timeoutMs?: number,
    requestId = diagnosticId("internal"),
  ): Promise<Reply | undefined> {
    const budget = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    const body = this.businessCodec.encodeRequest(request);
    const stream = endpoint.open({
      version: DATA_PLANE_VERSION,
      method: "rpc",
      metadata: { diagnosticId: requestId, operation: request.type },
      bodyLength: body.byteLength,
      timeoutMs: budget,
    });
    const operation = (async () => {
      if (body.byteLength > 0) await stream.write(body);
      await stream.finish();
      const head = await stream.responseHead;
      if (head.error) throw new ProtocolError_(head.error);
      if (head.status !== 200) {
        throw new ProtocolError_({ code: "internal", message: `RPC failed (${head.status})` });
      }
      if (
        typeof head.bodyLength === "number" &&
        head.bodyLength > MAX_RPC_BODY_BYTES
      ) {
        stream.reset(DataReset.TooLarge);
        throw new ClientRequestTooLargeError();
      }
      const value = await collectBody(stream.body(), MAX_RPC_BODY_BYTES);
      return value.byteLength === 0 ? undefined : this.businessCodec.decodeReply(value);
    })();
    return withTimeout(
      operation,
      budget,
      "the daemon did not answer the request before its deadline",
      () => stream.reset(DataReset.Timeout),
    );
  }

  private async protocolIdentityOn(endpoint: DataEndpoint): Promise<number> {
    const stream = endpoint.open({
      version: DATA_PLANE_VERSION,
      method: "protocol.identity",
      metadata: null,
      bodyLength: 0,
      timeoutMs: 10_000,
    });
    const operation = (async () => {
      await stream.finish();
      const head = await stream.responseHead;
      if (head.status === 404) return 3;
      if (head.error) throw new ProtocolError_(head.error);
      if (head.status !== 200) {
        throw new PeerAuthenticationError(`protocol.identity failed (${head.status})`);
      }
      const value = await collectBody(stream.body(), 8 * 1024);
      const identity = JSON.parse(decoder.decode(value)) as { webProtocol?: unknown };
      if (
        typeof identity.webProtocol !== "number" ||
        !Number.isSafeInteger(identity.webProtocol) ||
        identity.webProtocol <= 0
      ) {
        throw new PeerAuthenticationError("daemon 返回了无效的业务协议版本");
      }
      return identity.webProtocol;
    })();
    return withTimeout(operation, 10_000, "protocol.identity 超时", () =>
      stream.reset(DataReset.Timeout),
    );
  }

  private async runEvents(endpoint: DataEndpoint, epoch: symbol): Promise<void> {
    try {
      const stream = endpoint.open({
        version: DATA_PLANE_VERSION,
        method: "events",
        metadata: null,
        bodyLength: 0,
      });
      await stream.finish();
      const head = await stream.responseHead;
      if (head.status !== 200 || asRecord(head.metadata).codec !== "json-u32be") {
        throw new DataPlaneError("the daemon refused the event stream");
      }
      await this.readEvents(stream, endpoint, epoch);
      if (this.endpoint === endpoint && this.epoch === epoch) {
        throw new DataPlaneError("the event stream ended unexpectedly");
      }
    } catch (error) {
      if (this.endpoint !== endpoint || this.epoch !== epoch || this.stopped) return;
      this.report(error);
      endpoint.close("event stream failed");
    }
  }

  private async readEvents(
    stream: DataStream,
    endpoint: DataEndpoint,
    epoch: symbol,
  ): Promise<void> {
    let buffered = new Uint8Array();
    for await (const chunk of stream.body()) {
      if (this.endpoint !== endpoint || this.epoch !== epoch) return;
      const joined = new Uint8Array(buffered.byteLength + chunk.byteLength);
      joined.set(buffered);
      joined.set(chunk, buffered.byteLength);
      buffered = joined;
      while (buffered.byteLength >= 4) {
        const length = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          buffered.byteLength,
        ).getUint32(0, false);
        if (length === 0 || length > MAX_EVENT_BYTES) {
          throw new DataPlaneError("invalid event message length");
        }
        if (buffered.byteLength < 4 + length) break;
        const frame = this.businessCodec.decodeServerFrame(buffered.slice(4, 4 + length));
        buffered = buffered.slice(4 + length);
        this.receiveEvent(frame);
      }
      if (buffered.byteLength > MAX_EVENT_BYTES + 4) {
        throw new DataPlaneError("event stream buffer is too large");
      }
    }
    if (buffered.byteLength !== 0) throw new DataPlaneError("truncated event message");
  }

  private receiveEvent(frame: ServerFrame): void {
    switch (frame.type) {
      case "event": {
        const sessionId = sessionOf(frame.topic);
        const subscription = this.subscriptions.get(sessionId);
        if (!subscription || frame.payload.seq <= subscription.seq) return;
        if (subscription.resync || frame.payload.seq !== subscription.seq + 1) {
          void this.fillGap(sessionId);
          return;
        }
        subscription.seq = frame.payload.seq;
        this.callListener(() => subscription.onEvent(frame.payload));
        return;
      }
      case "pty":
        for (const listener of this.ptyListeners) this.callListener(() => listener(frame.ptyId, frame.data));
        return;
      case "ptyClosed":
        for (const listener of this.ptyListeners) this.callListener(() => listener(frame.ptyId, null));
        return;
      case "notice":
        for (const listener of this.noticeListeners) this.callListener(() => listener(frame.level, frame.message));
        return;
      case "processes":
        for (const listener of this.processListeners)
          this.callListener(() => listener(frame.processes));
        return;
      case "updateDownload":
        for (const listener of this.downloadListeners) this.callListener(() => listener(frame.download));
        return;
      case "desync":
        void this.fillGap(frame.sessionId);
        return;
    }
  }

  private async resubscribe(): Promise<void> {
    for (const sessionId of [...this.subscriptions.keys()]) await this.fillGap(sessionId);
  }

  private async fillGap(sessionId: string): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;
    subscription.needsResync = true;
    if (subscription.resync) return subscription.resync;
    const repair = (async () => {
      while (this.subscriptions.get(sessionId) === subscription && subscription.needsResync) {
        subscription.needsResync = false;
        const reply = await this.call({
          type: "subscribe",
          payload: {
            sessionId,
            sinceSeq: subscription.seq,
            expandLastRound: subscription.expandLastRound,
          },
        }).catch(() => undefined);
        if (reply?.type !== "subscribed") return;
        for (const event of reply.data.replayed) subscription.seq = Math.max(subscription.seq, event.seq);
        this.callListener(() =>
          subscription.onResync(reply.data.snapshot, reply.data.replayed, reply.data.reset),
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

  private flushQueue(_endpoint: DataEndpoint, epoch: symbol): void {
    for (const pending of this.queue.splice(0)) {
      const endpoint = this.requestEndpoint();
      if (endpoint) this.startCall(pending, endpoint, epoch);
      else {
        this.release(pending);
        pending.reject(new DataPlaneError("the peer is not ready"));
      }
    }
  }

  private dropped(
    socket: WebSocketLike,
    epoch: symbol,
    close?: CloseReason,
  ): void {
    if (!this.isCurrent(socket, epoch) || this.stopped) return;
    this.droppedTransport(epoch, close);
  }

  private droppedTransport(epoch: symbol, close?: CloseReason): void {
    if (!this.isCurrentEpoch(epoch)) return;
    this.lastClose = close;
    // An invite is a one-use bootstrap opportunity, not a reconnectable
    // credential. Replaying the same URL after a timeout/close is both futile
    // and misleading, so pairing terminates on the first carrier loss.
    if (this.options.inviteCredential) {
      this.failure = {
        code: "unauthorized",
        message: "连接这台机器超时，或配对链接已过期",
      };
      this.close();
      return;
    }
    this.clearConnectTimer();
    this.clearStableTimer();
    this.clearHeartbeat();
    this.endpoint = null;
    this.socket = null;
    this.fabricLink = null;
    this.epoch = null;
    this.closeRtc();
    if (this.rtcEnabled) this.setRtcState("standby");
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private dropSocket(socket: WebSocketLike, epoch: symbol): void {
    if (!this.isCurrent(socket, epoch)) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    this.dropped(socket, epoch);
  }

  private redial(): void {
    const redial = this.options.redial;
    if (!redial) return;
    this.redialing = true;
    const generation = ++this.redialGeneration;
    const controller = new AbortController();
    this.redialAbort = controller;
    this.redialTimer = setTimeout(() => controller.abort(), this.options.redialTimeoutMs ?? 10_000);
    void redial(controller.signal).then(
      (fresh) => {
        if (this.stopped || generation !== this.redialGeneration) return;
        this.finishRedial();
        const dial = typeof fresh === "string" ? { url: fresh } : fresh;
        if (!validDial(dial)) {
          this.failClosed("the control plane returned an invalid peer route");
          return;
        }
        if (
          (this.activeChannelCredential && !dial.channelCredential) ||
          (this.activeLocalServerProof && !dial.localServerProof) ||
          (this.activeFabricRouteTicket && !dial.fabricRouteTicket)
        ) {
          this.failClosed("the refreshed route omitted its one-use E2EE credential");
          return;
        }
        this.dial(dial);
      },
      () => {
        if (this.stopped || generation !== this.redialGeneration) return;
        this.finishRedial();
        this.scheduleReconnect();
      },
    );
  }

  private finishRedial(): void {
    if (this.redialTimer !== null) clearTimeout(this.redialTimer);
    this.redialTimer = null;
    this.redialAbort = null;
    this.redialing = false;
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.socket ||
      this.fabricLink ||
      this.dialingTransport ||
      this.retryTimer !== null ||
      this.redialing
    ) return;
    this.setState("reconnecting");
    const backoff =
      this.options.backoffMs ?? ((attempt: number) => Math.min(1000 * 2 ** attempt, 15_000));
    const base = backoff(this.attempt++);
    // A shared relay restart should not bring every browser back in lockstep.
    const delay = this.options.backoffMs
      ? base
      : Math.round(base * (0.75 + Math.random() * 0.5));
    this.diagnostic("connection", {
      state: "reconnecting",
      phase: "retry-scheduled",
      delayMs: delay,
      attempt: Math.max(0, this.attempt - 1),
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    const interval = this.options.heartbeatMs ?? HEARTBEAT_MS;
    if (interval <= 0) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.heartbeat();
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * One cheap authenticated round trip. A suspended-then-resumed page keeps
   * its JavaScript state but loses the carrier underneath it, often without a
   * close frame; this is the only way that loss is noticed while the page is
   * otherwise idle.
   */
  private async heartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return;
    if (this.stopped || this.state !== "ready") return;
    const epoch = this.epoch;
    const endpoint = this.requestEndpoint();
    if (!epoch || !endpoint) return;
    this.heartbeatInFlight = true;
    try {
      await this.rpc(
        endpoint,
        { type: "connection.identity" },
        this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
      );
      if (this.epoch === epoch && this.state === "ready" && !this.stopped) {
        this.scheduleHeartbeat();
      }
    } catch (error) {
      if (this.epoch !== epoch || this.stopped) return;
      this.report(error);
      this.dropCurrentTransport(epoch, { reason: "heartbeat 超时，连接已不可达" });
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private dropCurrentTransport(epoch: symbol, close?: CloseReason): void {
    const socket = this.socket;
    if (socket && this.epoch === epoch) {
      this.dropSocket(socket, epoch);
      return;
    }
    const link = this.fabricLink;
    if (link && this.epoch === epoch) {
      link.close();
      this.droppedTransport(epoch, close);
    }
  }

  /**
   * Browsers tell us directly when the page comes back from suspension or the
   * radio comes back: the right response is an immediate liveness check or
   * redial, not whatever remained of a backoff schedule computed before sleep.
   */
  private attachLifecycle(): void {
    if (this.lifecycleCleanup) return;
    const cleanups: Array<() => void> = [];
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      const onVisible = () => {
        if (document.visibilityState === "visible") this.revive();
      };
      document.addEventListener("visibilitychange", onVisible);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const onOnline = () => this.revive();
      window.addEventListener("online", onOnline);
      cleanups.push(() => window.removeEventListener("online", onOnline));
    }
    this.lifecycleCleanup = () => {
      for (const cleanup of cleanups) cleanup();
    };
  }

  private detachLifecycle(): void {
    this.lifecycleCleanup?.();
    this.lifecycleCleanup = null;
  }

  private revive(): void {
    if (this.stopped) return;
    if (this.state === "reconnecting") {
      this.clearRetryTimer();
      this.connect();
      return;
    }
    if (this.state === "ready" && !this.heartbeatInFlight) {
      this.clearHeartbeat();
      void this.heartbeat();
    }
  }

  private requireReadyEndpoint(): DataEndpoint {
    const endpoint = this.state === "ready" ? this.requestEndpoint() : null;
    if (!endpoint) {
      throw new DataPlaneError("the peer is not ready");
    }
    return endpoint;
  }

  private requestEndpoint(): DataEndpoint | null {
    if (this.rtcLink?.endpoint.state === "open") return this.rtcLink.endpoint;
    return this.endpoint?.state === "open" ? this.endpoint : null;
  }

  private async startRtc(base: DataEndpoint, epoch: symbol): Promise<void> {
    if (!this.rtcEnabled) {
      this.setRtcState("disabled");
      return;
    }
    if (!this.identity?.rtcSupported || !rtcAvailableHere()) {
      this.setRtcState("unavailable");
      return;
    }
    // A loopback WebSocket is already direct, private and lower overhead. RTC
    // is an upgrade for network carriers, not a replacement for localhost.
    if (this.identity.transport === "loopback") {
      this.setRtcState("standby");
      return;
    }
    const generation = ++this.rtcGeneration;
    const requestId = diagnosticId("rtc");
    const started = this.now();
    this.closeRtc(false);
    this.setRtcState("connecting");
    this.diagnostic("operation", {
      operation: "rtc.negotiate",
      requestId,
      phase: "start",
      transport: this.carrier,
    });
    try {
      const link = await (this.options.rtcFactory ?? openRtcDataLink)(
        base,
        requestId,
        (detail) => this.diagnostic("rtc", detail),
      );
      if (
        generation !== this.rtcGeneration ||
        this.stopped ||
        this.endpoint !== base ||
        this.epoch !== epoch
      ) {
        link.close();
        return;
      }
      const identity = await this.rpc(link.endpoint, { type: "connection.identity" });
      if (
        identity?.type !== "hello" ||
        identity.data.machineId !== this.identity?.machineId ||
        identity.data.fingerprint !== this.identity.fingerprint
      ) {
        link.close();
        throw new PeerAuthenticationError("RTC 直连返回了不匹配的 daemon 身份");
      }
      if (generation !== this.rtcGeneration || this.endpoint !== base || this.epoch !== epoch) {
        link.close();
        return;
      }
      this.rtcLink = link;
      link.endpoint.onClose((reason) => {
        if (this.rtcLink !== link) return;
        this.rtcLink = null;
        this.report(reason);
        if (this.rtcEnabled && this.state === "ready") this.setRtcState("failed");
      });
      this.setRtcState("connected");
      this.diagnostic("operation", {
        operation: "rtc.negotiate",
        requestId,
        phase: "finish",
        outcome: "ok",
        transport: "rtc",
        durationMs: Math.round(this.now() - started),
      });
    } catch (error) {
      if (generation !== this.rtcGeneration || this.stopped || this.endpoint !== base) return;
      this.report(error);
      this.setRtcState("failed");
      this.diagnostic("operation", {
        operation: "rtc.negotiate",
        requestId,
        phase: "finish",
        outcome: errorName(error),
        transport: this.carrier,
        durationMs: Math.round(this.now() - started),
      });
    }
  }

  private closeRtc(increment = true): void {
    if (increment) this.rtcGeneration += 1;
    const link = this.rtcLink;
    this.rtcLink = null;
    link?.close();
  }

  private release(pending: PendingCall): void {
    if (pending.bytes === 0) return;
    this.pendingBytes = Math.max(0, this.pendingBytes - pending.bytes);
    pending.bytes = 0;
  }

  private rejectQueued(error: Error): void {
    for (const pending of this.queue.splice(0)) {
      if (pending.queueTimer !== null) clearTimeout(pending.queueTimer);
      this.release(pending);
      pending.reject(error);
    }
  }

  private failClosed(message: string): void {
    this.failure = { code: "unauthorized", message };
    this.close();
  }

  private isCurrent(socket: WebSocketLike, epoch: symbol): boolean {
    return !this.stopped && this.socket === socket && this.epoch === epoch;
  }

  private isCurrentEpoch(epoch: symbol): boolean {
    return !this.stopped && this.epoch === epoch;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.diagnostic("connection", {
      state,
      closeCode: this.lastClose?.code ?? null,
      closeReason: this.lastClose?.reason ?? null,
    });
    for (const listener of this.stateListeners) this.callListener(() => listener(state));
  }

  private setRtcState(state: RtcState): void {
    if (this.rtcState_ === state) return;
    this.rtcState_ = state;
    this.diagnostic("rtc", { state });
    for (const listener of this.rtcListeners) this.callListener(() => listener(state));
  }

  private callListener(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    this.diagnostic("error", {
      name: errorName(error),
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      this.options.onError?.(error);
    } catch {
      // Observability never owns transport state.
    }
  }

  private diagnostic(kind: ClientDiagnosticKind, detail: ClientDiagnosticDetail): void {
    try {
      this.options.onDiagnostic?.({
        at: new Date(this.now()).toISOString(),
        kind,
        detail: {
          connectionEpoch: this.connectionEpoch,
          connectionAttemptId: this.connectionAttemptId,
          carrier: this.carrier,
          ...detail,
        },
      });
    } catch {
      // Diagnostics are one-way evidence and never own client state.
    }
  }

  private transportFor(endpoint: DataEndpoint): "websocket" | "fabric" | "rtc" {
    if (this.rtcLink?.endpoint === endpoint) return "rtc";
    return this.carrier ?? "websocket";
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearRetryTimer();
    this.clearStableTimer();
    if (this.redialTimer !== null) clearTimeout(this.redialTimer);
    this.redialTimer = null;
  }
}

/** Self-hosted pairing links carry their reusable opaque route beside the
 * endpoint admission so a freshly paired browser needs no server directory.
 * Hosted routes remain explicit, short-lived fields returned by Control. */
function embeddedFabricRoute(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.pathname !== "/fabric/v2") return undefined;
    const route = url.searchParams.get("route");
    return route && route.length <= 4096 ? route : undefined;
  } catch {
    return undefined;
  }
}

class PeerAuthenticationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "PeerAuthenticationError";
  }
}

function fatalConnectionError(
  error: unknown,
): error is PeerAuthenticationError | UnsupportedBusinessProtocolError {
  return (
    error instanceof PeerAuthenticationError ||
    error instanceof UnsupportedBusinessProtocolError
  );
}

function nextBinaryMessage(socket: WebSocketLike, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ClientRequestTimeoutError("peer handshake timed out"))),
      timeoutMs,
    );
    socket.onmessage = (event) => {
      void binaryMessage(event.data).then(
        (bytes) =>
          finish(() => {
            if (bytes.byteLength > 8 * 1024) reject(new Error("peer welcome is too large"));
            else resolve(bytes);
          }),
        (error: unknown) => finish(() => reject(error)),
      );
    };
    socket.onerror = (error) => finish(() => reject(error));
    socket.onclose = (event) => finish(() => reject(new Error(`peer closed during handshake${describeClose(asCloseReason(event))}`)));
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  expired?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      expired?.();
      reject(new ClientRequestTimeoutError(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function diagnosticId(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function errorName(error: unknown): string {
  if (error instanceof ProtocolError_) return `protocol.${error.detail.code}`;
  if (error instanceof AssetPreviewError_) return `preview.${error.detail}`;
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "Error";
}

/** Only stable opaque ids and workspace-relative paths leave request payloads. */
function diagnosticContext(request: Request): ClientDiagnosticDetail {
  switch (request.type) {
    case "file.tree":
    case "file.write":
    case "git.diff":
      return {
        workspaceId: request.payload.workspaceId,
        path: request.payload.path ?? null,
      };
    case "git.status":
    case "git.commit":
    case "workspace.rename":
    case "workspace.remove":
    case "session.create":
      return { workspaceId: request.payload.workspaceId };
    case "pty.open":
      // The setup wizard's shell belongs to no workspace.
      return { workspaceId: request.payload.workspaceId ?? null };
    default:
      return {};
  }
}

function validLocalServerProof(value: LocalServerProof, now: number): boolean {
  return (
    /^[0-9a-f]{64}$/.test(value.proof) &&
    /^[0-9a-f]{64}$/.test(value.challenge) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    value.machineId.length > 0 &&
    value.machineId.length <= 256 &&
    value.fingerprint.length > 0 &&
    value.fingerprint.length <= 256 &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt * 1000 > now
  );
}

function validPeerCredential(value: PeerCredential): boolean {
  if (!value.secret || value.secret.length > 512) return false;
  switch (value.kind) {
    case "loopback":
      return /^[0-9a-f]{64}$/.test(value.secret);
    case "device":
      return value.deviceId.length > 0 && value.deviceId.length <= 256;
    case "hosted":
      return value.capabilityId.length > 0 && value.capabilityId.length <= 256;
    case "invite":
      return /^inv_[0-9a-f]{32}$/.test(value.inviteId);
  }
}

function validDial(value: unknown): value is ProtocolDial {
  if (!value || typeof value !== "object") return false;
  const dial = value as ProtocolDial;
  return typeof dial.url === "string" && dial.url.length > 0 && dial.url.length <= 8192;
}

function asCloseReason(event: unknown): CloseReason | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { code?: unknown; reason?: unknown };
  return {
    ...(typeof value.code === "number" ? { code: value.code } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 200) } : {}),
  };
}

function closeReasonFromUnknown(value: unknown, depth = 0): CloseReason | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const record = value as { code?: unknown; reason?: unknown; cause?: unknown };
  if (typeof record.code === "number" || typeof record.reason === "string") {
    return asCloseReason(record);
  }
  return closeReasonFromUnknown(record.cause, depth + 1);
}

function describeClose(close?: CloseReason): string {
  const detail = [close?.code, close?.reason?.trim()].filter(Boolean).join(" ");
  return detail ? `（${detail}）` : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function previewError(value: unknown): AssetPreviewError {
  return value === "notFound" ||
    value === "forbidden" ||
    value === "unsupported" ||
    value === "tooLarge" ||
    value === "sourceChanged"
    ? value
    : "sourceChanged";
}

function previewMetadata(value: unknown): AssetPreviewMetadata {
  const metadata = asRecord(value);
  if (
    (metadata.kind !== "image" &&
      metadata.kind !== "markdown" &&
      metadata.kind !== "text" &&
      metadata.kind !== "html" &&
      metadata.kind !== "video" &&
      metadata.kind !== "wasm" &&
      metadata.kind !== "binary") ||
    typeof metadata.mediaType !== "string" ||
    typeof metadata.sourceBytes !== "number" ||
    !Number.isSafeInteger(metadata.sourceBytes) ||
    metadata.sourceBytes < 0 ||
    metadata.sourceBytes > MAX_PREVIEW_BYTES ||
    typeof metadata.version !== "string" ||
    !/^[0-9a-f]{32}$/.test(metadata.version) ||
    !previewMediaMatches(metadata.kind, metadata.mediaType)
  ) {
    throw new DataPlaneError("the daemon returned invalid preview metadata");
  }
  return metadata as unknown as AssetPreviewMetadata;
}

function previewMediaMatches(kind: unknown, mediaType: unknown): boolean {
  if (typeof mediaType !== "string") return false;
  switch (kind) {
    case "image":
      return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType);
    case "markdown":
      return mediaType === "text/markdown";
    case "text":
      return mediaType === "text/plain";
    case "html":
      return mediaType === "text/html";
    case "video":
      return mediaType === "video/mp4" || mediaType === "video/webm";
    case "wasm":
      return mediaType === "application/wasm";
    case "binary":
      return mediaType === "application/octet-stream";
    default:
      return false;
  }
}

function previewErrorMessage(error: AssetPreviewError, sourceBytes?: number): string {
  switch (error) {
    case "notFound":
      return "找不到这个文件";
    case "forbidden":
      return "这个路径不在当前工作区内";
    case "unsupported":
      return "这种文件暂不支持预览";
    case "tooLarge":
      return `文件超过 64 MiB，暂不支持预览${sourceBytes ? `（${sourceBytes} bytes）` : ""}`;
    case "sourceChanged":
      return "读取时文件发生了变化，请重试";
  }
}

function rtcAvailableHere(): boolean {
  return typeof globalThis.RTCPeerConnection === "function";
}

import { RecordInbox, type RecordReader } from "./record-inbox";
import type {
  PeerWelcome,
  RtcNegotiationRequest,
  RtcNegotiationResponse,
} from "@genehub/proto";

import type { ResumePolicy } from "./resume";
import { DataEndpoint, type RecordCarrier } from "./endpoint";
import { collectBody } from "./exchange";
import { DATA_PLANE_VERSION, DataReset, MAX_DATA_FRAME_BYTES } from "./frame";
import { preparePeerHandshake } from "./handshake";
import { binaryMessage } from "./websocket";

const SIGNAL_LIMIT = 64 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
/**
 * Phone peers need server-reflexive candidates in this non-trickle offer.
 * Host candidates appear immediately; STUN usually finishes in 1–2s. Cap the
 * wait so a hung STUN server cannot stall the upgrade for 20s.
 */
export const GATHER_WAIT_MS = 12_000;
export const ICE_SERVERS: RTCIceServer[] = [];
const BUFFERED_HIGH = 256 * 1024;
const BUFFERED_LOW = 64 * 1024;

export type RtcPhase = "gather" | "signal" | "channel" | "handshake";

/**
 * Coarse RTC lifecycle facts for the feedback recorder. Enums and candidate
 * type counts only — a candidate string itself carries IP addresses and never
 * leaves this function.
 */
export type RtcDiagnostic = Record<string, string | number | boolean | null>;

/** Structured upgrade failure so settings and diagnostics can show a phase, not one sentence. */
export class RtcUpgradeError extends Error {
  readonly phase: RtcPhase;
  readonly detail: RtcDiagnostic;

  constructor(phase: RtcPhase, cause: unknown, detail: RtcDiagnostic = {}) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause: cause instanceof Error ? cause : undefined });
    this.name = "RtcUpgradeError";
    this.phase = phase;
    this.detail = detail;
  }
}

export interface RtcDataLink {
  endpoint: DataEndpoint;
  peer: RTCPeerConnection;
  close(): void;
}

export interface RtcLinkOptions {
  endpoint?: DataEndpoint;
  policy?: ResumePolicy;
  /** Finish ICE and the E2EE handshake, but wait to activate an existing owner. */
  attachWhen?: Promise<void>;
}

/** Negotiates one reliable ordered DataChannel through the base E2EE link. */
export async function openRtcDataLink(
  base: DataEndpoint,
  diagnosticId?: string,
  onDiagnostic?: (detail: RtcDiagnostic) => void,
  options: RtcLinkOptions = {},
): Promise<RtcDataLink> {
  if (typeof RTCPeerConnection !== "function") {
    throw new Error("this browser does not support WebRTC");
  }
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  const timing: Record<string, number> = {};
  const finishStage = (name: string) => {
    const now = performance.now();
    timing[`${name}Ms`] = Math.round(now - stageStartedAt);
    stageStartedAt = now;
  };
  let iceServers: RTCIceServer[] = [];
  const configStream=base.open({version:DATA_PLANE_VERSION,method:"rtc.config",metadata:null,bodyLength:0,timeoutMs:5000});
  try {
    await configStream.finish();
    const head=await configStream.responseHead;
    if(head.status===200&&!head.error){
      const config=JSON.parse(new TextDecoder().decode(await collectBody(configStream.body(),16*1024)));
      if(Array.isArray(config.iceServers))iceServers=config.iceServers.slice(0,8).map((s:{urls?:unknown})=>({urls:Array.isArray(s.urls)?s.urls.filter((u:unknown)=>typeof u==="string"&&u.startsWith("stun:")&&u.length<=256):[]}));
    }
  } catch { /* Old daemons have no rtc.config: host candidates remain usable. */ }
  finally {configStream.reset(DataReset.Cancelled);}
  finishStage("config");
  const peer = new RTCPeerConnection({ iceServers });
  if (onDiagnostic) watchPeer(peer, diagnosticId ?? null, onDiagnostic);
  const channel = peer.createDataChannel("genehub-data-v4", { ordered: true });
  channel.binaryType = "arraybuffer";
  // Created before signaling so ICE can progress while the offer is in
  // flight. If negotiation fails before either promise is awaited, the
  // catch below silences the late rejection from the teardown close.
  const opened = dataChannelOpened(channel, peer);
  let welcome: Promise<Uint8Array> | undefined;
  let phase: RtcPhase = "gather";
  const fail = (cause: unknown): never => {
    throw new RtcUpgradeError(phase, cause, snapshotPeer(peer, diagnosticId));
  };
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await iceGathered(peer, GATHER_WAIT_MS);
    finishStage("gather");
    const offerSdp = peer.localDescription?.sdp;
    if (!offerSdp) {
      throw new RtcUpgradeError(
        phase,
        "the browser did not create an RTC offer",
        snapshotPeer(peer, diagnosticId),
      );
    }
    onDiagnostic?.({
      diagnosticId: diagnosticId ?? null,
      phase,
      iceGatheringState: peer.iceGatheringState,
      ...snapshotPeer(peer, diagnosticId),
    });

    phase = "signal";
    const request: RtcNegotiationRequest = { sdp: offerSdp };
    const body = new TextEncoder().encode(JSON.stringify(request));
    if (body.byteLength > SIGNAL_LIMIT) {
      fail("the browser's RTC offer exceeds the signaling limit");
    }
    const stream = base.open({
      version: DATA_PLANE_VERSION,
      method: "rtc.negotiate",
      metadata: diagnosticId ? { diagnosticId } : null,
      bodyLength: body.byteLength,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const answer = await withDeadline(
      (async () => {
        await stream.write(body);
        await stream.finish();
        const response = await stream.responseHead;
        if (response.error) throw new Error(response.error.message);
        if (response.status !== 200) {
          throw new Error(`RTC negotiation failed (${response.status})`);
        }
        const serverTiming = response.metadata && typeof response.metadata === "object" &&
          !Array.isArray(response.metadata) ? response.metadata.rtcTiming : null;
        if (serverTiming && typeof serverTiming === "object" && !Array.isArray(serverTiming)) {
          const bounded = (value: unknown) => typeof value === "number" &&
            Number.isInteger(value) && value >= 0 && value <= 120_000 ? value : null;
          onDiagnostic?.({
            diagnosticId: diagnosticId ?? null,
            milestone: "serverTiming",
            serverConfigMs: bounded(serverTiming.configMs),
            serverGatherMs: bounded(serverTiming.gatherMs),
            serverAnswerMs: bounded(serverTiming.answerMs),
          });
        }
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await collectBody(stream.body(), SIGNAL_LIMIT),
          ),
        ) as RtcNegotiationResponse;
      })(),
      CONNECT_TIMEOUT_MS,
      "RTC signaling timed out",
      () => stream.reset(DataReset.Timeout),
    ).catch(fail);
    finishStage("signal");
    if (
      !answer.sdp ||
      !answer.capabilityId ||
      !answer.secret ||
      answer.sdp.length > SIGNAL_LIMIT
    ) {
      fail("the daemon returned an invalid RTC answer");
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp }).catch(fail);
    onDiagnostic?.({
      diagnosticId: diagnosticId ?? null,
      milestone: "remoteCandidates",
      ...remoteCandidateCounts(peer),
    });
    phase = "channel";
    await withDeadline(opened, CONNECT_TIMEOUT_MS, "RTC DataChannel did not open").catch(fail);
    finishStage("channel");

    phase = "handshake";
    const prepared = await preparePeerHandshake({
      kind: "hosted",
      capabilityId: answer.capabilityId,
      secret: answer.secret,
    });
    welcome = nextDataChannelMessage(channel);
    channel.send(new TextEncoder().encode(JSON.stringify(prepared.hello)));
    const welcomeValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await withDeadline(welcome, 10_000, "RTC E2EE handshake timed out").catch(fail),
      ),
    ) as PeerWelcome;
    const handshake = await prepared.complete(welcomeValue);
    finishStage("handshake");
    onDiagnostic?.({
      diagnosticId: diagnosticId ?? null,
      milestone: "transportReady",
      ...timing,
      totalMs: Math.round(performance.now() - startedAt),
    });
    const carrier = new RtcRecordCarrier(peer, channel);
    const endpoint = options.endpoint ?? new DataEndpoint({
      path: "rtc",
      policy: options.policy ?? "direct-only",
      role: "client",
      carrier,
      key: handshake.key,
      maxBulkStreamWindowBytes: handshake.maxBulkStreamWindowBytes,
      maxReceiveBytesPerStream: 64 * 1024 * 1024,
    });
    if (options.endpoint) {
      await options.attachWhen;
      if (channel.readyState !== "open") fail("RTC DataChannel closed before activation");
      await endpoint.attach(carrier, handshake.key, "rtc");
    }
    else await endpoint.ready();
    return {
      endpoint,
      peer,
      close() {
        if (options.endpoint) { channel.close(); peer.close(); }
        else endpoint.close("RTC provider closed");
      },
    };
  } catch (error) {
    // Closing an unopened channel rejects `opened`/`welcome`; nobody is
    // still awaiting them here, so swallow to avoid unhandled rejections.
    opened.catch(() => {});
    welcome?.catch(() => {});
    channel.close();
    peer.close();
    const wrapped =
      error instanceof RtcUpgradeError
        ? error
        : new RtcUpgradeError(phase, error, snapshotPeer(peer, diagnosticId));
    onDiagnostic?.({
      diagnosticId: diagnosticId ?? null,
      phase: wrapped.phase,
      failed: true,
      message: wrapped.message,
      ...wrapped.detail,
    });
    throw wrapped;
  }
}

class RtcRecordCarrier implements RecordCarrier {
  private recordHandler: RecordReader | null = null;
  private readonly inbox = new RecordInbox(record => this.recordHandler?.(record), error => this.fail(error));
  private readonly closeHandlers = new Set<(reason?: unknown) => void>();
  private closed = false;

  constructor(
    private readonly peer: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
  ) {
    channel.bufferedAmountLowThreshold = BUFFERED_LOW;
    channel.onmessage = (event) => this.inbox.push(event.data);
    channel.onerror = (event) => this.fail(event);
    channel.onclose = () => this.fail(new Error("RTC DataChannel closed"));
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        this.fail(new Error(`RTC peer ${peer.connectionState}`));
      }
    };
  }

  async send(record: Uint8Array): Promise<void> {
    if (this.closed || this.channel.readyState !== "open") {
      throw new Error("RTC carrier is closed");
    }
    if (record.byteLength > MAX_DATA_FRAME_BYTES) {
      throw new RangeError("RTC record exceeds 16 KiB");
    }
    if (this.channel.bufferedAmount > BUFFERED_HIGH) await this.waitForBuffer();
    // DOM's send overload deliberately requires an ArrayBuffer-backed view;
    // callers may hand us a view whose type still permits SharedArrayBuffer.
    this.channel.send(record.slice());
  }

  onRecord(handler: RecordReader): () => void {
    if (this.recordHandler) throw new Error("RTC carrier already has a reader");
    this.recordHandler = handler;
    return () => {
      if (this.recordHandler === handler) this.recordHandler = null;
    };
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox.close();
    this.channel.close();
    this.peer.close();
  }

  private waitForBuffer(): Promise<void> {
    return withDeadline(
      new Promise<void>((resolve, reject) => {
        const low = () => {
          cleanup();
          resolve();
        };
        const closed = () => {
          cleanup();
          reject(new Error("RTC DataChannel closed while backpressured"));
        };
        const cleanup = () => {
          this.channel.removeEventListener("bufferedamountlow", low);
          this.channel.removeEventListener("close", closed);
        };
        this.channel.addEventListener("bufferedamountlow", low, { once: true });
        this.channel.addEventListener("close", closed, { once: true });
      }),
      10_000,
      "RTC DataChannel stayed backpressured",
    );
  }

  private fail(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox.close();
    this.channel.close(); this.peer.close();
    for (const handler of this.closeHandlers) handler(reason);
  }
}

/**
 * Reports the peer's state machine to the feedback recorder. Listeners are
 * added, never assigned — `dataChannelOpened` and the carrier each own the
 * `onconnectionstatechange` property at different times, and diagnostics must
 * not clobber either.
 *
 * @internal Exported for tests; the client wires this through `openRtcDataLink`.
 */
export function watchPeer(
  peer: RTCPeerConnection,
  diagnosticId: string | null,
  onDiagnostic: (detail: RtcDiagnostic) => void,
): void {
  const emit = (detail: RtcDiagnostic) =>
    onDiagnostic({ diagnosticId, ...detail });
  peer.addEventListener("iceconnectionstatechange", () =>
    emit({ iceConnectionState: peer.iceConnectionState }),
  );
  peer.addEventListener("connectionstatechange", () =>
    emit({ connectionState: peer.connectionState }),
  );
  peer.addEventListener("signalingstatechange", () =>
    emit({ signalingState: peer.signalingState }),
  );
  // Candidate strings carry IP addresses; only their types are counted, and
  // the tally goes out once gathering finishes.
  const candidates = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  peer.addEventListener("icecandidate", (event) => {
    const type = / typ (host|srflx|prflx|relay)( |$)/.exec(
      event.candidate?.candidate ?? "",
    )?.[1] as keyof typeof candidates | undefined;
    if (type) candidates[type] += 1;
  });
  peer.addEventListener("icegatheringstatechange", () => {
    emit({ iceGatheringState: peer.iceGatheringState });
    if (peer.iceGatheringState === "complete") {
      emit({
        candidateHost: candidates.host,
        candidateSrflx: candidates.srflx,
        candidatePrflx: candidates.prflx,
        candidateRelay: candidates.relay,
      });
    }
  });
}

function dataChannelOpened(  channel: RTCDataChannel,
  peer: RTCPeerConnection,
): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.onopen = () => resolve();
    channel.onerror = (event) => reject(event);
    channel.onclose = () => reject(new Error("RTC DataChannel closed before opening"));
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        reject(new Error(`RTC peer ${peer.connectionState}`));
      }
    };
  });
}

function nextDataChannelMessage(channel: RTCDataChannel): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    channel.onmessage = (event) => void binaryMessage(event.data).then(resolve, reject);
    channel.onerror = (event) => reject(event);
    channel.onclose = () => reject(new Error("RTC DataChannel closed during E2EE setup"));
  });
}

/**
 * Send the offer after gathering completes so STUN srflx is in the SDP, or
 * after `waitMs` if STUN never answers. Do not send on host-only after a few
 * seconds — a phone on cellular cannot use those LAN addresses.
 *
 * @internal Exported for tests.
 */
export function iceGathered(peer: RTCPeerConnection, waitMs: number): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      peer.removeEventListener("icegatheringstatechange", changed);
      clearTimeout(timer);
      resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, waitMs);
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

function snapshotPeer(peer: RTCPeerConnection, diagnosticId?: string): RtcDiagnostic {
  return {
    diagnosticId: diagnosticId ?? null,
    iceGatheringState: peer.iceGatheringState,
    iceConnectionState: peer.iceConnectionState,
    connectionState: peer.connectionState,
    signalingState: peer.signalingState,
    ...remoteCandidateCounts(peer),
  };
}

/** Only candidate types are retained. SDP addresses and ports must not enter diagnostics. */
function remoteCandidateCounts(peer: RTCPeerConnection): RtcDiagnostic {
  const counts = { remoteCandidateHost: 0, remoteCandidateSrflx: 0,
    remoteCandidatePrflx: 0, remoteCandidateRelay: 0 };
  const sdp = peer.remoteDescription?.sdp;
  if (!sdp) return counts;
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const type = / typ (host|srflx|prflx|relay)(?: |$)/.exec(line)?.[1];
    if (type === "host") counts.remoteCandidateHost++;
    else if (type === "srflx") counts.remoteCandidateSrflx++;
    else if (type === "prflx") counts.remoteCandidatePrflx++;
    else if (type === "relay") counts.remoteCandidateRelay++;
  }
  return counts;
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  expired?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      expired?.();
      reject(new Error(message));
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

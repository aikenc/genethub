import type {
  PeerWelcome,
  RtcNegotiationRequest,
  RtcNegotiationResponse,
} from "@genehub/proto";

import { DataEndpoint, type RecordCarrier } from "./endpoint";
import { collectBody } from "./exchange";
import { DATA_PLANE_VERSION, DataReset, MAX_DATA_FRAME_BYTES } from "./frame";
import { preparePeerHandshake } from "./handshake";
import { binaryMessage } from "./websocket";

const SIGNAL_LIMIT = 64 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const BUFFERED_HIGH = 256 * 1024;
const BUFFERED_LOW = 64 * 1024;

export interface RtcDataLink {
  endpoint: DataEndpoint;
  peer: RTCPeerConnection;
  close(): void;
}

/** Negotiates one reliable ordered DataChannel through the base E2EE link. */
export async function openRtcDataLink(
  base: DataEndpoint,
  diagnosticId?: string,
): Promise<RtcDataLink> {
  if (typeof RTCPeerConnection !== "function") {
    throw new Error("this browser does not support WebRTC");
  }
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
  });
  const channel = peer.createDataChannel("genehub-data-v3", { ordered: true });
  channel.binaryType = "arraybuffer";
  try {
    const opened = dataChannelOpened(channel, peer);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await iceGathered(peer, CONNECT_TIMEOUT_MS);
    const local = peer.localDescription;
    if (!local?.sdp) throw new Error("the browser did not create an RTC offer");

    const request: RtcNegotiationRequest = { sdp: local.sdp };
    const body = new TextEncoder().encode(JSON.stringify(request));
    if (body.byteLength > SIGNAL_LIMIT) {
      throw new Error("the browser's RTC offer exceeds the signaling limit");
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
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await collectBody(stream.body(), SIGNAL_LIMIT),
          ),
        ) as RtcNegotiationResponse;
      })(),
      CONNECT_TIMEOUT_MS,
      "RTC signaling timed out",
      () => stream.reset(DataReset.Timeout),
    );
    if (
      !answer.sdp ||
      !answer.capabilityId ||
      !answer.secret ||
      answer.sdp.length > SIGNAL_LIMIT
    ) {
      throw new Error("the daemon returned an invalid RTC answer");
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await withDeadline(opened, CONNECT_TIMEOUT_MS, "RTC DataChannel did not open");

    const prepared = await preparePeerHandshake({
      kind: "hosted",
      capabilityId: answer.capabilityId,
      secret: answer.secret,
    });
    const welcome = nextDataChannelMessage(channel);
    channel.send(new TextEncoder().encode(JSON.stringify(prepared.hello)));
    const welcomeValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await withDeadline(welcome, 10_000, "RTC E2EE handshake timed out"),
      ),
    ) as PeerWelcome;
    const key = await prepared.complete(welcomeValue);
    const carrier = new RtcRecordCarrier(peer, channel);
    const endpoint = new DataEndpoint({
      role: "client",
      carrier,
      key,
      maxReceiveBytesPerStream: 4 * 1024 * 1024,
    });
    return {
      endpoint,
      peer,
      close() {
        endpoint.close("RTC provider closed");
        channel.close();
        peer.close();
      },
    };
  } catch (error) {
    channel.close();
    peer.close();
    throw error;
  }
}

class RtcRecordCarrier implements RecordCarrier {
  private recordHandler: ((record: Uint8Array) => void) | null = null;
  private readonly closeHandlers = new Set<(reason?: unknown) => void>();
  private receiveTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly peer: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
  ) {
    channel.bufferedAmountLowThreshold = BUFFERED_LOW;
    channel.onmessage = (event) => {
      this.receiveTail = this.receiveTail
        .then(async () => {
          const record = await binaryMessage(event.data);
          if (record.byteLength > MAX_DATA_FRAME_BYTES) {
            throw new Error("RTC record exceeds 16 KiB");
          }
          this.recordHandler?.(record);
        })
        .catch((error: unknown) => this.fail(error));
    };
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

  onRecord(handler: (record: Uint8Array) => void): () => void {
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
    for (const handler of this.closeHandlers) handler(reason);
  }
}

function dataChannelOpened(
  channel: RTCDataChannel,
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

function iceGathered(peer: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return withDeadline(
    new Promise<void>((resolve) => {
      const changed = () => {
        if (peer.iceGatheringState !== "complete") return;
        peer.removeEventListener("icegatheringstatechange", changed);
        resolve();
      };
      peer.addEventListener("icegatheringstatechange", changed);
    }),
    timeoutMs,
    "RTC ICE gathering timed out",
  );
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

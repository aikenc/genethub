import type { PeerWelcome } from "@genehub/proto";

import {
  FabricEndpoint,
  FabricReset,
  type FabricSocketLike,
  type FabricStream,
} from "../fabric";
import { DataEndpoint, type RecordCarrier } from "./endpoint";
import { MAX_DATA_FRAME_BYTES } from "./frame";
import { preparePeerHandshake, type PeerCredential } from "./handshake";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface FabricDataLink {
  endpoint: DataEndpoint;
  fabric: FabricEndpoint;
  close(): void;
}

export async function openFabricDataLink(options: {
  url: string;
  routeTicket: string;
  credential: PeerCredential;
  clientName?: string;
  rtcSupported: boolean;
  socketFactory?: (url: string) => FabricSocketLike;
  onError?: (error: unknown) => void;
}): Promise<FabricDataLink> {
  const fabric = new FabricEndpoint({
    url: options.url,
    reconnect: false,
    maxFrameBytes: MAX_DATA_FRAME_BYTES + 28,
    maxBufferedBytes: 256 * 1024,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  try {
    await fabric.connect();
    const prepared = await preparePeerHandshake(options.credential, {
      clientName: options.clientName,
      rtcSupported: options.rtcSupported,
    });
    const hello = encoder.encode(JSON.stringify(prepared.hello));
    const stream = fabric.open(options.routeTicket, hello);
    const welcomeBytes = await deadline(stream.accepted, 10_000, "Fabric peer handshake timed out");
    if (welcomeBytes.byteLength === 0 || welcomeBytes.byteLength > 8 * 1024) {
      throw new Error("the daemon returned an invalid Fabric peer welcome");
    }
    const welcome = JSON.parse(decoder.decode(welcomeBytes)) as PeerWelcome;
    const key = await prepared.complete(welcome);
    const carrier = new FabricRecordCarrier(fabric, stream);
    const endpoint = new DataEndpoint({
      role: "client",
      carrier,
      key,
      maxReceiveBytesPerStream: 64 * 1024 * 1024,
      ...(options.onError ? { onError: options.onError } : {}),
    });
    return {
      endpoint,
      fabric,
      close() {
        endpoint.close("Fabric peer link closed");
        fabric.close();
      },
    };
  } catch (error) {
    fabric.close();
    throw error;
  }
}

class FabricRecordCarrier implements RecordCarrier {
  private recordHandler: ((record: Uint8Array) => void) | null = null;
  private readonly closeHandlers = new Set<(reason?: unknown) => void>();
  private closed = false;

  constructor(
    private readonly fabric: FabricEndpoint,
    private readonly stream: FabricStream,
  ) {
    stream.onData((record) => {
      if (record.byteLength > MAX_DATA_FRAME_BYTES) {
        this.fail(new Error("Fabric peer record exceeds 16 KiB"));
        return;
      }
      this.recordHandler?.(record);
    });
    stream.onRemoteFinish(() => this.fail(new Error("Fabric peer finished the carrier")));
    void stream.done.then((result) => {
      if (result.type !== "finished") this.fail(result);
    });
  }

  send(record: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Fabric peer carrier is closed"));
    if (record.byteLength > MAX_DATA_FRAME_BYTES) {
      return Promise.reject(new RangeError("Fabric peer record exceeds 16 KiB"));
    }
    return this.stream.sendAsync(record);
  }

  onRecord(handler: (record: Uint8Array) => void): () => void {
    if (this.recordHandler) throw new Error("Fabric peer carrier already has a reader");
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
    if (this.stream.phase !== "closed") {
      try {
        this.stream.reset(FabricReset.EndpointClosed);
      } catch {
        // The physical endpoint may already have closed the operation.
      }
    }
    this.fabric.close();
  }

  private fail(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler(reason);
  }
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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

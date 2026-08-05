import { randomBytes } from "node:crypto";

export const FABRIC_VERSION = 2;
export const FABRIC_STREAM_ID_BYTES = 16;
export const FABRIC_HEADER_BYTES = 1 + 1 + 2 + FABRIC_STREAM_ID_BYTES + 8;
export const ZERO_STREAM_ID = "0".repeat(FABRIC_STREAM_ID_BYTES * 2);
export const MAX_ROUTE_TICKET_BYTES = 4096;
/**
 * OPEN metadata is retained while Control authorizes a route, so it needs a
 * much smaller limit than an active DATA frame. This keeps the global pending
 * OPEN budget from becoming a multi-gigabyte memory reservation.
 */
export const MAX_OPERATION_METADATA_BYTES = 16 * 1024;
/** Default receive window advertised independently by each stream endpoint. */
export const FABRIC_INITIAL_STREAM_CREDIT = 256 * 1024;
/** Hard protocol cap for an advertised per-stream receive window. */
export const FABRIC_MAX_STREAM_CREDIT = 4 * 1024 * 1024;

export const FabricKind = {
  Open: 1,
  Incoming: 2,
  Accept: 3,
  Data: 4,
  WindowUpdate: 5,
  Fin: 6,
  Reset: 7,
  Ping: 8,
  Pong: 9,
} as const;

export type FabricKind = (typeof FabricKind)[keyof typeof FabricKind];

export const FabricReset = {
  UnknownStream: 1,
  DuplicateStream: 2,
  MalformedOpen: 3,
  RouteDenied: 4,
  TargetOffline: 5,
  ProtocolViolation: 6,
  EndpointClosed: 7,
  Revoked: 8,
  Expired: 9,
  TooSlow: 10,
} as const;

export type FabricReset = (typeof FabricReset)[keyof typeof FabricReset];

export interface FabricFrame {
  kind: FabricKind;
  streamId: string;
  value: bigint;
  payload: Buffer;
  flags?: number;
}

export interface FabricOpenPayload {
  routeTicket: string;
  opaqueHello: Buffer;
}

function isKind(value: number): value is FabricKind {
  return Object.values(FabricKind).includes(value as FabricKind);
}

function streamIdBuffer(streamId: string): Buffer | null {
  if (!/^[0-9a-f]{32}$/i.test(streamId)) return null;
  const bytes = Buffer.from(streamId, "hex");
  return bytes.length === FABRIC_STREAM_ID_BYTES ? bytes : null;
}

function streamIdAllowed(kind: FabricKind, streamId: string): boolean {
  const control = kind === FabricKind.Ping || kind === FabricKind.Pong;
  return control ? streamId === ZERO_STREAM_ID : streamId !== ZERO_STREAM_ID;
}

export function newFabricStreamId(): string {
  for (;;) {
    const streamId = randomBytes(FABRIC_STREAM_ID_BYTES).toString("hex");
    if (streamId !== ZERO_STREAM_ID) return streamId;
  }
}

export function encodeFabricFrame(frame: FabricFrame): Buffer {
  const flags = frame.flags ?? 0;
  const streamId = streamIdBuffer(frame.streamId);
  if (!isKind(frame.kind)) throw new Error("unknown Fabric frame kind");
  if (flags !== 0) throw new Error("Fabric v2 flags must be zero");
  if (!streamId) throw new Error("Fabric stream id must be 16 bytes of hex");
  if (!streamIdAllowed(frame.kind, frame.streamId)) {
    throw new Error("Fabric control and operation stream ids cannot be mixed");
  }
  if (frame.value < 0n || frame.value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Fabric frame value must fit in uint64");
  }

  const out = Buffer.allocUnsafe(FABRIC_HEADER_BYTES + frame.payload.length);
  out[0] = FABRIC_VERSION;
  out[1] = frame.kind;
  out.writeUInt16BE(flags, 2);
  streamId.copy(out, 4);
  out.writeBigUInt64BE(frame.value, 4 + FABRIC_STREAM_ID_BYTES);
  frame.payload.copy(out, FABRIC_HEADER_BYTES);
  return out;
}

export function decodeFabricFrame(data: Buffer): FabricFrame | null {
  if (data.length < FABRIC_HEADER_BYTES) return null;
  if (data[0] !== FABRIC_VERSION) return null;

  const kind = data[1]!;
  if (!isKind(kind)) return null;
  const flags = data.readUInt16BE(2);
  if (flags !== 0) return null;

  const streamId = data.subarray(4, 4 + FABRIC_STREAM_ID_BYTES).toString("hex");
  if (!streamIdAllowed(kind, streamId)) return null;

  return {
    kind,
    flags,
    streamId,
    value: data.readBigUInt64BE(4 + FABRIC_STREAM_ID_BYTES),
    payload: data.subarray(FABRIC_HEADER_BYTES),
  };
}

export function encodeFabricOpenPayload(routeTicket: string, opaqueHello: Buffer): Buffer {
  const ticket = Buffer.from(routeTicket, "utf8");
  if (ticket.length === 0 || ticket.length > MAX_ROUTE_TICKET_BYTES) {
    throw new Error(`Fabric route ticket must be 1..${MAX_ROUTE_TICKET_BYTES} bytes`);
  }
  if (opaqueHello.length > MAX_OPERATION_METADATA_BYTES) {
    throw new Error(
      `Fabric operation metadata must be at most ${MAX_OPERATION_METADATA_BYTES} bytes`,
    );
  }
  const out = Buffer.allocUnsafe(2 + ticket.length + opaqueHello.length);
  out.writeUInt16BE(ticket.length, 0);
  ticket.copy(out, 2);
  opaqueHello.copy(out, 2 + ticket.length);
  return out;
}

export function decodeFabricOpenPayload(payload: Buffer): FabricOpenPayload | null {
  if (payload.length < 2) return null;
  const ticketLength = payload.readUInt16BE(0);
  if (
    ticketLength === 0 ||
    ticketLength > MAX_ROUTE_TICKET_BYTES ||
    2 + ticketLength > payload.length ||
    payload.length - 2 - ticketLength > MAX_OPERATION_METADATA_BYTES
  ) {
    return null;
  }
  try {
    const ticketBytes = payload.subarray(2, 2 + ticketLength);
    const routeTicket = new TextDecoder("utf-8", { fatal: true }).decode(ticketBytes);
    if (Buffer.byteLength(routeTicket, "utf8") !== ticketLength) return null;
    return {
      routeTicket,
      opaqueHello: payload.subarray(2 + ticketLength),
    };
  } catch {
    return null;
  }
}

/**
 * Browser-safe Fabric v2 framing.
 *
 * The relay has a Node implementation of the same wire format. This copy uses
 * only Uint8Array/DataView/TextEncoder so the workbench does not pull Buffer or
 * another Node shim into a browser bundle. Payload bytes stay opaque here.
 */

export const FABRIC_VERSION = 2;
export const FABRIC_STREAM_ID_BYTES = 16;
export const FABRIC_HEADER_BYTES = 1 + 1 + 2 + FABRIC_STREAM_ID_BYTES + 8;
export const FABRIC_ZERO_STREAM_ID = "0".repeat(FABRIC_STREAM_ID_BYTES * 2);
export const FABRIC_MAX_ROUTE_TICKET_BYTES = 4096;

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
  payload: Uint8Array;
  flags?: number;
}

export interface FabricOpenPayload {
  routeTicket: string;
  opaqueHello: Uint8Array;
}

/** Injectable so deterministic tests never replace the platform crypto API. */
export type FabricRandomFill = (bytes: Uint8Array) => void;

const encoder = new TextEncoder();

function isKind(value: number): value is FabricKind {
  return Object.values(FabricKind).includes(value as FabricKind);
}

function streamIdBytes(streamId: string): Uint8Array | null {
  if (!/^[0-9a-f]{32}$/i.test(streamId)) return null;
  const bytes = new Uint8Array(FABRIC_STREAM_ID_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = streamId.slice(index * 2, index * 2 + 2);
    const byte = Number.parseInt(pair, 16);
    if (!Number.isInteger(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function streamIdAllowed(kind: FabricKind, streamId: string): boolean {
  const control = kind === FabricKind.Ping || kind === FabricKind.Pong;
  return control ? streamId === FABRIC_ZERO_STREAM_ID : streamId !== FABRIC_ZERO_STREAM_ID;
}

function platformRandom(bytes: Uint8Array): void {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("secure random bytes are unavailable for a Fabric stream id");
  }
  crypto.getRandomValues(bytes);
}

/** A fresh, non-zero, connection-local operation id. */
export function newFabricStreamId(fill: FabricRandomFill = platformRandom): string {
  // A healthy CSPRNG will leave on the first pass. The bound prevents a broken
  // injected implementation from turning connection setup into an infinite
  // loop while still making an all-zero result impossible to use.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = new Uint8Array(FABRIC_STREAM_ID_BYTES);
    fill(bytes);
    const streamId = hex(bytes);
    if (streamId !== FABRIC_ZERO_STREAM_ID) return streamId;
  }
  throw new Error("secure random bytes repeatedly produced a zero Fabric stream id");
}

export function encodeFabricFrame(frame: FabricFrame): Uint8Array {
  const flags = frame.flags ?? 0;
  const streamId = streamIdBytes(frame.streamId);
  if (!isKind(frame.kind)) throw new Error("unknown Fabric frame kind");
  if (flags !== 0) throw new Error("Fabric v2 flags must be zero");
  if (!streamId) throw new Error("Fabric stream id must be 16 bytes of hex");
  if (!streamIdAllowed(frame.kind, frame.streamId.toLowerCase())) {
    throw new Error("Fabric control and operation stream ids cannot be mixed");
  }
  if (frame.value < 0n || frame.value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Fabric frame value must fit in uint64");
  }

  const out = new Uint8Array(FABRIC_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = FABRIC_VERSION;
  out[1] = frame.kind;
  view.setUint16(2, flags, false);
  out.set(streamId, 4);
  view.setBigUint64(4 + FABRIC_STREAM_ID_BYTES, frame.value, false);
  out.set(frame.payload, FABRIC_HEADER_BYTES);
  return out;
}

export function decodeFabricFrame(data: Uint8Array): FabricFrame | null {
  if (data.byteLength < FABRIC_HEADER_BYTES) return null;
  if (data[0] !== FABRIC_VERSION) return null;

  const kind = data[1];
  if (kind === undefined || !isKind(kind)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = view.getUint16(2, false);
  if (flags !== 0) return null;

  const streamId = hex(data.subarray(4, 4 + FABRIC_STREAM_ID_BYTES));
  if (!streamIdAllowed(kind, streamId)) return null;

  return {
    kind,
    flags,
    streamId,
    value: view.getBigUint64(4 + FABRIC_STREAM_ID_BYTES, false),
    // A copy keeps a caller from mutating storage shared with the WebSocket
    // event or with another view of the same incoming frame.
    payload: data.slice(FABRIC_HEADER_BYTES),
  };
}

export function encodeFabricOpenPayload(
  routeTicket: string,
  opaqueHello: Uint8Array,
): Uint8Array {
  const ticket = encoder.encode(routeTicket);
  if (ticket.byteLength === 0 || ticket.byteLength > FABRIC_MAX_ROUTE_TICKET_BYTES) {
    throw new Error(
      `Fabric route ticket must be 1..${FABRIC_MAX_ROUTE_TICKET_BYTES} bytes`,
    );
  }
  const out = new Uint8Array(2 + ticket.byteLength + opaqueHello.byteLength);
  new DataView(out.buffer).setUint16(0, ticket.byteLength, false);
  out.set(ticket, 2);
  out.set(opaqueHello, 2 + ticket.byteLength);
  return out;
}

export function decodeFabricOpenPayload(payload: Uint8Array): FabricOpenPayload | null {
  if (payload.byteLength < 2) return null;
  const ticketLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint16(0, false);
  if (
    ticketLength === 0 ||
    ticketLength > FABRIC_MAX_ROUTE_TICKET_BYTES ||
    2 + ticketLength > payload.byteLength
  ) {
    return null;
  }
  try {
    const ticketBytes = payload.subarray(2, 2 + ticketLength);
    const routeTicket = new TextDecoder("utf-8", { fatal: true }).decode(ticketBytes);
    if (encoder.encode(routeTicket).byteLength !== ticketLength) return null;
    return {
      routeTicket,
      opaqueHello: payload.slice(2 + ticketLength),
    };
  } catch {
    return null;
  }
}

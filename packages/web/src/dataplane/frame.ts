/** Business-neutral logical-stream frames carried inside one E2EE peer link. */

export const DATA_PLANE_VERSION = 3;
export const DATA_FRAME_HEADER_BYTES = 16;
export const SECURE_RECORD_HEADER_BYTES = 12;
export const SECURE_RECORD_TAG_BYTES = 16;
export const MAX_DATA_FRAME_BYTES = 16 * 1024;
export const MAX_DATA_PAYLOAD_BYTES =
  MAX_DATA_FRAME_BYTES -
  SECURE_RECORD_HEADER_BYTES -
  SECURE_RECORD_TAG_BYTES -
  DATA_FRAME_HEADER_BYTES;
export const INITIAL_STREAM_WINDOW_BYTES = 256 * 1024;
export const MAX_FINITE_EXCHANGE_BODY_BYTES = 4 * 1024 * 1024;

export const DataKind = {
  Open: 1,
  Head: 2,
  Data: 3,
  WindowUpdate: 4,
  Fin: 5,
  Reset: 6,
  Ping: 7,
  Pong: 8,
} as const;

export type DataKindValue = (typeof DataKind)[keyof typeof DataKind];

export const DataReset = {
  Cancelled: 1,
  ProtocolViolation: 2,
  Refused: 3,
  TooLarge: 4,
  Timeout: 5,
  EndpointClosed: 6,
} as const;

export interface DataFrame {
  kind: DataKindValue;
  streamId: number;
  value: number;
  payload: Uint8Array;
}

const VALID_KINDS = new Set<number>(Object.values(DataKind));

export function encodeDataFrame(frame: DataFrame): Uint8Array {
  validateUint32(frame.streamId, "stream id");
  validateUint32(frame.value, "frame value");
  if (!VALID_KINDS.has(frame.kind)) throw new TypeError("unknown data frame kind");
  if (frame.payload.byteLength > MAX_DATA_PAYLOAD_BYTES) {
    throw new RangeError("data frame payload exceeds the 16 KiB wire limit");
  }
  if ((frame.kind === DataKind.Ping || frame.kind === DataKind.Pong) !== (frame.streamId === 0)) {
    throw new TypeError("only endpoint control frames use stream zero");
  }
  const wire = new Uint8Array(DATA_FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(wire.buffer);
  view.setUint8(0, DATA_PLANE_VERSION);
  view.setUint8(1, frame.kind);
  view.setUint16(2, 0, false);
  view.setUint32(4, frame.streamId, false);
  view.setUint32(8, frame.value, false);
  view.setUint32(12, frame.payload.byteLength, false);
  wire.set(frame.payload, DATA_FRAME_HEADER_BYTES);
  return wire;
}

export function decodeDataFrame(wire: Uint8Array): DataFrame | null {
  if (wire.byteLength < DATA_FRAME_HEADER_BYTES) return null;
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const version = view.getUint8(0);
  const kind = view.getUint8(1);
  const flags = view.getUint16(2, false);
  const streamId = view.getUint32(4, false);
  const value = view.getUint32(8, false);
  const length = view.getUint32(12, false);
  if (
    version !== DATA_PLANE_VERSION ||
    flags !== 0 ||
    !VALID_KINDS.has(kind) ||
    length > MAX_DATA_PAYLOAD_BYTES ||
    DATA_FRAME_HEADER_BYTES + length !== wire.byteLength ||
    ((kind === DataKind.Ping || kind === DataKind.Pong) !== (streamId === 0))
  ) {
    return null;
  }
  return {
    kind: kind as DataKindValue,
    streamId,
    value,
    payload: wire.slice(DATA_FRAME_HEADER_BYTES),
  };
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a uint32`);
  }
}

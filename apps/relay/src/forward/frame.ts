import { randomBytes } from "node:crypto";

/**
 * Framing for the machine uplink.
 *
 * One machine has one outbound socket, and several clients may be attached to
 * it at once, so the uplink is multiplexed. The header is fixed width and
 * carries only routing: the forwarder reads seventeen bytes and copies the rest
 * untouched. That is what keeps "the forwarding layer never parses the payload"
 * (`docs/architecture.md` §6.3) a mechanical property rather than a promise.
 *
 *   byte 0        kind
 *   bytes 1..17   channel id, 16 raw bytes
 *   bytes 17..    payload, opaque
 */
export const CHANNEL_ID_BYTES = 16;
export const HEADER_BYTES = 1 + CHANNEL_ID_BYTES;

export const Kind = {
  /** A client attached. No payload. */
  Open: 1,
  /** Payload was a text frame on the client side. */
  Text: 2,
  /** Payload was a binary frame on the client side. */
  Binary: 3,
  /** A client detached, or the machine dropped the channel. Payload is a reason. */
  Close: 4,
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

export interface Frame {
  kind: Kind;
  channel: string;
  payload: Buffer;
}

export function newChannelId(): string {
  return randomBytes(CHANNEL_ID_BYTES).toString("hex");
}

export function encode(kind: Kind, channel: string, payload?: Buffer | string): Buffer {
  const id = Buffer.from(channel, "hex");
  if (id.length !== CHANNEL_ID_BYTES) {
    throw new Error(`channel id must be ${CHANNEL_ID_BYTES} bytes, got ${id.length}`);
  }
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload as never);
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame[0] = kind;
  id.copy(frame, 1);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

/** Returns null for anything malformed; callers close the connection. */
export function decode(data: Buffer): Frame | null {
  if (data.length < HEADER_BYTES) return null;
  const kind = data[0] as Kind;
  if (kind !== Kind.Open && kind !== Kind.Text && kind !== Kind.Binary && kind !== Kind.Close) {
    return null;
  }
  return {
    kind,
    channel: data.subarray(1, HEADER_BYTES).toString("hex"),
    // `subarray` shares memory with the incoming buffer, which is exactly what
    // we want: the payload is copied once, by the socket, and never again.
    payload: data.subarray(HEADER_BYTES),
  };
}

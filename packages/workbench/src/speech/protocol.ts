/** GeneHub speech application framing carried inside one data-plane stream. */

export const SPEECH_FRAME_VERSION = 2;
export const SPEECH_FRAME_HEADER_BYTES = 8;
export const MAX_SPEECH_FRAME_PAYLOAD_BYTES = 256 * 1024;

export const SpeechFrameKind = {
  Start: 0x01,
  Audio: 0x02,
  ContextUpdate: 0x03,
  Finish: 0x04,
  Cancel: 0x05,
  Ready: 0x80,
  ContextApplied: 0x81,
  Completed: 0x82,
  Failed: 0x83,
  Partial: 0x84,
} as const;

export type SpeechFrameKindValue = (typeof SpeechFrameKind)[keyof typeof SpeechFrameKind];

const VALID_KINDS = new Set<number>(Object.values(SpeechFrameKind));
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SpeechFrame {
  kind: SpeechFrameKindValue;
  payload: Uint8Array;
}

export class SpeechProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechProtocolError";
  }
}

export function encodeSpeechFrame(
  kind: SpeechFrameKindValue,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (!VALID_KINDS.has(kind)) throw new SpeechProtocolError("unknown speech frame kind");
  if (payload.byteLength > MAX_SPEECH_FRAME_PAYLOAD_BYTES) {
    throw new SpeechProtocolError("speech frame payload is too large");
  }
  const wire = new Uint8Array(SPEECH_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(wire.buffer);
  wire[0] = SPEECH_FRAME_VERSION;
  wire[1] = kind;
  view.setUint16(2, 0, false);
  view.setUint32(4, payload.byteLength, false);
  wire.set(payload, SPEECH_FRAME_HEADER_BYTES);
  return wire;
}

export function encodeSpeechJson(kind: SpeechFrameKindValue, value: unknown): Uint8Array {
  return encodeSpeechFrame(kind, encoder.encode(JSON.stringify(value)));
}

export function decodeSpeechJson<T>(frame: SpeechFrame): T {
  try {
    return JSON.parse(decoder.decode(frame.payload)) as T;
  } catch (error) {
    throw new SpeechProtocolError(
      `speech frame contains invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/** Audio payload prefix: index:u32be, captureStartMs:u32be, durationMs:u16be. */
export function encodeSpeechAudio(
  index: number,
  captureStartMs: number,
  durationMs: number,
  pcm: Uint8Array,
): Uint8Array {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 0xffff_ffff ||
    !Number.isSafeInteger(captureStartMs) ||
    captureStartMs < 0 ||
    captureStartMs > 0xffff_ffff ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > 0xffff
  ) {
    throw new SpeechProtocolError("speech audio metadata is out of range");
  }
  const payload = new Uint8Array(10 + pcm.byteLength);
  const view = new DataView(payload.buffer);
  view.setUint32(0, index, false);
  view.setUint32(4, captureStartMs, false);
  view.setUint16(8, durationMs, false);
  payload.set(pcm, 10);
  return encodeSpeechFrame(SpeechFrameKind.Audio, payload);
}

/** Incremental decoder: data-plane chunks need not align with speech frames. */
export class SpeechFrameDecoder {
  private buffered = new Uint8Array();

  push(bytes: Uint8Array): SpeechFrame[] {
    if (bytes.byteLength > 0) {
      const joined = new Uint8Array(this.buffered.byteLength + bytes.byteLength);
      joined.set(this.buffered);
      joined.set(bytes, this.buffered.byteLength);
      this.buffered = joined;
    }

    const frames: SpeechFrame[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= SPEECH_FRAME_HEADER_BYTES) {
      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + offset,
        this.buffered.byteLength - offset,
      );
      const version = view.getUint8(0);
      const rawKind = view.getUint8(1);
      const flags = view.getUint16(2, false);
      const length = view.getUint32(4, false);
      if (version !== SPEECH_FRAME_VERSION) {
        throw new SpeechProtocolError(`unsupported speech frame version ${version}`);
      }
      if (!VALID_KINDS.has(rawKind)) {
        throw new SpeechProtocolError(`unknown speech frame kind ${rawKind}`);
      }
      if (flags !== 0) throw new SpeechProtocolError("unsupported speech frame flags");
      if (length > MAX_SPEECH_FRAME_PAYLOAD_BYTES) {
        throw new SpeechProtocolError("speech frame payload is too large");
      }
      const total = SPEECH_FRAME_HEADER_BYTES + length;
      if (this.buffered.byteLength - offset < total) break;
      frames.push({
        kind: rawKind as SpeechFrameKindValue,
        payload: this.buffered.slice(
          offset + SPEECH_FRAME_HEADER_BYTES,
          offset + total,
        ),
      });
      offset += total;
    }
    if (offset > 0) this.buffered = this.buffered.slice(offset);
    if (this.buffered.byteLength > SPEECH_FRAME_HEADER_BYTES + MAX_SPEECH_FRAME_PAYLOAD_BYTES) {
      throw new SpeechProtocolError("speech frame buffer is too large");
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) {
      throw new SpeechProtocolError("speech stream ended with a truncated frame");
    }
  }
}

import type { ChannelDirection, ChannelSessionKey } from "../devices/proof";
import {
  DATA_PLANE_VERSION,
  MAX_DATA_FRAME_BYTES,
  SECURE_RECORD_HEADER_BYTES,
} from "./frame";

const MAGIC_G = 0x47;
const MAGIC_H = 0x48;
const encoder = new TextEncoder();

/** Encrypts exactly one bounded logical-stream frame. */
export async function sealDataRecord(
  key: ChannelSessionKey,
  direction: ChannelDirection,
  sequence: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  safeSequence(sequence);
  if (plaintext.byteLength + SECURE_RECORD_HEADER_BYTES + 16 > MAX_DATA_FRAME_BYTES) {
    throw new RangeError("secure data record exceeds the 16 KiB wire limit");
  }
  const header = recordHeader(sequence);
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      {
        name: "AES-GCM",
        iv: asBuffer(recordNonce(direction, sequence)),
        additionalData: asBuffer(recordAssociatedData(key.context, direction, sequence)),
        tagLength: 128,
      },
      key.encryptionKey,
      asBuffer(plaintext),
    ),
  );
  const wire = new Uint8Array(header.byteLength + ciphertext.byteLength);
  wire.set(header);
  wire.set(ciphertext, header.byteLength);
  return wire;
}

export async function openDataRecord(
  key: ChannelSessionKey,
  direction: ChannelDirection,
  expectedSequence: number,
  wire: Uint8Array,
): Promise<Uint8Array> {
  safeSequence(expectedSequence);
  if (
    wire.byteLength < SECURE_RECORD_HEADER_BYTES + 16 ||
    wire.byteLength > MAX_DATA_FRAME_BYTES
  ) {
    throw new Error("invalid secure data record length");
  }
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  if (
    view.getUint8(0) !== MAGIC_G ||
    view.getUint8(1) !== MAGIC_H ||
    view.getUint8(2) !== DATA_PLANE_VERSION ||
    view.getUint8(3) !== 0 ||
    view.getBigUint64(4, false) !== BigInt(expectedSequence)
  ) {
    throw new Error("secure data record sequence or version mismatch");
  }
  const plaintext = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(recordNonce(direction, expectedSequence)),
      additionalData: asBuffer(
        recordAssociatedData(key.context, direction, expectedSequence),
      ),
      tagLength: 128,
    },
    key.encryptionKey,
    asBuffer(wire.subarray(SECURE_RECORD_HEADER_BYTES)),
  );
  return new Uint8Array(plaintext);
}

function recordHeader(sequence: number): Uint8Array {
  const header = new Uint8Array(SECURE_RECORD_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint8(0, MAGIC_G);
  view.setUint8(1, MAGIC_H);
  view.setUint8(2, DATA_PLANE_VERSION);
  view.setUint8(3, 0);
  view.setBigUint64(4, BigInt(sequence), false);
  return header;
}

function recordNonce(direction: ChannelDirection, sequence: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(encoder.encode(direction === "client-to-daemon" ? "G3CD" : "G3DC"));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence), false);
  return nonce;
}

function recordAssociatedData(
  context: string,
  direction: ChannelDirection,
  sequence: number,
): Uint8Array {
  return fields("genehub-data-record-v1", [
    u32(DATA_PLANE_VERSION),
    encoder.encode(context),
    encoder.encode(direction),
    u64(sequence),
  ]);
}

function fields(domain: string, values: Uint8Array[]): Uint8Array {
  const all = [encoder.encode(domain), ...values];
  const output = new Uint8Array(
    all.reduce((length, value) => length + 8 + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of all) {
    output.set(u64(value.byteLength), offset);
    offset += 8;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: number): Uint8Array {
  safeSequence(value);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function safeSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("secure data sequence must be a positive safe integer");
  }
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function subtle(): SubtleCrypto {
  const available = globalThis.crypto?.subtle;
  if (!available) throw new Error("the data plane requires Web Crypto on a secure origin");
  return available;
}

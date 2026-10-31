/** Mutual handshake and protocol-v3 record key derivation. */

/**
 * A challenge is only good once, so it has to be unguessable rather than
 * merely unique — a counter would let anyone who saw one proof predict the
 * next challenge and prepare for it.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  webCrypto().getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ChannelDirection = "client-to-daemon" | "daemon-to-client";

export interface ChannelSessionKey {
  readonly context: string;
  readonly encryptionKey: CryptoKey;
}

const encoder = new TextEncoder();

export function deviceChannelContext(deviceId: string): string {
  return `device:${deviceId}`;
}

export function hostedChannelContext(capabilityId: string): string {
  return `hosted:${capabilityId}`;
}

export async function channelClientProof(
  secret: string,
  context: string,
  clientNonce: string,
): Promise<string> {
  return channelHmac(secret, "genehub-channel-handshake-v1", [
    "client",
    context,
    clientNonce,
  ]);
}

export async function channelServerProof(
  secret: string,
  context: string,
  clientNonce: string,
  serverNonce: string,
): Promise<string> {
  return channelHmac(secret, "genehub-channel-handshake-v1", [
    "server",
    context,
    clientNonce,
    serverNonce,
  ]);
}

export async function deriveChannelSessionKey(
  secret: string,
  context: string,
  clientNonce: string,
  serverNonce: string,
): Promise<ChannelSessionKey> {
  const encryption = await channelHmacBytes(secret, "genehub-channel-key-v1", [
    "encryption",
    context,
    clientNonce,
    serverNonce,
  ]);
  return {
    context,
    encryptionKey: await subtle().importKey(
      "raw",
      arrayBuffer(encryption),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  };
}

// Mirrored from the daemon. Every field is length-prefixed, so two different
// transcripts cannot become the same byte string through delimiter tricks.
async function channelHmac(
  secret: string,
  domain: string,
  fields: string[],
): Promise<string> {
  return hex(await channelHmacBytes(secret, domain, fields));
}

async function channelHmacBytes(
  secret: string,
  domain: string,
  fields: string[],
): Promise<Uint8Array> {
  const key = await subtle().importKey(
    "raw",
    arrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle().sign(
    "HMAC",
    key,
    arrayBuffer(
      channelFields(
        domain,
        fields.map((field) => encoder.encode(field)),
      ),
    ),
  );
  return new Uint8Array(signature);
}

function channelFields(domain: string, fields: Uint8Array[]): Uint8Array {
  const values = [encoder.encode(domain), ...fields];
  const length = values.reduce((total, value) => total + 8 + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(u64(value.length), offset);
    offset += 8;
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function u64(value: number): Uint8Array {
  safeSequence(value);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function safeSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("channel sequence is outside the safe integer range");
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function webCrypto(): Crypto {
  const available = globalThis.crypto;
  if (!available) throw new Error("这个浏览器不支持配对所需的加密接口");
  return available;
}

/**
 * `crypto.subtle` is only exposed on secure origins. Saying so beats an
 * undefined-property error, because the fix is a real one: serve over HTTPS,
 * or reach the machine over localhost.
 */
function subtle(): SubtleCrypto {
  const available = webCrypto().subtle;
  if (!available) {
    throw new Error("配对需要 HTTPS（或 localhost）才能使用浏览器的加密接口");
  }
  return available;
}

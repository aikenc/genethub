/**
 * The two halves of the mutual proof, mirrored from the daemon's `devices.rs`.
 *
 * Neither side sends the secret. Each answers a challenge over it, so whoever
 * is carrying the bytes learns nothing reusable, and something sitting in the
 * machine's rendezvous slot cannot answer at all.
 */

export type Role = "client" | "server";

export async function proof(
  role: Role,
  nonce: string,
  secret: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`genehub-${role}:${nonce}:${secret}`);
  const digest = await subtle().digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
  readonly macKey: CryptoKey;
  readonly encryptionKey: CryptoKey;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CHANNEL_PROTOCOL_VERSION = 2;

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
  const mac = await channelHmacBytes(secret, "genehub-channel-key-v1", [
    "authentication",
    context,
    clientNonce,
    serverNonce,
  ]);
  const encryption = await channelHmacBytes(secret, "genehub-channel-key-v1", [
    "encryption",
    context,
    clientNonce,
    serverNonce,
  ]);
  return {
    context,
    macKey: await subtle().importKey(
      "raw",
      arrayBuffer(mac),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
    encryptionKey: await subtle().importKey(
      "raw",
      arrayBuffer(encryption),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  };
}

export async function sealChannelFrame(
  key: ChannelSessionKey,
  direction: ChannelDirection,
  sequence: number,
  plaintext: string,
): Promise<{ body: string; mac: string }> {
  safeSequence(sequence);
  const body = base64url(
    new Uint8Array(
      await subtle().encrypt(
        {
          name: "AES-GCM",
          iv: arrayBuffer(channelNonce(direction, sequence)),
          additionalData: arrayBuffer(
            channelAssociatedData(key.context, direction, sequence),
          ),
          tagLength: 128,
        },
        key.encryptionKey,
        arrayBuffer(encoder.encode(plaintext)),
      ),
    ),
  );
  const signature = await subtle().sign(
    "HMAC",
    key.macKey,
    arrayBuffer(
      channelFields("genehub-channel-frame-v1", [
        u32(CHANNEL_PROTOCOL_VERSION),
        encoder.encode(key.context),
        encoder.encode(direction),
        u64(sequence),
        encoder.encode(body),
      ]),
    ),
  );
  return { body, mac: hex(new Uint8Array(signature)) };
}

export async function openChannelFrame(
  key: ChannelSessionKey,
  direction: ChannelDirection,
  sequence: number,
  body: string,
  mac: string,
): Promise<string> {
  safeSequence(sequence);
  const presented = unhex(mac);
  const valid = await subtle().verify(
    "HMAC",
    key.macKey,
    arrayBuffer(presented),
    arrayBuffer(
      channelFields("genehub-channel-frame-v1", [
        u32(CHANNEL_PROTOCOL_VERSION),
        encoder.encode(key.context),
        encoder.encode(direction),
        u64(sequence),
        encoder.encode(body),
      ]),
    ),
  );
  if (!valid) throw new Error("channel message authentication failed");
  const plaintext = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(channelNonce(direction, sequence)),
      additionalData: arrayBuffer(
        channelAssociatedData(key.context, direction, sequence),
      ),
      tagLength: 128,
    },
    key.encryptionKey,
    arrayBuffer(unbase64url(body)),
  );
  return decoder.decode(plaintext);
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

function channelAssociatedData(
  context: string,
  direction: ChannelDirection,
  sequence: number,
): Uint8Array {
  return channelFields("genehub-channel-frame-v1", [
    u32(CHANNEL_PROTOCOL_VERSION),
    encoder.encode(context),
    encoder.encode(direction),
    u64(sequence),
  ]);
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

function channelNonce(
  direction: ChannelDirection,
  sequence: number,
): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(
    encoder.encode(direction === "client-to-daemon" ? "GHCD" : "GHDC"),
    0,
  );
  nonce.set(u64(sequence), 4);
  return nonce;
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("channel sequence is outside the safe integer range");
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new Error("invalid channel MAC encoding");
  return new Uint8Array(
    value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("invalid channel ciphertext encoding");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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

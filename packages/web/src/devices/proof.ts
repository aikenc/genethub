/**
 * The two halves of the mutual proof, mirrored from the daemon's `devices.rs`.
 *
 * Neither side sends the secret. Each answers a challenge over it, so whoever
 * is carrying the bytes learns nothing reusable, and something sitting in the
 * machine's rendezvous slot cannot answer at all.
 */

export type Role = "client" | "server";

export async function proof(role: Role, nonce: string, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(`genehub-${role}:${nonce}:${secret}`);
  const digest = await subtle().digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

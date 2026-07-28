import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Alphabet without characters users confuse when reading a code aloud. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/**
 * Matches the daemon's credential verifier construction, so the same helper can
 * check both our own tokens and the value produced by `hub/relationship-controller`.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function userCode(): string {
  const raw = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) out += "-";
    out += USER_CODE_ALPHABET[raw[i]! % USER_CODE_ALPHABET.length];
  }
  return out;
}

/** Short, human-comparable form of a daemon public key. */
export function publicKeyFingerprint(publicKeyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest();
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) {
    groups.push(digest.subarray(i, i + 2).toString("hex").toUpperCase());
  }
  return groups.join("-");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function isExpired(iso: string): boolean {
  return Date.parse(iso) <= Date.now();
}

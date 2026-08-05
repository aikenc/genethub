/** Node may surface a malformed request target to upgrade listeners. */
export function requestTarget(value: string | undefined): URL | null {
  try {
    return new URL(value ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

/** Rejects empty or oversized bearer/query credentials before authority work. */
export function admissionCredential(value: string | null | undefined, limit: number): string | null {
  if (!value) return null;
  return Buffer.byteLength(value, "utf8") <= limit ? value : null;
}

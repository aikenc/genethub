const SECRET = /(authorization|api[_-]?key|access[_-]?key|token|cookie|credential|pairing|secret|password|challenge|proof|machine[_-]?id|device[_-]?id|fingerprint)/i;
const ABS_PATH = /\/(?:home|Users|data|root)\/[^\s"']+/g;
const SECRET_NAME = String.raw`(?:authorization|api[_-]?key|access[_-]?key|token|cookie|credential|pairing|secret|password|challenge|serverProof|proof|machine[_-]?id|device[_-]?id|fingerprint)`;
const JSON_SECRET = new RegExp(`("${SECRET_NAME}"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|[^,}\\s]+)`, "gi");
const ASSIGNMENT_SECRET = new RegExp(`(\\b[A-Za-z0-9_]*(?:${SECRET_NAME})[A-Za-z0-9_]*\\s*=\\s*)([^\\s,;]+)`, "gi");
const URL_SECRET = new RegExp(`([?&](?:${SECRET_NAME})=)([^&\\s"']+)`, "gi");
const AUTH_HEADER = /(authorization\s*:\s*)(?:Bearer\s+)?[^\s,;]+/gi;
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g;

export function redactText(value: string): string {
  return value
    .replace(PRIVATE_KEY, "[redacted private key]")
    .replace(JSON_SECRET, '$1"[redacted]"')
    .replace(ASSIGNMENT_SECRET, "$1[redacted]")
    .replace(URL_SECRET, "$1[redacted]")
    .replace(AUTH_HEADER, "$1[redacted]")
    .replace(ABS_PATH, "[path]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET.test(key) ? "[redacted]" : redactValue(item);
    }
    return out;
  }
  return value;
}

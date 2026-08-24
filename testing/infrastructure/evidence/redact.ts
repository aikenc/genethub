const SECRET = /(authorization|api[_-]?key|token|cookie|pairing|secret|password)/i;
const ABS_PATH = /\/(?:home|Users|data|root)\/[^\s"']+/g;

export function redactText(value: string): string {
  return value
    .replace(SECRET, "[redacted]")
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

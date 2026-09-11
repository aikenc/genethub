const SECRET = /(authorization|api[_-]?key|token|cookie|pairing|secret|password|ticket|proof)/i;
const ABS_PATH = /\/(?:home|Users|data|root)\/[^\s"']+/g;

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/(["']?(?:authorization|api[_-]?key|token|cookie|pairingCode|secret|password|ticket|proof|channelSecret|fabricRouteTicket)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi, "$1[redacted]")
    .replace(/([?&](?:ticket|route|token|secret|proof|code)=)[^&#\s"']+/gi, "$1[redacted]")
    .replace(ABS_PATH, "[path]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = SECRET.test(key) ? "[redacted]" : redactValue(item);
    return out;
  }
  return value;
}

export const NEW_SESSION_ID = "new";

type TabKind =
  | "chat"
  | "files"
  | "terminal"
  | "settings"
  | "devices"
  | "logs"
  | "processes"
  | `extra:${string}`;

type WorkbenchTab = {
  id: string;
  kind: TabKind;
  sessionId?: string;
};

/** Hex digits taken from a UUID-style locator (`m_` + 32 hex). */
export const SHORT_HEX = 8;
/** Encoded `tabs=…` query, UTF-8. Over this the strip stays in memory only. */
export const TABS_QUERY_BUDGET = 384;
/** Shareable strip length. The in-memory strip can be longer. */
export const TABS_URL_LIMIT = 8;

const KINDS = ["m", "w", "s", "r"] as const;
export type LocatorKind = (typeof KINDS)[number];

const UUID_BODY = new RegExp(`^[0-9a-f]{${SHORT_HEX},}$`, "i");
const COMPACT = new RegExp(`^([mwsr])-([0-9a-f]{${SHORT_HEX}})$`, "i");
const UNDERSCORE = /^([mwsr])_(.+)$/i;

const SYSTEM_TAB: Record<string, TabKind> = {
  files: "files",
  term: "terminal",
  proc: "processes",
  settings: "settings",
  devices: "devices",
  logs: "logs",
};

const TAB_TOKEN: Partial<Record<TabKind, string>> = {
  files: "files",
  terminal: "term",
  processes: "proc",
  settings: "settings",
  devices: "devices",
  logs: "logs",
};

export function isCompactDeviceToken(value: string): boolean {
  return compactOf(value)?.kind === "m";
}

export function usesCompactDevice(deviceHandle: string): boolean {
  return isCompactDeviceToken(deviceHandle) || isUuidStyle(deviceHandle, "m");
}

export function isUuidStyle(id: string, kind: LocatorKind): boolean {
  const parsed = underscoreOf(id);
  return parsed?.kind === kind && UUID_BODY.test(parsed.body);
}

export function shortenLocator(id: string, kind?: LocatorKind): string {
  if (id === NEW_SESSION_ID) return "s-new";
  const compact = compactOf(id);
  if (compact) return `${compact.kind}-${compact.hex.toLowerCase()}`;
  const full = underscoreOf(id);
  if (full && UUID_BODY.test(full.body)) {
    return `${full.kind}-${full.body.slice(0, SHORT_HEX).toLowerCase()}`;
  }
  if (kind === "s" && id === NEW_SESSION_ID) return "s-new";
  return id;
}

export function shortenPreviewPath(path: string): string {
  const slash = path.indexOf("/");
  if (slash < 0) return shortenLocator(path, "r");
  return `${shortenLocator(path.slice(0, slash), "r")}${path.slice(slash)}`;
}

/**
 * Unique expand against a loaded roster. Zero or two matches: refuse to guess.
 */
export function expandLocator(token: string, candidates: readonly string[]): string | null {
  if (token === NEW_SESSION_ID || token === "s-new") {
    return candidates.includes(NEW_SESSION_ID) ? NEW_SESSION_ID : null;
  }
  const exact = candidates.filter((candidate) => candidate === token);
  if (exact.length === 1) return exact[0]!;
  const matches = candidates.filter((candidate) => locatorsMatch(token, candidate));
  return matches.length === 1 ? matches[0]! : null;
}

export function expandPreviewPath(path: string, rootHandles: readonly string[]): string | null {
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const root = expandLocator(path.slice(0, slash), rootHandles);
  if (!root) return null;
  return `${root}${path.slice(slash)}`;
}

export function locatorsMatch(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left === "s-new" || right === "s-new") {
    return left === NEW_SESSION_ID || right === NEW_SESSION_ID || left === right;
  }
  const a = parseToken(left);
  const b = parseToken(right);
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.hex === b.hex) return true;
  if (a.hex.length === SHORT_HEX && b.hex.length > SHORT_HEX && b.hex.startsWith(a.hex)) {
    return true;
  }
  if (b.hex.length === SHORT_HEX && a.hex.length > SHORT_HEX && a.hex.startsWith(b.hex)) {
    return true;
  }
  return false;
}

export function encodeTabToken(tab: WorkbenchTab): string | null {
  if (tab.kind === "chat") {
    if (!tab.sessionId || tab.id === "chat:draft") return "s-new";
    return shortenLocator(tab.sessionId, "s");
  }
  return TAB_TOKEN[tab.kind] ?? null;
}

export function decodeTabToken(token: string): { kind: TabKind; sessionToken?: string } | null {
  if (token === "s-new" || token === NEW_SESSION_ID) {
    return { kind: "chat", sessionToken: NEW_SESSION_ID };
  }
  if (token.startsWith("s-") || token.startsWith("s_")) {
    return { kind: "chat", sessionToken: token };
  }
  const kind = SYSTEM_TAB[token];
  return kind ? { kind } : null;
}

export function encodeTabsQuery(tokens: readonly string[]): string | null {
  const clipped = tokens.filter(Boolean).slice(0, TABS_URL_LIMIT);
  if (clipped.length === 0) return null;
  const params = new URLSearchParams();
  params.set("tabs", clipped.join(","));
  const encoded = params.toString();
  if (new TextEncoder().encode(encoded).length > TABS_QUERY_BUDGET) return null;
  return clipped.join(",");
}

export function parseTabsQuery(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, TABS_URL_LIMIT);
}

function parseToken(id: string): { kind: LocatorKind; hex: string } | null {
  const compact = compactOf(id);
  if (compact) return compact;
  const full = underscoreOf(id);
  if (full && UUID_BODY.test(full.body)) {
    return { kind: full.kind, hex: full.body.toLowerCase() };
  }
  return null;
}

function compactOf(id: string): { kind: LocatorKind; hex: string } | null {
  const match = COMPACT.exec(id);
  if (!match) return null;
  return { kind: match[1]!.toLowerCase() as LocatorKind, hex: match[2]!.toLowerCase() };
}

function underscoreOf(id: string): { kind: LocatorKind; body: string } | null {
  const match = UNDERSCORE.exec(id);
  if (!match) return null;
  return { kind: match[1]!.toLowerCase() as LocatorKind, body: match[2]! };
}

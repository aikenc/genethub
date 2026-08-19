import { stripSiteBase, withSiteBase } from "./base";
import {
  encodeTabsQuery,
  locatorsMatch,
  NEW_SESSION_ID,
  parseTabsQuery,
  shortenLocator,
  shortenPreviewPath,
  usesCompactDevice,
} from "./locator";

export { NEW_SESSION_ID } from "./locator";

export const WORKBENCH_DIALOGS = ["open-workspace", "feedback", "new-session"] as const;
export type WorkbenchDialog = (typeof WORKBENCH_DIALOGS)[number];

/**
 * How much of the workbench the address names.
 *
 * Machine and workspace homes stay at `/m-…` and `/m-…/w-…` even while a draft
 * is on screen. A stored conversation is the only thing that adds `/s-…`.
 */
export type AddressScope = "machine" | "workspace" | "session";

/**
 * Bookmarkable workbench address.
 *
 * Compact form: `/m-17ef85c5/w-cb37e25b/s-a1b2c3d4`.
 * Legacy `/d/<full>/w/<full>/s/<full>` still parses so old bookmarks open.
 * Query names overlays. Tickets never belong here.
 */
export interface WorkbenchLocation {
  deviceHandle: string;
  workspaceId: string | null;
  /** Durable session id, or `new` for an unsent draft. */
  sessionId: string | null;
  /** Workspace-relative file path (`rootHandle/…`) for the in-workbench float. */
  preview: string | null;
  dialog: WorkbenchDialog | null;
  /** Shareable strip tokens, in strip order. Omitted from the URL when empty or over budget. */
  tabs?: string[];
}

export function emptyWorkbenchLocation(deviceHandle: string): WorkbenchLocation {
  return {
    deviceHandle,
    workspaceId: null,
    sessionId: null,
    preview: null,
    dialog: null,
    tabs: [],
  };
}

export function parseWorkbenchHref(
  pathname: string,
  search = "",
  basePath?: string,
): WorkbenchLocation | null {
  const app = stripSiteBase(pathname, search, basePath);
  return parseWorkbenchPath(app.pathname, app.search || search);
}

export function parseWorkbenchPath(
  pathname: string,
  search = "",
): WorkbenchLocation | null {
  const parts = pathname.split("/").filter(Boolean);
  try {
    const parsed = parseCompactPath(parts) ?? parseLegacyPath(parts);
    if (!parsed) return null;
    return applyQuery(parsed, search);
  } catch {
    return null;
  }
}

export function formatWorkbenchPath(location: WorkbenchLocation): string {
  const path = usesCompactDevice(location.deviceHandle)
    ? formatCompactPath(location)
    : formatLegacyPath(location);
  const query = new URLSearchParams();
  if (location.preview) query.set("preview", shortenPreviewPath(location.preview));
  if (location.dialog && location.dialog !== "new-session") query.set("dialog", location.dialog);
  const tabs = encodeTabsQuery(location.tabs ?? []);
  if (tabs) query.set("tabs", tabs);
  if (location.sessionId === NEW_SESSION_ID && location.dialog === "new-session") {
    query.delete("dialog");
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export function formatWorkbenchHref(location: WorkbenchLocation, basePath?: string): string {
  return withSiteBase(formatWorkbenchPath(location), basePath);
}

/**
 * Drops the parts of a location that this address level does not name.
 *
 * A draft still has a default workspace; the machine homepage must not write
 * it into the bar, or a bookmarked `/m-…` is rewritten on every visit.
 */
export function scopedWorkbenchLocation(
  scope: AddressScope,
  location: WorkbenchLocation,
): WorkbenchLocation {
  if (scope === "machine") {
    return { ...location, workspaceId: null, sessionId: null };
  }
  if (scope === "workspace") {
    return { ...location, sessionId: null };
  }
  return location;
}

export function workbenchLocationsEqual(
  left: WorkbenchLocation | null,
  right: WorkbenchLocation | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    locatorsMatch(left.deviceHandle, right.deviceHandle) &&
    locatorsMatch(left.workspaceId, right.workspaceId) &&
    locatorsMatch(left.sessionId, right.sessionId) &&
    previewMatch(left.preview, right.preview) &&
    left.dialog === right.dialog &&
    tabsEqual(left.tabs, right.tabs)
  );
}

function parseCompactPath(parts: string[]): Omit<WorkbenchLocation, "preview" | "dialog" | "tabs"> | null {
  if (parts.length < 1 || parts.length > 3) return null;
  if (!/^m-[0-9a-f]{8}$/i.test(parts[0]!)) return null;
  const deviceHandle = locatorSegment(parts[0]!, "device handle");
  if (parts.length === 1) {
    return { deviceHandle, workspaceId: null, sessionId: null };
  }
  const workspace = parts[1]!;
  if (!isWorkspaceToken(workspace)) return null;
  const workspaceId = locatorSegment(workspace, "workspace id");
  if (parts.length === 2) {
    return { deviceHandle, workspaceId, sessionId: null };
  }
  const session = parts[2]!;
  if (!isSessionToken(session)) return null;
  return {
    deviceHandle,
    workspaceId,
    sessionId: session === "s-new" ? NEW_SESSION_ID : locatorSegment(session, "session id"),
  };
}

function parseLegacyPath(parts: string[]): Omit<WorkbenchLocation, "preview" | "dialog" | "tabs"> | null {
  if (parts[0] !== "d" || parts.length < 2) return null;
  const deviceHandle = locatorSegment(decodeCanonical(parts[1]!, "device handle"), "device handle");
  let workspaceId: string | null = null;
  let sessionId: string | null = null;
  if (parts[2] === "w") {
    if (!parts[3]) return null;
    workspaceId = locatorSegment(decodeCanonical(parts[3], "workspace id"), "workspace id");
    if (parts[4] === "s") {
      if (!parts[5] || parts.length !== 6) return null;
      sessionId = locatorSegment(decodeCanonical(parts[5], "session id"), "session id");
    } else if (parts.length !== 4) {
      return null;
    }
  } else if (parts.length !== 2) {
    return null;
  }
  return { deviceHandle, workspaceId, sessionId };
}

function formatCompactPath(location: WorkbenchLocation): string {
  let path = `/${encodeURIComponent(shortenLocator(location.deviceHandle, "m"))}`;
  if (location.workspaceId) {
    path += `/${encodeURIComponent(shortenLocator(location.workspaceId, "w"))}`;
    if (location.sessionId) {
      path += `/${encodeURIComponent(shortenLocator(location.sessionId, "s"))}`;
    }
  }
  return path;
}

function formatLegacyPath(location: WorkbenchLocation): string {
  const device = encodeURIComponent(locatorSegment(location.deviceHandle, "device handle"));
  let path = `/d/${device}`;
  if (location.workspaceId) {
    path += `/w/${encodeURIComponent(locatorSegment(location.workspaceId, "workspace id"))}`;
    if (location.sessionId) {
      path += `/s/${encodeURIComponent(locatorSegment(location.sessionId, "session id"))}`;
    }
  }
  return path;
}

function applyQuery(
  parsed: Omit<WorkbenchLocation, "preview" | "dialog" | "tabs">,
  search: string,
): WorkbenchLocation {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const previewRaw = query.get("preview");
  const preview = previewRaw === null ? null : previewPath(decodeURIComponent(previewRaw));
  let dialog = parseDialog(query.get("dialog"));
  let sessionId = parsed.sessionId;
  if (dialog === "new-session") {
    if (!sessionId || sessionId === NEW_SESSION_ID) sessionId = NEW_SESSION_ID;
    dialog = null;
  }
  return {
    ...parsed,
    sessionId,
    preview,
    dialog,
    tabs: parseTabsQuery(query.get("tabs")),
  };
}

function parseDialog(value: string | null): WorkbenchDialog | null {
  if (!value) return null;
  return (WORKBENCH_DIALOGS as readonly string[]).includes(value)
    ? (value as WorkbenchDialog)
    : null;
}

function isWorkspaceToken(value: string): boolean {
  return /^w-[0-9a-f]{8}$/i.test(value) || /^w_/.test(value);
}

function isSessionToken(value: string): boolean {
  return value === "s-new" || /^s-[0-9a-f]{8}$/i.test(value) || /^s_/.test(value);
}

function locatorSegment(value: string, name: string): string {
  if (
    !value ||
    value.length > 256 ||
    value === "." ||
    value === ".." ||
    /[\0/\\:#?]/.test(value) ||
    value.endsWith(".") ||
    value.endsWith(" ")
  ) {
    throw new TypeError(`invalid ${name}`);
  }
  return value;
}

function decodeCanonical(raw: string, name: string): string {
  if (!raw) throw new TypeError(`empty ${name}`);
  const value = decodeURIComponent(raw);
  if (encodeURIComponent(value).toUpperCase() !== raw.toUpperCase()) {
    throw new TypeError(`non-canonical ${name}`);
  }
  return value;
}

function previewPath(value: string): string {
  const parts = value.split("/");
  if (
    !value ||
    new TextEncoder().encode(value).byteLength > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    parts.length < 2 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        part.endsWith(".") ||
        part.endsWith(" "),
    )
  ) {
    throw new TypeError("preview path must be a canonical root-qualified file path");
  }
  locatorSegment(parts[0]!, "root handle");
  return value;
}

function previewMatch(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  try {
    return shortenPreviewPath(left) === shortenPreviewPath(right);
  } catch {
    return false;
  }
}

function tabsEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  return a.every((token, index) => token === b[index]);
}

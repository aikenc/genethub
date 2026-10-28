const PREVIEW_PATH = "assets/preview/v2/";

export interface AssetPreviewLocation {
  deviceHandle: string;
  workspaceHandle: string;
  path: string;
  docQuery?: string;
  docFragment?: string;
  siteEntryPath?: string;
}

/** Stable locator shared by Files, Agent output and chat rendering. */
export function assetPreviewUrl(
  deviceHandle: string,
  workspaceHandle: string,
  path: string,
  origin = typeof location === "undefined" ? "" : location.origin,
  basePath = previewBasePath(),
  documentLocation?: Pick<AssetPreviewLocation, "docQuery" | "docFragment" | "siteEntryPath">,
): string {
  if (isAbsoluteFilePath(path)) {
    const absolute = absoluteFilePath(path);
    const base = previewPrefix(basePath).replace("/v2/", "/v3/");
    const pathname = `${base}${encodeURIComponent(locatorSegment(deviceHandle, "device handle"))}?path=${encodeURIComponent(absolute)}`;
    return withDocumentLocation(origin ? new URL(pathname, origin).toString() : pathname, documentLocation);
  }
  const relative = previewPath(path);
  const pathname = `${assetPreviewBasePath(deviceHandle, workspaceHandle, basePath)}${relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  return withDocumentLocation(origin ? new URL(pathname, origin).toString() : pathname, documentLocation);
}

/**
 * Exact deployment/device/project/root prefix Agents append artifact paths to.
 *
 * It deliberately contains no placeholder path: the daemon validates this
 * structured prefix before turning it into fixed system guidance, and Agents
 * only ever append a workspace-relative path.
 */
export function assetPreviewBaseUrl(
  deviceHandle: string,
  workspaceHandle: string,
  rootHandle: string,
  origin = typeof location === "undefined" ? "" : location.origin,
  basePath = previewBasePath(),
): string {
  const base = assetPreviewBasePath(deviceHandle, workspaceHandle, basePath);
  const pathname =
    base + encodeURIComponent(locatorSegment(rootHandle, "root handle")) + "/";
  return origin ? new URL(pathname, origin).toString() : pathname;
}

function assetPreviewBasePath(
  deviceHandle: string,
  workspaceHandle: string,
  basePath: string,
): string {
  const device = locatorSegment(deviceHandle, "device handle");
  const workspace = locatorSegment(workspaceHandle, "workspace handle");
  return `${previewPrefix(basePath)}${encodeURIComponent(device)}/${encodeURIComponent(workspace)}/`;
}

export function parseAssetPreviewPath(
  pathname: string,
  basePath = previewBasePath(),
  search = typeof location === "undefined" ? "" : location.search,
): AssetPreviewLocation | null {
  const v3 = previewPrefix(basePath).replace("/v2/", "/v3/");
  if (pathname.startsWith(v3)) {
    try {
      const deviceHandle = decodeCanonical(pathname.slice(v3.length), "device handle");
      const params = new URLSearchParams(search);
      if (params.getAll("path").length !== 1) return null;
      return {deviceHandle: locatorSegment(deviceHandle, "device handle"), workspaceHandle: "", path: absoluteFilePath(params.get("path") ?? ""),
        ...(params.has("docQuery") ? {docQuery: params.get("docQuery")!} : {}),
        ...(params.has("docFragment") ? {docFragment: params.get("docFragment")!} : {}),
        ...(params.has("siteEntryPath") ? {siteEntryPath: absoluteFilePath(params.get("siteEntryPath")!)} : {})};
    } catch { return null; }
  }
  const prefix = previewPrefix(basePath);
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length).split("/");
  // device, project, root handle, then at least one recursive file segment.
  if (raw.length < 4) return null;
  try {
    const deviceHandle = decodeCanonical(raw[0]!, "device handle");
    const workspaceHandle = decodeCanonical(raw[1]!, "workspace handle");
    const path = raw
      .slice(2)
      .map((part) => {
        const decoded = decodeCanonical(part, "path segment");
        if (decoded.includes("/")) throw new TypeError("encoded path separator");
        return decoded;
      })
      .join("/");
    return {
      deviceHandle: locatorSegment(deviceHandle, "device handle"),
      workspaceHandle: locatorSegment(workspaceHandle, "workspace handle"),
      path: previewPath(path),
      ...(new URLSearchParams(search).has("siteEntryPath") ? {siteEntryPath: previewPath(new URLSearchParams(search).get("siteEntryPath")!)} : {}),
      ...(new URLSearchParams(search).has("docQuery") ? {docQuery: new URLSearchParams(search).get("docQuery")!} : {}),
      ...(new URLSearchParams(search).has("docFragment") ? {docFragment: new URLSearchParams(search).get("docFragment")!} : {}),
    };
  } catch {
    return null;
  }
}

/** Vite replaces this for each embedding build, including Cloud subpaths. */
function previewBasePath(): string {
  const configured = import.meta.env.BASE_URL || "/";
  // The standalone/Tauri bundle deliberately uses `./`; portable HTTP links
  // are rooted at the origin in that build. Cloud supplies an absolute base.
  return configured.startsWith("/") ? configured : "/";
}

function previewPrefix(basePath: string): string {
  if (!basePath.startsWith("/") || basePath.startsWith("//")) {
    throw new TypeError("preview base path must be site-relative");
  }
  const base = basePath === "/" ? "/" : `${basePath.replace(/\/+$/, "")}/`;
  return `${base}${PREVIEW_PATH}`;
}

export function previewPath(value: string): string {
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
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new TypeError(`non-canonical ${name}`);
  }
  // URL percent escapes are case-insensitive. A still-encoded segment must
  // round-trip exactly so `%2E%2E` and `%2F` cannot become a second path.
  if (encodeURIComponent(decoded).toUpperCase() === raw.toUpperCase()) {
    return decoded;
  }
  // `location.pathname` is already decoded. A literal segment with no escape
  // marker is the file name itself, including CJK characters and spaces.
  if (!raw.includes("%")) return raw;
  throw new TypeError(`non-canonical ${name}`);
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Wire paths use native volume spelling with forward separators. */
export function absoluteFilePath(value: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g, "/") : value;
  if (!isAbsoluteFilePath(path) || path.startsWith("//") || path.includes("\\") || path.includes("\0") || path.length > 4096
    || path.split("/").some(p => p === "." || p === "..") || path.endsWith("/")) {
    throw new TypeError("preview requires a canonical absolute file path");
  }
  return path;
}

export function previewFilePath(value: string): string {
  return isAbsoluteFilePath(value) ? absoluteFilePath(value) : previewPath(value);
}

function withDocumentLocation(href: string, target?: Pick<AssetPreviewLocation, "docQuery" | "docFragment" | "siteEntryPath">): string {
  if (!target) return href;
  const [pathname, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  for (const key of ["docQuery", "docFragment", "siteEntryPath"] as const) if (target[key]) params.set(key, target[key]!);
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

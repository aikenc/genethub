const PREVIEW_PATH = "assets/preview/v1/";

export interface AssetPreviewLocation {
  deviceHandle: string;
  workspaceHandle: string;
  path: string;
}

/** Stable locator shared by Files, Agent output and chat rendering. */
export function assetPreviewUrl(
  deviceHandle: string,
  workspaceHandle: string,
  path: string,
  origin = typeof location === "undefined" ? "" : location.origin,
  basePath = previewBasePath(),
): string {
  const device = locatorSegment(deviceHandle, "device handle");
  const workspace = locatorSegment(workspaceHandle, "workspace handle");
  const relative = previewPath(path);
  const pathname = `${previewPrefix(basePath)}${encodeURIComponent(device)}/${encodeURIComponent(workspace)}/${relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  return origin ? new URL(pathname, origin).toString() : pathname;
}

export function parseAssetPreviewPath(
  pathname: string,
  basePath = previewBasePath(),
): AssetPreviewLocation | null {
  const prefix = previewPrefix(basePath);
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length).split("/");
  if (raw.length < 3) return null;
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
  if (
    !value ||
    new TextEncoder().encode(value).byteLength > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        part.endsWith(".") ||
        part.endsWith(" "),
    )
  ) {
    throw new TypeError("preview path must be a canonical workspace-relative file path");
  }
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
  const value = decodeURIComponent(raw);
  // URL percent escapes are case-insensitive. Everything else must round-trip
  // exactly so a locator never has two path-boundary interpretations.
  if (encodeURIComponent(value).toUpperCase() !== raw.toUpperCase()) {
    throw new TypeError(`non-canonical ${name}`);
  }
  return value;
}

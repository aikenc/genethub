import { assetPreviewUrl, parseAssetPreviewPath, previewPath, absoluteFilePath, isAbsoluteFilePath } from "./url";

export type ArtifactFolder = {
  root: string;
  rootHandle: string;
};

export type ArtifactResolveContext = {
  deviceHandle: string;
  workspaceHandle: string;
  folders: ArtifactFolder[];
  machineFiles?: boolean;
  cwd?: string;
  /**
   * Root-qualified path of the current Markdown/HTML document
   * (`r_handle/dir/file.md`). Relative refs resolve against its directory.
   * When omitted (chat), relative refs resolve against the first folder as
   * Agent cwd; `../` may land in a sibling registered root.
   */
  documentPath?: string;
  docQuery?: string;
};

export type ResolvedArtifactRef =
  | { kind: "preview"; path: string; href: string; docQuery?: string; docFragment?: string }
  | { kind: "external"; href: string }
  | { kind: "blocked" };

/**
 * Turn an Agent/Markdown href or image src into a Preview locator, external
 * URL, or a blocked reference. Chat and document Preview share this resolver so
 * path intent survives channel/root-handle changes.
 */
export function resolveArtifactRef(
  raw: string | null | undefined,
  context: ArtifactResolveContext | null | undefined,
  origin = typeof location === "undefined" ? "https://local.test" : location.origin,
): ResolvedArtifactRef {
  const value = (raw ?? "").trim();
  if (value.startsWith("#") && context?.documentPath) {
    return {kind: "preview", path: context.documentPath,
      href: documentLocatorUrl(assetPreviewUrl(context.deviceHandle, context.workspaceHandle, context.documentPath, origin), context.docQuery ?? "", value),
      docQuery: context.docQuery, docFragment: value};
  }
  if (!value || value.startsWith("#")) {
    return value ? { kind: "external", href: value } : { kind: "blocked" };
  }
  const lower = value.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("blob:")
  ) {
    return { kind: "blocked" };
  }

  const rebound = rebindPreviewUrl(value, context, origin);
  if (rebound) return rebound;

  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    return { kind: "external", href: value.startsWith("//") ? `https:${value}` : value };
  }

  if (!context?.deviceHandle || (!context.workspaceHandle && !context.machineFiles) || (context.folders.length === 0 && !context.documentPath)) {
    return { kind: "blocked" };
  }

  const hashAt = value.indexOf("#");
  const withoutHash = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  const pathValue = queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt);
  const docQuery = queryAt < 0 ? "" : withoutHash.slice(queryAt);
  const docFragment = hashAt < 0 ? "" : value.slice(hashAt);
  let decodedPath: string;
  try { decodedPath = /^file:/i.test(pathValue) ? pathValue : decodeURIComponent(pathValue); }
  catch { return {kind: "blocked"}; }
  const filePath = resolveWorkspacePath(decodedPath, context);
  if (!filePath) return { kind: "blocked" };
  try {
    return {
      kind: "preview",
      path: filePath,
      href: documentLocatorUrl(assetPreviewUrl(context.deviceHandle, context.workspaceHandle, filePath, origin), docQuery, docFragment),
      ...(docQuery ? {docQuery} : {}), ...(docFragment ? {docFragment} : {}),
    };
  } catch {
    return { kind: "blocked" };
  }
}

function rebindPreviewUrl(
  value: string,
  context: ArtifactResolveContext | null | undefined,
  origin: string,
): ResolvedArtifactRef | null {
  let url: URL;
  try { url = new URL(value, origin); } catch { return null; }
  const match = url.pathname.match(/\/assets\/preview\/v[23]\//);
  if (!match || match.index === undefined) return null;
  const parsed = parseAssetPreviewPath(url.pathname.slice(match.index), "/", url.search);
  if (!parsed) return null;
  // A machine locator already identifies its machine. Never rebind it onto
  // the currently selected device and accidentally read a different file.
  if (isAbsoluteFilePath(parsed.path)) {
    if (!context || parsed.deviceHandle !== context.deviceHandle) return {kind: "external", href: value};
    return {kind: "preview", path: parsed.path, href: documentLocatorUrl(assetPreviewUrl(parsed.deviceHandle, "", parsed.path, origin), parsed.docQuery ?? "", parsed.docFragment ?? ""),
      ...(parsed.docQuery ? {docQuery: parsed.docQuery} : {}), ...(parsed.docFragment ? {docFragment: parsed.docFragment} : {})};
  }
  if (!context?.deviceHandle || !context.workspaceHandle) return {kind: "external", href: value};
  return {kind: "preview", path: parsed.path, href: assetPreviewUrl(context.deviceHandle, context.workspaceHandle, parsed.path, origin)};
}

function documentLocatorUrl(href: string, query: string, fragment: string): string {
  const url = new URL(href);
  if (query) url.searchParams.set("docQuery", query);
  if (fragment) url.searchParams.set("docFragment", fragment);
  return url.toString();
}

/** Resolve a workspace-relative, root-qualified, or absolute filesystem path. */
export function resolveWorkspacePath(
  value: string,
  context: ArtifactResolveContext,
): string | null {
  const stripped = stripFileUrl(value);
  if (context.machineFiles) {
    try {
      const normalized = stripped.replace(/\\/g, "/");
      if (isAbsoluteFilePath(normalized)) return absoluteFilePath(normalized);
      const folder = context.folders.find(folder => normalized.startsWith(`${folder.rootHandle}/`));
      if (folder) return joinFilesystem(folder.root, normalized.slice(folder.rootHandle.length + 1));
      const base = context.documentPath && isAbsoluteFilePath(context.documentPath)
        ? context.documentPath.split("/").slice(0, -1).join("/")
        : context.cwd ?? context.folders[0]?.root;
      return base ? joinFilesystem(base, normalized) : null;
    } catch { return null; }
  }
  const absolute = matchAbsolutePath(stripped, context.folders);
  if (absolute) return absolute;

  const normalized = stripped.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return null;

  // Already root-qualified: r_handle/rest/file
  const first = normalized.split("/")[0] ?? "";
  if (context.folders.some((folder) => folder.rootHandle === first)) {
    try {
      return previewPath(normalized.replace(/^\.\//, ""));
    } catch {
      return null;
    }
  }

  if (normalized.startsWith("/")) return null;

  const relative = normalized.replace(/^\.\//, "");
  if (context.documentPath) {
    return joinAgainstDocument(context.documentPath, relative);
  }
  // Chat: Agent cwd is the first folder. Join on its filesystem root so `../`
  // can reach a sibling workspace folder, then remap onto the longest match.
  const remapped = resolveRelativeToFirstRoot(relative, context);
  if (remapped) return remapped;
  const rootHandle = context.folders[0]?.rootHandle;
  if (!rootHandle) return null;
  return joinSegments(rootHandle, [], relative);
}

/** Join a cwd-relative path onto the first folder, then match any registered root. */
function resolveRelativeToFirstRoot(
  relative: string,
  context: ArtifactResolveContext,
): string | null {
  const first = context.folders[0];
  if (!first) return null;
  const absolute = joinFilesystem(first.root, relative);
  if (!absolute) return null;
  return matchAbsolutePath(absolute, context.folders);
}

/** POSIX/Windows filesystem join that refuses to walk above the volume root. */
function joinFilesystem(root: string, relative: string): string | null {
  const base = normalizeRoot(root);
  if (!base) return null;
  const windows = /^[A-Za-z]:\//.test(base);
  if (!windows && !base.startsWith("/")) return null;

  const parts = windows ? base.split("/") : base.split("/").filter(Boolean);
  const minLength = windows ? 1 : 0;
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length <= minLength) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (windows) return parts.length > 1 ? parts.join("/") : null;
  return parts.length > 0 ? `/${parts.join("/")}` : null;
}

function stripFileUrl(value: string): string {
  if (!/^file:/i.test(value)) return value;
  try {
    const url = new URL(value);
    // URL pathname on file:// is absolute; decode percent escapes.
    let path = decodeURIComponent(url.pathname);
    // Windows file://URL → /C:/...
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

function matchAbsolutePath(value: string, folders: ArtifactFolder[]): string | null {
  const candidate = value.replace(/\\/g, "/");
  if (!candidate.startsWith("/") && !/^[A-Za-z]:\//.test(candidate)) return null;

  let best: { rootHandle: string; rest: string; rootLen: number } | null = null;
  for (const folder of folders) {
    const root = normalizeRoot(folder.root);
    if (!root) continue;
    const matches =
      candidate === root ||
      candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (!matches) continue;
    const rest = candidate === root ? "" : candidate.slice(root.length).replace(/^\/+/, "");
    if (!best || root.length > best.rootLen) {
      best = { rootHandle: folder.rootHandle, rest, rootLen: root.length };
    }
  }
  if (!best || !best.rest) return null;
  return joinSegments(best.rootHandle, [], best.rest);
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinAgainstDocument(documentPath: string, relative: string): string | null {
  let path: string;
  try {
    path = previewPath(documentPath);
  } catch {
    return null;
  }
  const parts = path.split("/");
  const rootHandle = parts[0]!;
  const dir = parts.slice(1, -1);
  return joinSegments(rootHandle, dir, relative);
}

function joinSegments(
  rootHandle: string,
  baseDir: string[],
  relative: string,
): string | null {
  const parts = [...baseDir];
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  try {
    return previewPath([rootHandle, ...parts].join("/"));
  } catch {
    return null;
  }
}

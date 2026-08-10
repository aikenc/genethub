import { previewPath } from "./url";

export type SiteAssetFetch = (
  path: string,
) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;

const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const ATTR_SELECTORS: Array<{ selector: string; attr: string }> = [
  { selector: "link[href]", attr: "href" },
  { selector: "script[src]", attr: "src" },
  { selector: "img[src]", attr: "src" },
  { selector: "source[src]", attr: "src" },
  { selector: "video[src]", attr: "src" },
  { selector: "audio[src]", attr: "src" },
  { selector: "image[href]", attr: "href" },
  { selector: "use[href]", attr: "href" },
];

/**
 * Rewrite static relative assets in an HTML document to blob: URLs fetched
 * through authenticated Preview. Dynamic fetch/import and root-absolute paths
 * are intentionally left unresolved.
 */
export async function remapHtmlSite(options: {
  entryPath: string;
  html: string;
  fetchAsset: SiteAssetFetch;
  maxFiles?: number;
  maxTotalBytes?: number;
}): Promise<{ html: string; blobUrls: string[]; warnings: string[] }> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const entry = previewPath(options.entryPath);
  const document_ = new DOMParser().parseFromString(options.html, "text/html");
  const blobUrls: string[] = [];
  const warnings: string[] = [];
  const cache = new Map<string, string>();
  let files = 0;
  let totalBytes = 0;

  const resolve = async (raw: string | null, basePath: string): Promise<string | null> => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (
      !trimmed ||
      trimmed.startsWith("#") ||
      /^(https?:|data:|blob:|javascript:|mailto:)/i.test(trimmed) ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/")
    ) {
      return null;
    }
    const target = joinAgainstEntry(basePath, trimmed);
    if (!target) {
      warnings.push(`skipped ${trimmed}`);
      return null;
    }
    const hit = cache.get(target);
    if (hit) return hit;
    if (files >= maxFiles) {
      warnings.push(`file budget exceeded at ${target}`);
      return null;
    }
    const loaded = await options.fetchAsset(target);
    if (!loaded) {
      warnings.push(`missing ${target}`);
      return null;
    }
    if (totalBytes + loaded.bytes.byteLength > maxTotalBytes) {
      warnings.push(`byte budget exceeded at ${target}`);
      return null;
    }
    files += 1;
    totalBytes += loaded.bytes.byteLength;
    // Daemon often labels UTF-8 assets as text/plain; browsers refuse stylesheet /
    // classic script / SVG <img> blobs unless the Blob MIME matches the role.
    let mediaType = resolveMediaType(target, loaded.mediaType);
    let bytes = loaded.bytes;
    if (mediaType === "text/css" || target.toLowerCase().endsWith(".css")) {
      const cssText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const rewritten = await rewriteCssUrls(cssText, target, resolve);
      bytes = new TextEncoder().encode(rewritten);
      mediaType = "text/css";
    }
    const url = URL.createObjectURL(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: mediaType }),
    );
    blobUrls.push(url);
    cache.set(target, url);
    return url;
  };

  for (const { selector, attr } of ATTR_SELECTORS) {
    for (const node of Array.from(document_.querySelectorAll(selector))) {
      const current = node.getAttribute(attr);
      const next = await resolve(current, entry);
      if (next) node.setAttribute(attr, next);
    }
  }

  for (const node of Array.from(document_.querySelectorAll("style"))) {
    const cssText = node.textContent ?? "";
    if (!cssText.includes("url(") && !cssText.includes("@import")) continue;
    node.textContent = await rewriteCssUrls(cssText, entry, resolve);
  }

  return {
    html: `<!doctype html>\n${document_.documentElement.outerHTML}`,
    blobUrls,
    warnings,
  };
}

async function rewriteCssUrls(
  cssText: string,
  basePath: string,
  resolve: (raw: string | null, basePath: string) => Promise<string | null>,
): Promise<string> {
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const parts: string[] = [];
  let last = 0;
  for (const match of cssText.matchAll(pattern)) {
    const index = match.index ?? 0;
    parts.push(cssText.slice(last, index));
    const raw = match[2]?.trim() ?? "";
    const next = await resolve(raw, basePath);
    parts.push(next ? `url(${JSON.stringify(next)})` : match[0]);
    last = index + match[0].length;
  }
  parts.push(cssText.slice(last));
  return parts.join("");
}

function joinAgainstEntry(entryPath: string, relative: string): string | null {
  const parts = entryPath.split("/");
  const rootHandle = parts[0]!;
  const dir = parts.slice(1, -1);
  const stack = [...dir];
  for (const segment of relative.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return null;
  try {
    return previewPath([rootHandle, ...stack].join("/"));
  } catch {
    return null;
  }
}

function resolveMediaType(path: string, reported: string | undefined): string {
  const byExt = mimeFor(path);
  if (byExt !== "application/octet-stream") return byExt;
  if (reported && reported.trim()) return reported;
  return byExt;
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

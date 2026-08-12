import { previewPath } from "./url";

export type SiteAssetFetch = (
  path: string,
) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;

const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

type CachedAsset =
  | { kind: "css"; text: string }
  | { kind: "js"; text: string }
  | { kind: "data"; url: string };

/**
 * Rewrite static relative assets in an HTML document for sandboxed srcdoc.
 *
 * Parent-created blob: URLs are unusable inside an opaque-origin iframe
 * (`sandbox="allow-scripts"` without allow-same-origin). Inline CSS/JS and
 * data: URLs for media instead. Dynamic fetch/import and root-absolute paths
 * stay unresolved.
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
  const warnings: string[] = [];
  const cache = new Map<string, CachedAsset>();
  let files = 0;
  let totalBytes = 0;

  const loadAsset = async (target: string): Promise<CachedAsset | null> => {
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
    const mediaType = resolveMediaType(target, loaded.mediaType);
    let asset: CachedAsset;
    if (mediaType === "text/css" || target.toLowerCase().endsWith(".css")) {
      const cssText = new TextDecoder("utf-8", { fatal: false }).decode(loaded.bytes);
      const rewritten = await rewriteCssUrls(cssText, target, resolveDataUrl);
      asset = { kind: "css", text: rewritten };
    } else if (
      mediaType === "text/javascript" ||
      target.toLowerCase().endsWith(".js") ||
      target.toLowerCase().endsWith(".mjs")
    ) {
      asset = {
        kind: "js",
        text: new TextDecoder("utf-8", { fatal: false }).decode(loaded.bytes),
      };
    } else {
      asset = { kind: "data", url: toDataUrl(loaded.bytes, mediaType) };
    }
    cache.set(target, asset);
    return asset;
  };

  const resolveDataUrl = async (
    raw: string | null,
    basePath: string,
  ): Promise<string | null> => {
    const target = resolveTarget(raw, basePath, warnings);
    if (!target) return null;
    const asset = await loadAsset(target);
    if (!asset) return null;
    if (asset.kind === "data") return asset.url;
    if (asset.kind === "css") {
      return toDataUrl(new TextEncoder().encode(asset.text), "text/css");
    }
    return toDataUrl(new TextEncoder().encode(asset.text), "text/javascript");
  };

  for (const node of Array.from(document_.querySelectorAll("link[href]"))) {
    const rel = (node.getAttribute("rel") ?? "").toLowerCase();
    const href = node.getAttribute("href");
    if (rel.includes("stylesheet")) {
      const target = resolveTarget(href, entry, warnings);
      if (!target) continue;
      const asset = await loadAsset(target);
      if (!asset || asset.kind !== "css") {
        if (asset) warnings.push(`expected css at ${target}`);
        continue;
      }
      const style = document_.createElement("style");
      style.textContent = asset.text;
      node.replaceWith(style);
      continue;
    }
    // Icons / prefetch: best-effort data URL rewrite.
    const next = await resolveDataUrl(href, entry);
    if (next) node.setAttribute("href", next);
  }

  for (const node of Array.from(document_.querySelectorAll("script[src]"))) {
    if (node.getAttribute("type")?.toLowerCase() === "module") {
      warnings.push(`module script left unresolved: ${node.getAttribute("src") ?? ""}`);
      continue;
    }
    const target = resolveTarget(node.getAttribute("src"), entry, warnings);
    if (!target) continue;
    const asset = await loadAsset(target);
    if (!asset || asset.kind !== "js") {
      if (asset) warnings.push(`expected js at ${target}`);
      continue;
    }
    const script = document_.createElement("script");
    for (const name of Array.from(node.attributes)) {
      if (name.name === "src") continue;
      script.setAttribute(name.name, name.value);
    }
    script.textContent = asset.text;
    node.replaceWith(script);
  }

  for (const { selector, attr } of [
    { selector: "img[src]", attr: "src" },
    { selector: "source[src]", attr: "src" },
    { selector: "video[src]", attr: "src" },
    { selector: "audio[src]", attr: "src" },
    { selector: "image[href]", attr: "href" },
    { selector: "use[href]", attr: "href" },
  ] as const) {
    for (const node of Array.from(document_.querySelectorAll(selector))) {
      const next = await resolveDataUrl(node.getAttribute(attr), entry);
      if (next) node.setAttribute(attr, next);
    }
  }

  for (const node of Array.from(document_.querySelectorAll("style"))) {
    const cssText = node.textContent ?? "";
    if (!cssText.includes("url(") && !cssText.includes("@import")) continue;
    node.textContent = await rewriteCssUrls(cssText, entry, resolveDataUrl);
  }

  return {
    html: `<!doctype html>\n${document_.documentElement.outerHTML}`,
    blobUrls: [],
    warnings,
  };
}

function resolveTarget(
  raw: string | null,
  basePath: string,
  warnings: string[],
): string | null {
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
  return target;
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

function toDataUrl(bytes: Uint8Array, mediaType: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

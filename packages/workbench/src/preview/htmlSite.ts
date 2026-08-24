import { previewPath } from "./url";

export type SiteAssetFetch = (
  path: string,
) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;

const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const PREVIEW_ORIGIN = "https://preview.invalid/";
const IMPORT_SPECIFIER = /(?:\bfrom\s+|import\s*\(\s*)(['"])([^'"]+)\1/g;

type CachedAsset =
  | { kind: "css"; text: string }
  | { kind: "js"; text: string }
  | { kind: "data"; url: string };

/**
 * Rewrite static relative and site-root assets in an HTML document for
 * sandboxed srcdoc. Parent-created blob: URLs are unusable inside an
 * opaque-origin iframe, so CSS/JS are inlined and media uses data: URLs.
 * Runtime fetch/import of remaining assets goes through the iframe bridge.
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
  const jsRewriteCache = new Map<string, string>();
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
    } else if (isJavaScriptPath(target, mediaType)) {
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
    const target = resolveTarget(raw, basePath, entry, warnings);
    if (!target) return null;
    const asset = await loadAsset(target);
    if (!asset) return null;
    if (asset.kind === "data") return asset.url;
    if (asset.kind === "css") {
      return toDataUrl(new TextEncoder().encode(asset.text), "text/css");
    }
    return toDataUrl(new TextEncoder().encode(asset.text), "text/javascript");
  };

  const rewriteJs = async (filePath: string, text: string): Promise<string> => {
    const cached = jsRewriteCache.get(filePath);
    if (cached !== undefined) return cached;
    jsRewriteCache.set(filePath, text);
    let out = text.replaceAll("import.meta.url", JSON.stringify(virtualAssetUrl(filePath, entry)));
    const specs = new Set<string>();
    for (const match of out.matchAll(IMPORT_SPECIFIER)) {
      if (match[2]) specs.add(match[2]);
    }
    for (const spec of specs) {
      const target = resolveTarget(spec, filePath, entry, warnings);
      if (!target) continue;
      const asset = await loadAsset(target);
      if (!asset || asset.kind !== "js") continue;
      const rewritten = await rewriteJs(target, asset.text);
      out = replaceSpecifiers(out, spec, toDataUrl(new TextEncoder().encode(rewritten), "text/javascript"));
    }
    jsRewriteCache.set(filePath, out);
    return out;
  };

  for (const node of Array.from(document_.querySelectorAll("link[href]"))) {
    const rel = (node.getAttribute("rel") ?? "").toLowerCase();
    const href = node.getAttribute("href");
    if (rel.includes("stylesheet")) {
      const target = resolveTarget(href, entry, entry, warnings);
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
    const next = await resolveDataUrl(href, entry);
    if (next) node.setAttribute("href", next);
  }

  for (const node of Array.from(document_.querySelectorAll("script[src]"))) {
    const target = resolveTarget(node.getAttribute("src"), entry, entry, warnings);
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
    script.textContent = await rewriteJs(target, asset.text);
    node.replaceWith(script);
  }

  for (const node of Array.from(document_.querySelectorAll("script:not([src])"))) {
    if (node.getAttribute("type")?.toLowerCase() !== "module") continue;
    node.textContent = await rewriteJs(`${entry}#inline`, node.textContent ?? "");
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

export function resolveRuntimeAssetPath(entryPath: string, rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, PREVIEW_ORIGIN);
    if (parsed.protocol !== "https:" || parsed.hostname !== "preview.invalid") return null;
    const relative = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!relative) return null;
    return joinAgainstEntry(previewPath(entryPath), relative);
  } catch {
    return null;
  }
}

function resolveTarget(
  raw: string | null,
  basePath: string,
  entryPath: string,
  warnings: string[],
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^(https?:|data:|blob:|javascript:|mailto:)/i.test(trimmed) ||
    trimmed.startsWith("//")
  ) {
    return null;
  }
  const target = trimmed.startsWith("/")
    ? joinAgainstEntry(entryPath, trimmed.replace(/^\/+/, ""))
    : joinAgainstEntry(basePath, trimmed);
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

function virtualAssetUrl(filePath: string, entryPath: string): string {
  const root = entryPath.split("/").slice(0, -1).join("/");
  const prefix = `${root}/`;
  const rel = filePath.startsWith(prefix)
    ? filePath.slice(prefix.length)
    : filePath.split("/").slice(1).join("/");
  return `${PREVIEW_ORIGIN}${rel.split("#")[0]}`;
}

function replaceSpecifiers(source: string, spec: string, next: string): string {
  let out = source;
  for (const quote of [`'${spec}'`, `"${spec}"`]) {
    out = out.split(quote).join(JSON.stringify(next));
  }
  return out;
}

function isJavaScriptPath(path: string, mediaType: string): boolean {
  const lower = path.toLowerCase();
  return (
    mediaType === "text/javascript" ||
    mediaType === "application/javascript" ||
    lower.endsWith(".js") ||
    lower.endsWith(".mjs")
  );
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
  if (lower.endsWith(".wasm")) return "application/wasm";
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

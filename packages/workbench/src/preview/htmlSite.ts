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
 * opaque-origin iframe, so CSS/JS are inlined. Media elements are NOT
 * fetched here: their URLs are rewritten to `https://preview.invalid/@root/...`
 * placeholders that the in-iframe bridge resolves to blob: URLs on demand.
 * Runtime fetch/import of remaining assets goes through the same bridge.
 */
export async function remapHtmlSite(options: {
  entryPath: string;
  html: string;
  fetchAsset: SiteAssetFetch;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxConcurrent?: number;
}): Promise<{ html: string; blobUrls: string[]; warnings: string[] }> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const entry = previewPath(options.entryPath);
  const document_ = new DOMParser().parseFromString(options.html, "text/html");
  const warnings: string[] = [];
  const cache = new Map<string, Promise<CachedAsset | null>>();
  const jsRewriteCache = new Map<string, string>();
  const fetchAsset = limitConcurrency(options.fetchAsset, options.maxConcurrent ?? 8);
  let files = 0;
  let totalBytes = 0;

  const loadAsset = (target: string): Promise<CachedAsset | null> => {
    const hit = cache.get(target);
    if (hit) return hit;
    const pending = (async (): Promise<CachedAsset | null> => {
      if (files >= maxFiles) {
        warnings.push(`file budget exceeded at ${target}`);
        return null;
      }
      const loaded = await fetchAsset(target);
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
      return asset;
    })();
    cache.set(target, pending);
    return pending;
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

  /**
   * Media placeholders: rewrite the URL to a `@root/`-absolute virtual URL
   * under the preview origin without fetching bytes. The iframe bridge
   * resolves placeholders lazily. Cross-root media (rare) keeps the eager
   * data: path because runtime resolution is confined to the entry root.
   */
  const resolveMediaUrl = async (
    raw: string | null,
    basePath: string,
  ): Promise<string | null> => {
    if (!raw) return null;
    const trimmed = raw.trim();
    const suffixMatch = trimmed.match(/^([^?#]*)([?#].*)?$/);
    const path = suffixMatch?.[1] ?? trimmed;
    const suffix = suffixMatch?.[2] ?? "";
    const target = resolveTarget(path, basePath, entry, warnings);
    if (!target) return null;
    const virtual = virtualMediaUrl(target, entry);
    if (virtual) return virtual + suffix;
    const loaded = await loadAsset(target);
    if (!loaded) return null;
    if (loaded.kind === "data") return loaded.url;
    if (loaded.kind === "css") return toDataUrl(new TextEncoder().encode(loaded.text), "text/css");
    return toDataUrl(new TextEncoder().encode(loaded.text), "text/javascript");
  };

  const rewriteSrcset = async (raw: string | null, basePath: string): Promise<string | null> => {
    if (!raw || !raw.trim()) return null;
    const candidates = raw.split(",").map((candidate) => candidate.trim());
    const rewritten = await Promise.all(
      candidates.map(async (candidate) => {
        const parts = candidate.split(/\s+/);
        const url = parts.shift();
        const next = await resolveMediaUrl(url ?? null, basePath);
        return [next ?? url, ...parts].join(" ");
      }),
    );
    return rewritten.join(", ");
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
    const replacements = await Promise.all(
      Array.from(specs).map(async (spec) => {
        const target = resolveTarget(spec, filePath, entry, warnings);
        if (!target) return null;
        const asset = await loadAsset(target);
        if (!asset || asset.kind !== "js") return null;
        const rewritten = await rewriteJs(target, asset.text);
        return { spec, url: toDataUrl(new TextEncoder().encode(rewritten), "text/javascript") };
      }),
    );
    for (const replacement of replacements) {
      if (replacement) out = replaceSpecifiers(out, replacement.spec, replacement.url);
    }
    jsRewriteCache.set(filePath, out);
    return out;
  };

  await Promise.all(
    Array.from(document_.querySelectorAll("link[href]")).map(async (node) => {
      const rel = (node.getAttribute("rel") ?? "").toLowerCase();
      const href = node.getAttribute("href");
      if (rel.includes("stylesheet")) {
        const target = resolveTarget(href, entry, entry, warnings);
        if (!target) return;
        const asset = await loadAsset(target);
        if (!asset || asset.kind !== "css") {
          if (asset) warnings.push(`expected css at ${target}`);
          return;
        }
        const style = document_.createElement("style");
        style.textContent = asset.text;
        node.replaceWith(style);
        return;
      }
      const next = await resolveMediaUrl(href, entry);
      if (next) node.setAttribute("href", next);
    }),
  );

  await Promise.all(
    Array.from(document_.querySelectorAll("script[src]")).map(async (node) => {
      const target = resolveTarget(node.getAttribute("src"), entry, entry, warnings);
      if (!target) return;
      const asset = await loadAsset(target);
      if (!asset || asset.kind !== "js") {
        if (asset) warnings.push(`expected js at ${target}`);
        return;
      }
      const script = document_.createElement("script");
      for (const name of Array.from(node.attributes)) {
        if (name.name === "src") continue;
        script.setAttribute(name.name, name.value);
      }
      script.textContent = await rewriteJs(target, asset.text);
      node.replaceWith(script);
    }),
  );

  await Promise.all(
    Array.from(document_.querySelectorAll("script:not([src])")).map(async (node) => {
      if (node.getAttribute("type")?.toLowerCase() !== "module") return;
      node.textContent = await rewriteJs(`${entry}#inline`, node.textContent ?? "");
    }),
  );

  await Promise.all(
    (
      [
        { selector: "img[src]", attr: "src" },
        { selector: "source[src]", attr: "src" },
        { selector: "video[src]", attr: "src" },
        { selector: "video[poster]", attr: "poster" },
        { selector: "audio[src]", attr: "src" },
        { selector: "track[src]", attr: "src" },
        { selector: "image[href]", attr: "href" },
        { selector: "use[href]", attr: "href" },
      ] as const
    ).map(async ({ selector, attr }) => {
      await Promise.all(
        Array.from(document_.querySelectorAll(selector)).map(async (node) => {
          const next = await resolveMediaUrl(node.getAttribute(attr), entry);
          if (next) node.setAttribute(attr, next);
        }),
      );
    }),
  );

  await Promise.all(
    (
      [
        { selector: "img[srcset]", attr: "srcset" },
        { selector: "source[srcset]", attr: "srcset" },
      ] as const
    ).map(async ({ selector, attr }) => {
      await Promise.all(
        Array.from(document_.querySelectorAll(selector)).map(async (node) => {
          const next = await rewriteSrcset(node.getAttribute(attr), entry);
          if (next) node.setAttribute(attr, next);
        }),
      );
    }),
  );

  await Promise.all(
    Array.from(document_.querySelectorAll("style")).map(async (node) => {
      const cssText = node.textContent ?? "";
      if (!cssText.includes("url(") && !cssText.includes("@import")) return;
      node.textContent = await rewriteCssUrls(cssText, entry, resolveDataUrl);
    }),
  );

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
    const entry = previewPath(entryPath);
    // `@root/...` addresses a path absolute to the entry root (media
    // placeholders). Everything else is joined against the entry directory.
    // Both stay confined to the entry root: ".." cannot pop past it.
    if (relative.startsWith("@root/")) {
      const rootHandle = entry.split("/")[0]!;
      return joinAgainstEntry(`${rootHandle}/-`, relative.slice("@root/".length));
    }
    return joinAgainstEntry(entry, relative);
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
  const matches = Array.from(cssText.matchAll(pattern));
  const resolved = await Promise.all(
    matches.map((match) => resolve(match[2]?.trim() ?? "", basePath)),
  );
  const parts: string[] = [];
  let last = 0;
  matches.forEach((match, index) => {
    const at = match.index ?? 0;
    parts.push(cssText.slice(last, at));
    const next = resolved[index];
    parts.push(next ? `url(${JSON.stringify(next)})` : match[0]);
    last = at + match[0].length;
  });
  parts.push(cssText.slice(last));
  return parts.join("");
}

function limitConcurrency(
  fetchAsset: SiteAssetFetch,
  maxConcurrent: number,
): SiteAssetFetch {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (path) => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fetchAsset(path);
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
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

/**
 * Absolute-to-entry-root virtual URL for lazily resolved media. Returns null
 * for cross-root targets: runtime resolution is confined to the entry root,
 * so those keep the eager data: path.
 */
function virtualMediaUrl(target: string, entryPath: string): string | null {
  const rootHandle = entryPath.split("/")[0]!;
  if (!target.startsWith(`${rootHandle}/`)) return null;
  return `${PREVIEW_ORIGIN}@root/${target.slice(rootHandle.length + 1)}`;
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

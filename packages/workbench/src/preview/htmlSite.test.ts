import { beforeEach, describe, expect, it, vi } from "vitest";

import { remapHtmlSite, resolveRuntimeAssetPath } from "./htmlSite";

describe("remapHtmlSite", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("blob URLs must not be used for sandboxed srcdoc sites");
      },
    });
  });

  it("inlines relative css/js and rewrites media to lazy placeholders", async () => {
    const fetchAsset = vi.fn(async (path: string) => {
      if (path === "r_demo/app.css") {
        return { bytes: new TextEncoder().encode("body{color:red}"), mediaType: "text/plain" };
      }
      if (path === "r_demo/app.js") {
        return {
          bytes: new TextEncoder().encode("globalThis.ok=true"),
          mediaType: "text/plain",
        };
      }
      return null;
    });

    const result = await remapHtmlSite({
      entryPath: "r_demo/index.html",
      html: `<!doctype html><html><head>
        <link rel="stylesheet" href="./app.css">
        <script src="./app.js"></script>
      </head><body><img src="./mark.svg"><video poster="./cover.png" src="./clip.mp4"></video></body></html>`,
      fetchAsset,
    });

    expect(fetchAsset).toHaveBeenCalledWith("r_demo/app.css");
    expect(fetchAsset).toHaveBeenCalledWith("r_demo/app.js");
    // Media bytes are not fetched during remap; the iframe bridge resolves
    // the placeholders on demand.
    expect(fetchAsset).not.toHaveBeenCalledWith("r_demo/mark.svg");
    expect(fetchAsset).not.toHaveBeenCalledWith("r_demo/cover.png");
    expect(fetchAsset).not.toHaveBeenCalledWith("r_demo/clip.mp4");
    expect(result.html).toContain("<style>body{color:red}</style>");
    expect(result.html).toContain("<script>globalThis.ok=true</script>");
    expect(result.html).toContain('src="https://preview.invalid/@root/mark.svg"');
    expect(result.html).toContain('poster="https://preview.invalid/@root/cover.png"');
    expect(result.html).toContain('src="https://preview.invalid/@root/clip.mp4"');
    expect(result.html).not.toContain("blob:");
    expect(result.blobUrls).toHaveLength(0);
  });

  it("resolves placeholders back onto the entry root and confines traversal", () => {
    expect(
      resolveRuntimeAssetPath("r_demo/index.html", "https://preview.invalid/@root/mark.svg"),
    ).toBe("r_demo/mark.svg");
    expect(
      resolveRuntimeAssetPath("r_demo/a/b/index.html", "https://preview.invalid/@root/mark.svg"),
    ).toBe("r_demo/mark.svg");
    // ".." segments are normalized away by the URL parser before resolution;
    // what survives is still confined to the entry root.
    expect(
      resolveRuntimeAssetPath("r_demo/index.html", "https://preview.invalid/@root/../x.svg"),
    ).toBe("r_demo/x.svg");
    expect(
      resolveRuntimeAssetPath("r_demo/index.html", "https://preview.invalid/@root/a/../../x.svg"),
    ).toBe("r_demo/x.svg");
    // Encoded traversal is normalized by the URL parser as well.
    expect(
      resolveRuntimeAssetPath("r_demo/index.html", "https://preview.invalid/@root/%2e%2e/x.svg"),
    ).toBe("r_demo/x.svg");
  });

  it("keeps query and fragment suffixes on media placeholders", async () => {
    const fetchAsset = vi.fn(async () => null);
    const result = await remapHtmlSite({
      entryPath: "r_demo/index.html",
      html: `<img src="./mark.svg?v=2"><svg><use href="./icons.svg#play"></use></svg>`,
      fetchAsset,
    });
    expect(result.html).toContain('src="https://preview.invalid/@root/mark.svg?v=2"');
    expect(result.html).toContain('href="https://preview.invalid/@root/icons.svg#play"');
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("rewrites site-root paths and leaves remote assets alone", async () => {
    const fetchAsset = vi.fn(async (path: string) => {
      if (path === "r_demo/cdn.css") {
        return { bytes: new TextEncoder().encode("body{color:blue}"), mediaType: "text/css" };
      }
      return null;
    });
    const result = await remapHtmlSite({
      entryPath: "r_demo/index.html",
      html: `<link rel="stylesheet" href="/cdn.css"><script src="https://cdn.example/a.js"></script>`,
      fetchAsset,
    });
    expect(fetchAsset).toHaveBeenCalledWith("r_demo/cdn.css");
    expect(result.html).toContain("<style>body{color:blue}</style>");
    expect(result.html).toContain("https://cdn.example/a.js");
  });

  it("inlines module scripts and rewrites import.meta.url", async () => {
    const fetchAsset = vi.fn(async (path: string) => {
      if (path === "r_demo/app.js") {
        return {
          bytes: new TextEncoder().encode(
            "export default function init(){ return import.meta.url }",
          ),
          mediaType: "text/javascript",
        };
      }
      return null;
    });
    const result = await remapHtmlSite({
      entryPath: "r_demo/index.html",
      html: `<script type="module" src="./app.js"></script>`,
      fetchAsset,
    });
    expect(result.html).toContain("type=\"module\"");
    expect(result.html).toContain("https://preview.invalid/app.js");
    expect(result.html).not.toContain("import.meta.url");
  });
});

describe("resolveRuntimeAssetPath", () => {
  it("maps preview.invalid URLs onto the HTML site root", () => {
    expect(resolveRuntimeAssetPath("r_demo/index.html", "https://preview.invalid/pkg/game.wasm")).toBe(
      "r_demo/pkg/game.wasm",
    );
    expect(resolveRuntimeAssetPath("r_demo/index.html", "https://cdn.example/x.wasm")).toBeNull();
  });
});

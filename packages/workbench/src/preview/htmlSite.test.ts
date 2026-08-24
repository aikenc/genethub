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

  it("inlines relative css/js and data-URLs images for opaque iframes", async () => {
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
      if (path === "r_demo/mark.svg") {
        return {
          bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
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
      </head><body><img src="./mark.svg"></body></html>`,
      fetchAsset,
    });

    expect(fetchAsset).toHaveBeenCalledWith("r_demo/app.css");
    expect(fetchAsset).toHaveBeenCalledWith("r_demo/app.js");
    expect(fetchAsset).toHaveBeenCalledWith("r_demo/mark.svg");
    expect(result.html).toContain("<style>body{color:red}</style>");
    expect(result.html).toContain("<script>globalThis.ok=true</script>");
    expect(result.html).toContain('src="data:image/svg+xml;base64,');
    expect(result.html).not.toContain("blob:");
    expect(result.blobUrls).toHaveLength(0);
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { remapHtmlSite } from "./htmlSite";

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

  it("does not rewrite root-absolute or remote assets", async () => {
    const fetchAsset = vi.fn(async () => null);
    const result = await remapHtmlSite({
      entryPath: "r_demo/index.html",
      html: `<link href="/cdn.css"><script src="https://cdn.example/a.js"></script>`,
      fetchAsset,
    });
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(result.html).toContain('href="/cdn.css"');
    expect(result.html).toContain("https://cdn.example/a.js");
  });
});

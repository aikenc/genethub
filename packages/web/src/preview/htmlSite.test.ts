import { beforeEach, describe, expect, it, vi } from "vitest";

import { remapHtmlSite } from "./htmlSite";

describe("remapHtmlSite", () => {
  beforeEach(() => {
    let seq = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => `blob:https://local.test/${seq++}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  });
  afterEach(() => {
    // jsdom may not define these; leave harmless stubs in place for later tests.
  });

  it("rewrites relative css and script tags to blob URLs", async () => {
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
      </head><body>hi</body></html>`,
      fetchAsset,
    });

    expect(fetchAsset).toHaveBeenCalledWith("r_demo/app.css");
    expect(fetchAsset).toHaveBeenCalledWith("r_demo/app.js");
    expect(result.html).toContain('href="blob:');
    expect(result.html).toContain('src="blob:');
    expect(result.blobUrls).toHaveLength(2);
    for (const url of result.blobUrls) URL.revokeObjectURL(url);
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

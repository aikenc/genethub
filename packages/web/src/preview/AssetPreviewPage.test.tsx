import { describe, expect, it } from "vitest";

import { isolatedHtml } from "./AssetPreviewPage";

describe("active single-file HTML Preview", () => {
  it("keeps scripts but replaces document-controlled origin and network policy", () => {
    const output = isolatedHtml(`<!doctype html>
      <html><head>
        <base href="https://attacker.example/">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
      </head><body><script>globalThis.rendered = true</script></body></html>`);
    const parsed = new DOMParser().parseFromString(output, "text/html");

    expect(parsed.querySelector("script")?.textContent).toContain("rendered");
    expect(parsed.querySelector("base")?.getAttribute("href")).toBe(
      "https://preview.invalid/",
    );
    const policy = parsed
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    expect(policy).toContain("connect-src https: wss:");
    expect(policy).toContain("script-src 'unsafe-inline' https: blob:");
    expect(policy).toContain("style-src 'unsafe-inline' https: blob:");
    expect(policy).toContain("font-src data: blob: https:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("default-src *");
    const bridge = Array.from(parsed.querySelectorAll("script")).find((node) =>
      (node.textContent ?? "").includes("genehub-preview-diag"),
    );
    expect(bridge?.textContent).toContain('source: "genehub-preview-diag"');
    expect(bridge?.textContent).toContain("securitypolicyviolation");
  });
});

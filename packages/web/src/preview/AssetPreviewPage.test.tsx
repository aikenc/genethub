import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AssetPreviewMetadata } from "@genehub/proto";

import { HtmlDocument, isolatedHtml } from "./AssetPreviewPage";

describe("active single-file HTML Preview", () => {
  it("keeps scripts but replaces document-controlled origin and network policy", () => {
    const output = isolatedHtml(`<!doctype html>
      <html><head>
        <base href="https://attacker.example/">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
      </head><body><script id="application-script">globalThis.rendered = true</script></body></html>`);
    const parsed = new DOMParser().parseFromString(output, "text/html");

    expect(parsed.querySelector("script")?.textContent).toContain("rendered");
    expect(parsed.querySelector("base")?.getAttribute("href")).toBe(
      "https://preview.invalid/",
    );
    const policy = parsed
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    expect(policy).toContain("connect-src https: wss:");
    expect(policy).toContain("script-src 'unsafe-inline' https: data:");
    expect(policy).toContain("style-src 'unsafe-inline' https: data:");
    expect(policy).toContain("font-src data: https:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("default-src *");
    const bridge = Array.from(parsed.querySelectorAll("script")).find((node) =>
      (node.textContent ?? "").includes("genehub-preview-diag"),
    );
    const application = parsed.querySelector<HTMLScriptElement>("#application-script");
    expect(bridge?.textContent).toContain('source: "genehub-preview-diag"');
    expect(bridge?.textContent).toContain("securitypolicyviolation");
    expect(bridge?.textContent).toContain('["debug", "log", "info", "warn", "error"]');
    expect(bridge?.textContent).toContain('data.command !== "snapshot-dom"');
    expect(bridge?.textContent).toContain("MutationObserver");
    expect(bridge?.compareDocumentPosition(application!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("pins the iframe to a fixed box so iOS WebKit cannot stretch it to content height", async () => {
    const bytes = new TextEncoder().encode(
      "<!doctype html><html><head><title>t</title></head><body>hello</body></html>",
    );
    const metadata = {
      kind: "html",
      mediaType: "text/html",
      sourceBytes: bytes.byteLength,
    } as AssetPreviewMetadata;
    render(
      <HtmlDocument
        bytes={bytes}
        metadata={metadata}
        entryPath="r_root/index.html"
        fetchAsset={async () => null}
      />,
    );

    const frame = await screen.findByTitle("HTML 文件预览");
    expect(screen.getByRole("button", { name: "截图" })).toBeVisible();
    expect(screen.getByRole("button", { name: "录制" })).toBeVisible();
    expect(screen.getByRole("button", { name: "保存运行产物" })).toBeDisabled();
    expect(frame.className).toContain("absolute");
    expect(frame.className).toContain("inset-0");
    expect(frame.parentElement?.className).toContain("relative");
    expect(frame.parentElement?.className).toContain("overflow-hidden");
  });

  it("accepts diagnostics only from the iframe it rendered", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><html><body>hello</body></html>");
    const metadata = {
      kind: "html",
      mediaType: "text/html",
      sourceBytes: bytes.byteLength,
    } as AssetPreviewMetadata;
    render(
      <HtmlDocument
        bytes={bytes}
        metadata={metadata}
        entryPath="r_root/index.html"
        fetchAsset={async () => null}
      />,
    );
    const frame = await screen.findByTitle<HTMLIFrameElement>("HTML 文件预览");
    const received = vi.fn();
    window.addEventListener("genehub:preview-diagnostic", received);
    const data = {
      source: "genehub-preview-diag",
      kind: "error",
      detail: { message: "render failed" },
    };

    act(() => window.dispatchEvent(new MessageEvent("message", { data, source: window })));
    expect(received).not.toHaveBeenCalled();

    act(() =>
      window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow })),
    );
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0].detail).toEqual({
      kind: "error",
      detail: { surface: "html-preview-iframe", message: "render failed" },
    });
    window.removeEventListener("genehub:preview-diagnostic", received);
  });
});

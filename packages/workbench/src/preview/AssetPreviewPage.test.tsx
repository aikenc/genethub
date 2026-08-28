import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AssetPreviewMetadata } from "@genehub/proto";

import {
  HtmlDocument,
  PreviewTransferSummary,
  isolatedHtml,
} from "./AssetPreviewPage";
import type { RuntimeArtifactSubmission } from "./PreviewRuntimeControls";

describe("Preview transfer facts", () => {
  it("shows five measured entry-file statistics without inventing RTT", () => {
    render(
      <PreviewTransferSummary
        stats={{
          transport: "fabric",
          responseBytes: 32 * 1024 * 1024,
          elapsedMs: 2_730,
          firstByteMs: 210,
          transferMs: 2_560,
          averageBytesPerSecond: 12.5 * 1024 * 1024,
          chunkCount: 2_054,
          largestChunkBytes: 16_340,
        }}
      />,
    );

    expect(screen.getByRole("region", { name: "入口文件传输" })).toBeInTheDocument();
    expect(screen.getByText("Fabric Relay")).toBeInTheDocument();
    expect(screen.getByText("32.0 MiB")).toBeInTheDocument();
    expect(screen.getByText("2.73 s")).toBeInTheDocument();
    expect(screen.getByText("首字节")).toBeInTheDocument();
    expect(screen.getByText("210 ms")).toBeInTheDocument();
    expect(screen.getByText("12.5 MiB/s")).toBeInTheDocument();
    expect(screen.getByText("2,054 个")).toBeInTheDocument();
    expect(screen.getByText("最大 16.0 KiB/片")).toBeInTheDocument();
    expect(screen.getByText(/不展示估算值/)).toBeInTheDocument();
    expect(screen.getByText(/不是 TCP 包/)).toBeInTheDocument();
  });
});

describe("active single-file HTML Preview", () => {
  it("keeps scripts but replaces document-controlled origin and network policy", () => {
    const output = isolatedHtml(`<!doctype html>
      <html><head>
        <base href="https://attacker.example/">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
      </head><body><script id="application-script">globalThis.rendered = true</script></body></html>`);
    const parsed = new DOMParser().parseFromString(output, "text/html");

    expect(parsed.querySelector("#application-script")?.textContent).toContain("rendered");
    expect(parsed.querySelector("base")?.getAttribute("href")).toBe(
      "https://preview.invalid/",
    );
    const policy = parsed
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    expect(policy).toContain("connect-src https: wss: blob: data:");
    expect(policy).toContain("script-src 'unsafe-inline' 'wasm-unsafe-eval' https: data: blob:");
    expect(policy).toContain("worker-src blob: data:");
    expect(policy).toContain("style-src 'unsafe-inline' https: data:");
    expect(policy).toContain("font-src data: blob: https:");
    expect(policy).toContain("img-src data: blob: https:");
    expect(policy).toContain("media-src data: blob: https:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("default-src *");
    const bridge = Array.from(parsed.querySelectorAll("script")).find((node) =>
      (node.textContent ?? "").includes("genehub-preview-diag"),
    );
    const renderer = Array.from(parsed.querySelectorAll("script")).find((node) =>
      (node.textContent ?? "").includes("modernScreenshot"),
    );
    const application = parsed.querySelector<HTMLScriptElement>("#application-script");
    expect(bridge?.textContent).toContain('source: "genehub-preview-diag"');
    expect(bridge?.textContent).toContain("securitypolicyviolation");
    expect(bridge?.textContent).toContain('["debug", "log", "info", "warn", "error"]');
    expect(bridge?.textContent).toContain('data.command === "snapshot-render"');
    expect(bridge?.textContent).toContain('data.command !== "snapshot-dom"');
    expect(bridge?.textContent).toContain("MutationObserver");
    expect(renderer?.textContent).toContain("domToBlob");
    expect(renderer?.compareDocumentPosition(bridge!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(bridge?.compareDocumentPosition(application!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("injects the persistent storage shim ahead of application scripts when seeded", () => {
    const output = isolatedHtml(
      `<!doctype html><html><head></head><body><script id="application-script">void 0</script></body></html>`,
      { score: "7" },
    );
    const parsed = new DOMParser().parseFromString(output, "text/html");
    const scripts = Array.from(parsed.querySelectorAll("script"));
    const bridge = scripts.find((node) =>
      (node.textContent ?? "").includes("genehub-preview-diag"),
    );
    const shim = scripts.find((node) =>
      (node.textContent ?? "").includes("genehub-preview-storage"),
    );
    const application = parsed.querySelector<HTMLScriptElement>("#application-script");
    expect(shim?.textContent).toContain('"score":"7"');
    expect(bridge && shim ? bridge.compareDocumentPosition(shim) : 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(shim && application ? shim.compareDocumentPosition(application) : 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("omits the storage shim when no snapshot is provided", () => {
    const output = isolatedHtml(
      `<!doctype html><html><head></head><body></body></html>`,
    );
    expect(output).not.toContain("genehub-preview-storage");
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

  it("persists frame storage mutations under its namespace and clears them", async () => {
    localStorage.clear();
    const bytes = new TextEncoder().encode("<!doctype html><html><body>game</body></html>");
    const metadata = {
      kind: "html",
      mediaType: "text/html",
      sourceBytes: bytes.byteLength,
    } as AssetPreviewMetadata;
    const onMetaChange = vi.fn();
    render(
      <HtmlDocument
        bytes={bytes}
        metadata={metadata}
        entryPath="r_root/games/index.html"
        storageScope={{ deviceHandle: "machine-a", workspaceHandle: "ws-b" }}
        fetchAsset={async () => null}
        onMetaChange={onMetaChange}
      />,
    );
    const frame = await screen.findByTitle<HTMLIFrameElement>("HTML 文件预览");
    const namespaceKey = "genehub:preview-store:v1:machine-a/ws-b/r_root/games";

    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "genehub-preview-storage", op: "set", key: "score", value: "42" },
          source: frame.contentWindow,
        }),
      ),
    );
    expect(localStorage.getItem(namespaceKey)).toBe('{"score":"42"}');

    const meta = onMetaChange.mock.calls.map((call) => call[0]).filter(Boolean).at(-1);
    expect(meta?.storage?.count).toBe(1);
    act(() => meta?.storage?.onClear());
    expect(localStorage.getItem(namespaceKey)).toBeNull();
  });

  it("ignores storage messages when no scope identifies the preview", async () => {
    localStorage.clear();
    const bytes = new TextEncoder().encode("<!doctype html><html><body>game</body></html>");
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
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "genehub-preview-storage", op: "set", key: "score", value: "42" },
          source: frame.contentWindow,
        }),
      ),
    );
    expect(localStorage.length).toBe(0);
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

  it("collects new-window logs and DOM before saving its own runtime bundle", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><html><body>popout</body></html>");
    const metadata = {
      kind: "html",
      mediaType: "text/html",
      sourceBytes: bytes.byteLength,
      version: "sha256:popout",
    } as AssetPreviewMetadata;
    const onRuntimeReady = vi.fn();
    const submissions: RuntimeArtifactSubmission[] = [];
    const onRuntimeArtifact = vi.fn(async (artifact: RuntimeArtifactSubmission) => {
      submissions.push(artifact);
      return {
        relativePath: "artifacts/260814-091500-abcd",
        addedToDraft: true,
      };
    });
    const user = userEvent.setup();

    render(
      <HtmlDocument
        bytes={bytes}
        metadata={metadata}
        entryPath="r_root/index.html"
        fetchAsset={async () => null}
        onRuntimeArtifact={onRuntimeArtifact}
        onRuntimeReady={onRuntimeReady}
      />,
    );

    const frame = await screen.findByTitle<HTMLIFrameElement>("HTML 文件预览");
    const frameWindow = frame.contentWindow!;
    vi.spyOn(frameWindow, "postMessage").mockImplementation((message: unknown) => {
      const command = message as { command?: string; requestId?: string };
      const detail =
        command.command === "snapshot-render"
          ? {
              blob: new Blob(["popout frame"], { type: "image/webp" }),
              width: 390,
              height: 844,
              capturedAt: Date.now(),
              mode: "dom-render",
            }
          : {
              capturedAt: Date.now(),
              html: "<main>new-window state</main>",
              truncated: false,
              title: "Popout",
              location: "https://preview.invalid/",
              viewportWidth: 390,
              viewportHeight: 844,
              scrollX: 0,
              scrollY: 0,
              activeElement: "body",
              mutationCount: 2,
            };
      const kind = command.command === "snapshot-render" ? "render-snapshot" : "dom-snapshot";
      queueMicrotask(() => {
        act(() =>
          window.dispatchEvent(
            new MessageEvent("message", {
              source: frameWindow,
              data: {
                source: "genehub-preview-runtime",
                kind,
                requestId: command.requestId,
                detail,
              },
            }),
          ),
        );
      });
    });

    fireEvent.load(frame);
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frameWindow,
          data: {
            source: "genehub-preview-diag",
            kind: "log",
            detail: { topic: "html-preview-iframe", phase: "bridge-ready" },
          },
        }),
      ),
    );
    await waitFor(() => expect(onRuntimeReady).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "保存运行产物" })).toBeEnabled();

    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frameWindow,
          data: {
            source: "genehub-preview-diag",
            kind: "console",
            detail: { level: "log", text: "new-window interaction" },
          },
        }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "保存运行产物" }));
    await waitFor(() => expect(onRuntimeArtifact).toHaveBeenCalledTimes(1));

    expect(submissions[0]?.summary).toMatchObject({ eventCount: 2, frameCount: 1 });
    expect(submissions[0]?.files.map((file) => file.name)).toEqual([
      "events.jsonl",
      "dom.jsonl",
      "frame-001.webp",
    ]);
  });
});

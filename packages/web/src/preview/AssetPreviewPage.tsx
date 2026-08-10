import { useCallback, useEffect, useMemo, useState } from "react";

import type { AssetPreviewMetadata } from "@genehub/proto";

import { detectHost, type Endpoint, type Host } from "../host";
import { Client, type AssetPreviewResult, type ProtocolDial } from "../protocol/client";
import { HighlightedCode, languageForPath, Markdown } from "../session/Markdown";
import { readRtcEnabled } from "../settings/rtc";
import { remapHtmlSite } from "./htmlSite";
import type { AssetPreviewLocation } from "./url";

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; result: AssetPreviewResult; client: Client }
  | { kind: "error"; message: string };

export type PreviewMeta = {
  documentTitle: string | null;
  infoLines: string[];
};

export function AssetPreviewPage({
  source,
  host = detectHost(),
  chrome = "page",
  client: sharedClient = null,
  onMetaChange,
}: {
  source: AssetPreviewLocation;
  host?: Host;
  /** `embedded` omits page chrome when hosted inside the workbench float. */
  chrome?: "page" | "embedded";
  /**
   * Workbench float must reuse the live Client. Opening a second Fabric
   * session here closes the workbench socket and, under reconnect, storms the
   * control plane ("too many connection attempts").
   */
  client?: Client | null;
  onMetaChange?: (meta: PreviewMeta | null) => void;
}) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [pageInfoOpen, setPageInfoOpen] = useState(false);
  const [meta, setMeta] = useState<PreviewMeta | null>(null);

  const reportMeta = useCallback(
    (next: PreviewMeta | null) => {
      setMeta(next);
      onMetaChange?.(next);
    },
    [onMetaChange],
  );

  useEffect(() => {
    reportMeta(null);
    setPageInfoOpen(false);
  }, [source.path, source.workspaceHandle, source.deviceHandle, reportMeta]);

  useEffect(() => {
    let cancelled = false;
    let owned: Client | null = null;
    setState({ kind: "loading" });
    emitPreviewDiagnostic("log", {
      topic: "preview-load",
      path: source.path,
      workspaceHandle: source.workspaceHandle,
      deviceHandle: source.deviceHandle,
      phase: "start",
      shared: Boolean(sharedClient),
    });
    void (async () => {
      try {
        let active: Client;
        if (sharedClient) {
          if (sharedClient.identity?.machineId !== source.deviceHandle) {
            throw new Error("当前连接的设备与预览目标不一致");
          }
          active = sharedClient;
        } else {
          const endpoint =
            (await endpointForDevice(host, source.deviceHandle)) ??
            (await host.endpoint());
          if (!endpoint) throw new Error("这台浏览器尚未获准连接资源所在的设备");
          owned = connect(endpoint, host, source.deviceHandle);
          await ready(owned);
          if (owned.identity?.machineId !== source.deviceHandle) {
            throw new Error("链接指向的设备与当前连接不一致");
          }
          active = owned;
        }
        const result = await active.preview(source.workspaceHandle, source.path);
        if (cancelled) {
          owned?.close();
          return;
        }
        emitPreviewDiagnostic("log", {
          topic: "preview-load",
          path: source.path,
          kind: result.metadata.kind,
          sourceBytes: result.metadata.sourceBytes,
          phase: "ready",
          shared: Boolean(sharedClient),
        });
        setState({ kind: "ready", result, client: active });
        // Dialed clients stay in `owned` so effect cleanup closes them. Shared
        // workbench clients must never be closed from Preview.
      } catch (error) {
        owned?.close();
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "无法预览这个文件";
          emitPreviewDiagnostic("error", {
            message,
            path: source.path,
            phase: "load-failed",
          });
          setState({
            kind: "error",
            message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      owned?.close();
    };
  }, [host, sharedClient, source.deviceHandle, source.path, source.workspaceHandle]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
      {chrome === "page" ? (
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <button
            type="button"
            aria-label="查看预览信息"
            title="查看预览信息"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
            onClick={() => setPageInfoOpen(true)}
          >
            <PageInfoIcon />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{source.path}</span>
          <span className="shrink-0 text-[11px] text-faint">{source.workspaceHandle}</span>
        </header>
      ) : null}
      {state.kind === "loading" ? (
        <p role="status" className="m-auto text-sm text-muted">正在安全读取文件…</p>
      ) : state.kind === "error" ? (
        <section role="alert" className="m-auto max-w-lg px-6 text-center">
          <p className="text-sm">无法预览</p>
          <p className="mt-2 text-xs text-muted">{state.message}</p>
        </section>
      ) : (
        <PreviewDocument
          result={state.result}
          path={source.path}
          deviceHandle={source.deviceHandle}
          workspaceHandle={source.workspaceHandle}
          client={state.client}
          onMetaChange={reportMeta}
        />
      )}
      {chrome === "page" && pageInfoOpen ? (
        <EmbeddedInfoDialog
          path={source.path}
          title={meta?.documentTitle?.trim() || basenamePath(source.path)}
          lines={meta?.infoLines ?? ["预览信息尚未就绪，请稍候再打开。"]}
          onClose={() => setPageInfoOpen(false)}
        />
      ) : null}
    </main>
  );
}

function PreviewDocument({
  result,
  path,
  deviceHandle,
  workspaceHandle,
  client,
  onMetaChange,
}: {
  result: AssetPreviewResult;
  path: string;
  deviceHandle: string;
  workspaceHandle: string;
  client: Client;
  onMetaChange?: (meta: PreviewMeta | null) => void;
}) {
  const { metadata, bytes } = result;
  const rootHandle = path.split("/")[0] ?? "";
  const loadPreview = useCallback(
    async (assetPath: string) => {
      try {
        const loaded = await client.preview(workspaceHandle, assetPath);
        return { bytes: loaded.bytes, mediaType: loaded.metadata.mediaType };
      } catch {
        return null;
      }
    },
    [client, workspaceHandle],
  );

  useEffect(() => {
    if (metadata.kind === "html") return;
    onMetaChange?.({
      documentTitle: null,
      infoLines: [
        `类型：${metadata.kind}`,
        `媒体类型：${metadata.mediaType}`,
        `大小：${metadata.sourceBytes} bytes`,
        "单文件预览（无静态站点重写）",
      ],
    });
  }, [metadata, onMetaChange]);

  if (metadata.kind === "markdown") {
    return (
      <article className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8 sm:py-10">
          <Markdown
            text={decodeText(bytes)}
            variant="document"
            artifact={{
              deviceHandle,
              workspaceHandle,
              folders: [{ root: "", rootHandle }],
              documentPath: path,
              loadPreview,
            }}
          />
        </div>
      </article>
    );
  }
  if (metadata.kind === "text") {
    return (
      <HighlightedCode
        text={decodeText(bytes)}
        language={languageForPath(path)}
        document
      />
    );
  }
  if (metadata.kind === "html") {
    return (
      <HtmlDocument
        bytes={bytes}
        metadata={metadata}
        entryPath={path}
        fetchAsset={loadPreview}
        onMetaChange={onMetaChange}
      />
    );
  }
  return <BlobDocument bytes={bytes} metadata={metadata} />;
}

function BlobDocument({
  bytes,
  metadata,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
}) {
  const url = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: metadata.mediaType }),
      ),
    [bytes, metadata.mediaType],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return metadata.kind === "image" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-4">
      <img src={url} alt="预览" className="max-h-full max-w-full object-contain" />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
      <video src={url} controls className="max-h-full max-w-full" />
    </div>
  );
}

/** Exported for tests. */
export function HtmlDocument({
  bytes,
  metadata,
  entryPath,
  fetchAsset,
  onMetaChange,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
  entryPath: string;
  fetchAsset: (path: string) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;
  onMetaChange?: (meta: PreviewMeta | null) => void;
}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const blobUrls: string[] = [];
    setSrcDoc(null);
    onMetaChange?.({
      documentTitle: extractHtmlTitle(decodeText(bytes)),
      infoLines: ["正在解析静态资源…"],
    });
    void (async () => {
      const sourceHtml = decodeText(bytes);
      const documentTitle = extractHtmlTitle(sourceHtml);
      try {
        const remapped = await remapHtmlSite({
          entryPath,
          html: sourceHtml,
          fetchAsset,
        });
        blobUrls.push(...remapped.blobUrls);
        if (cancelled) {
          for (const url of blobUrls) URL.revokeObjectURL(url);
          return;
        }
        const infoLines = [
          "模式：静态多文件（内联 CSS/JS，媒体 data:）",
          "动态加载（fetch / import）不可用",
          "网络：已开启（https / wss）",
          `源文件大小：${metadata.sourceBytes} bytes`,
          remapped.warnings.length > 0
            ? `未加载资源：${remapped.warnings.length} 个`
            : "未加载资源：0",
          ...remapped.warnings.slice(0, 40).map((warning) => `· ${warning}`),
        ];
        setSrcDoc(isolatedHtml(remapped.html));
        onMetaChange?.({ documentTitle, infoLines });
        emitPreviewDiagnostic("log", {
          topic: "html-site",
          path: entryPath,
          warnings: remapped.warnings.length,
          status: infoLines.join(" · ").slice(0, 500),
          phase: "remapped",
        });
        for (const warning of remapped.warnings.slice(0, 20)) {
          emitPreviewDiagnostic("resource", {
            path: entryPath,
            message: warning.slice(0, 500),
            phase: "remap-warning",
          });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "资源解析失败";
          setSrcDoc(isolatedHtml(sourceHtml));
          onMetaChange?.({
            documentTitle,
            infoLines: [
              "模式：单文件回退",
              "网络：已开启（https / wss）",
              `源文件大小：${metadata.sourceBytes} bytes`,
              `说明：${message}`,
            ],
          });
          emitPreviewDiagnostic("error", {
            path: entryPath,
            message,
            phase: "remap-fallback",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const url of blobUrls) URL.revokeObjectURL(url);
    };
  }, [bytes, entryPath, fetchAsset, metadata.sourceBytes, onMetaChange]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {srcDoc ? (
        // iOS WebKit stretches a srcDoc iframe to its content height, ignoring
        // flex sizing; the page then scrolls under the reader's finger and
        // 100vh content stops meaning the viewport. Pinning the iframe to an
        // absolutely-sized box is the only reliable constraint.
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <iframe
            title="HTML 文件预览"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; display-capture 'none'; fullscreen 'none'; presentation 'none'"
            srcDoc={srcDoc}
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        </div>
      ) : (
        <p role="status" className="m-auto text-sm text-muted">
          正在准备 HTML 预览…
        </p>
      )}
    </div>
  );
}

function extractHtmlTitle(html: string): string | null {
  const title = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("title")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return title || null;
}

function basenamePath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function EmbeddedInfoDialog({
  path,
  title,
  lines,
  onClose,
}: {
  path: string;
  title: string;
  lines: string[];
  onClose(): void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="presentation"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="预览信息"
        className="flex max-h-[min(80vh,36rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">预览信息</h2>
          <button
            type="button"
            aria-label="关闭信息"
            className="rounded px-2 text-lg leading-none text-muted hover:bg-raised"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          <dl className="space-y-2 text-xs">
            <div>
              <dt className="text-faint">标题</dt>
              <dd className="break-words text-fg">{title}</dd>
            </div>
            <div>
              <dt className="text-faint">路径</dt>
              <dd className="break-all font-mono text-fg">{path}</dd>
            </div>
          </dl>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted">
            {lines.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function PageInfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 7v4.5M8 5.25h.01"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function isolatedHtml(source: string): string {
  const document_ = new DOMParser().parseFromString(source, "text/html");
  document_.querySelectorAll("base, meta[http-equiv]").forEach((node) => {
    if (
      node.tagName.toLowerCase() === "base" ||
      node.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy"
    ) {
      node.remove();
    }
  });
  const policy = document_.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = [
    "default-src 'none'",
    "script-src 'unsafe-inline' https: data:",
    "style-src 'unsafe-inline' https: data:",
    "img-src data: https:",
    "media-src data: https:",
    "font-src data: https:",
    "connect-src https: wss:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri https://preview.invalid",
    "navigate-to 'none'",
  ].join("; ");
  const base = document_.createElement("base");
  base.href = "https://preview.invalid/";
  document_.head.prepend(base);
  document_.head.prepend(policy);
  // Opaque sandboxed iframe consoles never reach the parent recorder. Bridge
  // load/CSP/script failures out via postMessage so feedback can see them.
  const bridge = document_.createElement("script");
  bridge.textContent = PREVIEW_DIAG_BRIDGE;
  document_.documentElement.appendChild(bridge);
  return `<!doctype html>\n${document_.documentElement.outerHTML}`;
}

/** Keep in sync with console/src/diagnostics.ts PREVIEW_MESSAGE_SOURCE. */
const PREVIEW_DIAG_SOURCE = "genehub-preview-diag";

const PREVIEW_DIAG_BRIDGE = `(function(){
  function send(kind, detail){
    try {
      parent.postMessage({ source: ${JSON.stringify(PREVIEW_DIAG_SOURCE)}, kind: kind, detail: detail || {} }, "*");
    } catch (e) {}
  }
  window.addEventListener("error", function(e){
    var t = e.target;
    if (t && t !== window && t.tagName) {
      send("resource", {
        tag: String(t.tagName).toLowerCase(),
        src: String(t.currentSrc || t.src || t.href || "").slice(0, 500),
        message: "resource load failed"
      });
      return;
    }
    send("error", {
      message: String(e.message || "error").slice(0, 500),
      source: String(e.filename || "").slice(0, 500),
      line: e.lineno || 0,
      column: e.colno || 0
    });
  }, true);
  window.addEventListener("unhandledrejection", function(e){
    var reason = e.reason;
    send("error", {
      message: String(reason && reason.message ? reason.message : reason).slice(0, 500)
    });
  });
  window.addEventListener("securitypolicyviolation", function(e){
    send("csp", {
      violatedDirective: String(e.violatedDirective || "").slice(0, 200),
      effectiveDirective: String(e.effectiveDirective || "").slice(0, 200),
      blockedURI: String(e.blockedURI || "").slice(0, 500),
      disposition: String(e.disposition || ""),
      sample: String(e.sample || "").slice(0, 200)
    });
  });
  ["warn", "error"].forEach(function(level){
    var original = console[level].bind(console);
    console[level] = function(){
      var text = Array.prototype.slice.call(arguments).map(function(arg){
        return typeof arg === "string" ? arg : (function(){ try { return JSON.stringify(arg); } catch (e) { return String(arg); } })();
      }).join(" ").slice(0, 500);
      send("console", { level: level, text: text });
      return original.apply(console, arguments);
    };
  });
  send("log", { topic: "html-preview-iframe", phase: "bridge-ready" });
})();`;

function emitPreviewDiagnostic(
  kind: string,
  detail: Record<string, string | number | boolean | null>,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("genehub:preview-diagnostic", { detail: { kind, detail } }),
  );
}

async function endpointForDevice(host: Host, machineId: string): Promise<Endpoint | null> {
  if (!host.targets || !host.openTarget) return null;
  const target = (await host.targets()).find(
    (candidate) => (candidate.deviceHandle ?? candidate.id) === machineId,
  );
  return target ? host.openTarget(target.id) : null;
}

function connect(endpoint: Endpoint, host: Host, deviceHandle: string): Client {
  const client = new Client({
    ...dial(endpoint),
    credential: endpoint.credential,
    rtcEnabled: readRtcEnabled(),
    redial: async () => {
      const fresh =
        (await endpointForDevice(host, deviceHandle)) ??
        (await host.endpoint());
      if (!fresh) throw new Error("资源所在设备已离线");
      return dial(fresh);
    },
  });
  client.connect();
  return client;
}

function dial(endpoint: Endpoint): ProtocolDial {
  return {
    url: endpoint.url,
    fabricRouteTicket: endpoint.fabricRouteTicket,
    channelCredential: endpoint.channelCredential,
    localServerProof: endpoint.localServerProof,
  };
}

function ready(client: Client): Promise<void> {
  if (client.connectionState === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error("连接资源所在设备超时"));
    }, 15_000);
    stop = client.onStateChange((state) => {
      if (state === "ready") {
        clearTimeout(timer);
        stop();
        resolve();
      } else if (state === "closed") {
        clearTimeout(timer);
        stop();
        reject(new Error(client.failure?.message ?? "资源所在设备拒绝了连接"));
      }
    });
  });
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

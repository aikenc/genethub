import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssetPreviewMetadata, SessionArtifactBundle } from "@genehub/proto";
import modernScreenshotSource from "modern-screenshot/dist/index.js?raw";

import { emitClientDiagnostic, registerDiagnosticClient } from "../diagnostics";
import { detectHost, type Endpoint, type Host } from "../host";
import { Client, type AssetPreviewResult, type ProtocolDial } from "../protocol/client";
import { HighlightedCode, languageForPath, Markdown } from "../session/Markdown";
import { readRtcEnabled } from "../settings/rtc";
import { remapHtmlSite, resolveRuntimeAssetPath } from "./htmlSite";
import {
  PreviewRuntimeControls,
  type PreviewDomSnapshot,
  type PreviewRuntimeEvent,
  type RuntimeArtifactSubmit,
} from "./PreviewRuntimeControls";
import type { PixelSnapshot } from "./runtimeCapture";
import type { AssetPreviewLocation } from "./url";
import { uploadSessionArtifact } from "./sessionArtifactUpload";

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
  onRuntimeArtifact,
  runtimeSessionId = null,
  onRuntimeArtifactSaved,
  onRuntimeReady,
}: {
  source: AssetPreviewLocation;
  host?: Host;
  /** `embedded` omits page chrome when hosted inside the workbench float. */
  chrome?: "page" | "embedded";
  /**
   * Workbench float and its same-origin popout reuse the live Client. Opening
   * a second Fabric session closes the workbench socket and, under reconnect,
   * storms the control plane ("too many connection attempts").
   */
  client?: Client | null;
  onMetaChange?: (meta: PreviewMeta | null) => void;
  /** Persists runtime files to the daemon-owned active session bundle. */
  onRuntimeArtifact?: RuntimeArtifactSubmit;
  /** Session carried by a standalone Preview link opened from the workbench. */
  runtimeSessionId?: string | null;
  /** Reports a standalone upload back to the originating workbench window. */
  onRuntimeArtifactSaved?: (bundle: SessionArtifactBundle) => void;
  /** Fires when the HTML diagnostic bridge can collect logs and DOM state. */
  onRuntimeReady?: () => void;
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
    let unregisterDiagnosticClient: (() => void) | null = null;
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
          unregisterDiagnosticClient = registerDiagnosticClient(owned);
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
        unregisterDiagnosticClient?.();
        unregisterDiagnosticClient = null;
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
      unregisterDiagnosticClient?.();
      owned?.close();
    };
  }, [host, sharedClient, source.deviceHandle, source.path, source.workspaceHandle]);

  const submitStandaloneArtifact = useCallback<RuntimeArtifactSubmit>(
    async (artifact, onProgress) => {
      if (state.kind !== "ready" || !runtimeSessionId) {
        throw new Error("这个 Preview 没有关联可保存运行产物的会话");
      }
      const bundle = await uploadSessionArtifact(
        state.client,
        runtimeSessionId,
        artifact,
        ({ uploadedBytes, totalBytes }) => onProgress(uploadedBytes, totalBytes),
      );
      onRuntimeArtifactSaved?.(bundle);
      return {
        relativePath: bundle.relativePath,
        addedToDraft: Boolean(onRuntimeArtifactSaved),
        ...(!onRuntimeArtifactSaved
          ? { draftError: "原会话输入框未连接" }
          : {}),
      };
    },
    [onRuntimeArtifactSaved, runtimeSessionId, state],
  );

  const runtimeArtifactSubmit =
    onRuntimeArtifact ?? (runtimeSessionId ? submitStandaloneArtifact : undefined);

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
          onRuntimeArtifact={runtimeArtifactSubmit}
          runtimeSessionId={runtimeSessionId}
          onRuntimeReady={onRuntimeReady}
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
  onRuntimeArtifact,
  runtimeSessionId,
  onRuntimeReady,
}: {
  result: AssetPreviewResult;
  path: string;
  deviceHandle: string;
  workspaceHandle: string;
  client: Client;
  onMetaChange?: (meta: PreviewMeta | null) => void;
  onRuntimeArtifact?: RuntimeArtifactSubmit;
  runtimeSessionId?: string | null;
  onRuntimeReady?: () => void;
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
              ...(runtimeSessionId ? { sessionId: runtimeSessionId } : {}),
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
        onRuntimeArtifact={onRuntimeArtifact}
        onRuntimeReady={onRuntimeReady}
      />
    );
  }
  if (metadata.kind === "wasm" || metadata.kind === "binary") {
    return (
      <p className="m-auto max-w-lg px-6 text-center text-sm text-muted">
        二进制资源（{metadata.mediaType}，{metadata.sourceBytes} bytes）。请从入口 HTML 打开以运行游戏或站点。
      </p>
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
  onRuntimeArtifact,
  onRuntimeReady,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
  entryPath: string;
  fetchAsset: (path: string) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;
  onMetaChange?: (meta: PreviewMeta | null) => void;
  onRuntimeArtifact?: RuntimeArtifactSubmit;
  onRuntimeReady?: () => void;
}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [collectorReady, setCollectorReady] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const eventsRef = useRef<PreviewRuntimeEvent[]>([]);
  const collectorReadyRef = useRef(false);
  const domRequestsRef = useRef(
    new Map<
      string,
      {
        resolve: (snapshot: PreviewDomSnapshot) => void;
        reject: (error: Error) => void;
        timer: number;
      }
    >(),
  );
  const renderRequestsRef = useRef(
    new Map<
      string,
      {
        resolve: (snapshot: PixelSnapshot) => void;
        reject: (error: Error) => void;
        timer: number;
      }
    >(),
  );

  const requestDomSnapshot = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return Promise.reject(new Error("Preview DOM 尚未就绪"));
    const requestId = previewRequestId();
    return new Promise<PreviewDomSnapshot>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        domRequestsRef.current.delete(requestId);
        reject(new Error("读取 Preview DOM 超时"));
      }, 3_000);
      domRequestsRef.current.set(requestId, { resolve, reject, timer });
      frame.contentWindow?.postMessage(
        {
          source: PREVIEW_RUNTIME_COMMAND_SOURCE,
          command: "snapshot-dom",
          requestId,
        },
        "*",
      );
    });
  }, []);

  const requestRenderedSnapshot = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return Promise.reject(new Error("Preview 画面尚未就绪"));
    const requestId = previewRequestId();
    return new Promise<PixelSnapshot>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        renderRequestsRef.current.delete(requestId);
        reject(new Error("生成 Preview 画面超时"));
      }, 15_000);
      renderRequestsRef.current.set(requestId, { resolve, reject, timer });
      frame.contentWindow?.postMessage(
        {
          source: PREVIEW_RUNTIME_COMMAND_SOURCE,
          command: "snapshot-render",
          requestId,
        },
        "*",
      );
    });
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      const data = payload as {
        source?: string;
        kind?: string;
        requestId?: string;
        detail?: unknown;
      };
      if (data.source === PREVIEW_RUNTIME_SOURCE && data.kind === "dom-snapshot") {
        const pending = data.requestId ? domRequestsRef.current.get(data.requestId) : null;
        if (!pending || !isPreviewDomSnapshot(data.detail)) return;
        clearTimeout(pending.timer);
        domRequestsRef.current.delete(data.requestId!);
        pending.resolve(data.detail);
        return;
      }
      if (data.source === PREVIEW_RUNTIME_SOURCE && data.kind === "render-snapshot") {
        const pending = data.requestId ? renderRequestsRef.current.get(data.requestId) : null;
        if (!pending) return;
        clearTimeout(pending.timer);
        renderRequestsRef.current.delete(data.requestId!);
        if (isPreviewRenderedSnapshot(data.detail)) {
          pending.resolve(data.detail);
        } else {
          pending.reject(new Error(previewRenderError(data.detail)));
        }
        return;
      }
      if (data.source === PREVIEW_ASSET_SOURCE && typeof data.requestId === "string") {
        void (async () => {
          const path = resolveRuntimeAssetPath(entryPath, String((data as { url?: string }).url ?? ""));
          const loaded = path ? await fetchAsset(path) : null;
          const body = loaded ? loaded.bytes.slice().buffer : null;
          frameRef.current?.contentWindow?.postMessage(
            {
              source: PREVIEW_ASSET_SOURCE,
              requestId: data.requestId,
              ok: Boolean(loaded),
              mediaType: loaded?.mediaType ?? "",
              body,
              message: loaded ? "" : "not found",
            },
            "*",
            body ? [body] : [],
          );
        })();
        return;
      }
      if (data.source === PREVIEW_DIAG_SOURCE && isPreviewDiagnosticKind(data.kind)) {
        const detail = isPreviewDiagnosticDetail(data.detail) ? data.detail : {};
        if (
          detail.topic === "html-preview-iframe" &&
          detail.phase === "bridge-ready" &&
          !collectorReadyRef.current
        ) {
          collectorReadyRef.current = true;
          setCollectorReady(true);
        }
        const next = [...eventsRef.current, { at: Date.now(), kind: data.kind, detail }].slice(
          -1_000,
        );
        eventsRef.current = next;
        setEventCount(next.length);
        emitPreviewDiagnostic(data.kind, {
          surface: "html-preview-iframe",
          ...detail,
        });
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      for (const pending of domRequestsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Preview 已关闭"));
      }
      domRequestsRef.current.clear();
      for (const pending of renderRequestsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Preview 已关闭"));
      }
      renderRequestsRef.current.clear();
    };
  }, [entryPath, fetchAsset]);

  useEffect(() => {
    eventsRef.current = [];
    setEventCount(0);
    setFrameReady(false);
    collectorReadyRef.current = false;
    setCollectorReady(false);
  }, [entryPath, metadata.version]);

  useEffect(() => {
    if (frameReady && collectorReady) onRuntimeReady?.();
  }, [collectorReady, frameReady, onRuntimeReady]);

  useEffect(() => {
    let cancelled = false;
    const blobUrls: string[] = [];
    setSrcDoc(null);
    setFrameReady(false);
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
          "模式：多文件站点（内联 CSS/JS/module，媒体 data:）",
          "运行时 fetch / import 已转发到工作区",
          "WASM / Worker：已开启",
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
        <>
          <PreviewRuntimeControls
            frameRef={frameRef}
            ready={frameReady && collectorReady}
            entryPath={entryPath}
            sourceVersion={metadata.version}
            eventsRef={eventsRef}
            eventCount={eventCount}
            requestDomSnapshot={requestDomSnapshot}
            requestRenderedSnapshot={requestRenderedSnapshot}
            onSubmit={onRuntimeArtifact}
          />
          {/* iOS WebKit stretches a srcDoc iframe to its content height,
              ignoring flex sizing. Pin it to an absolutely-sized box. */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <iframe
              ref={frameRef}
              title="HTML 文件预览"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; display-capture 'none'; fullscreen 'none'; presentation 'none'"
              srcDoc={srcDoc}
              onLoad={() => setFrameReady(true)}
              className="absolute inset-0 h-full w-full border-0 bg-white [isolation:isolate]"
            />
          </div>
        </>
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
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' https: data: blob:",
    "style-src 'unsafe-inline' https: data:",
    "img-src data: https:",
    "media-src data: https:",
    "font-src data: https:",
    "connect-src https: wss: blob: data:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src blob: data:",
    "form-action 'none'",
    "base-uri https://preview.invalid",
    "navigate-to 'none'",
  ].join("; ");
  const base = document_.createElement("base");
  base.href = "https://preview.invalid/";
  // Opaque sandboxed iframe events never reach the parent. Install the bridge
  // before application scripts so startup logs/errors and the initial DOM are
  // part of the runtime artifact as well.
  const bridge = document_.createElement("script");
  bridge.textContent = PREVIEW_DIAG_BRIDGE;
  const renderer = document_.createElement("script");
  renderer.textContent = modernScreenshotSource;
  document_.head.prepend(policy, base, renderer, bridge);
  return `<!doctype html>\n${document_.documentElement.outerHTML}`;
}

const PREVIEW_DIAG_SOURCE = "genehub-preview-diag";
const PREVIEW_RUNTIME_SOURCE = "genehub-preview-runtime";
const PREVIEW_RUNTIME_COMMAND_SOURCE = "genehub-preview-runtime-command";
const PREVIEW_ASSET_SOURCE = "genehub-preview-asset";

function isPreviewDiagnosticKind(kind: string | undefined): kind is string {
  return kind === "console" || kind === "error" || kind === "resource" || kind === "csp" || kind === "log";
}

function isPreviewDomSnapshot(value: unknown): value is PreviewDomSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PreviewDomSnapshot>;
  return (
    typeof snapshot.capturedAt === "number" &&
    typeof snapshot.html === "string" &&
    typeof snapshot.truncated === "boolean" &&
    typeof snapshot.viewportWidth === "number" &&
    typeof snapshot.viewportHeight === "number"
  );
}

function isPreviewRenderedSnapshot(value: unknown): value is PixelSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PixelSnapshot> & { error?: unknown };
  return (
    snapshot.error === undefined &&
    snapshot.blob instanceof Blob &&
    snapshot.blob.size > 0 &&
    typeof snapshot.width === "number" &&
    snapshot.width > 0 &&
    typeof snapshot.height === "number" &&
    snapshot.height > 0 &&
    typeof snapshot.capturedAt === "number" &&
    snapshot.mode === "dom-render"
  );
}

function previewRenderError(value: unknown): string {
  if (!value || typeof value !== "object") return "无法生成 Preview 画面";
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error ? error : "无法生成 Preview 画面";
}

function isPreviewDiagnosticDetail(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean",
  );
}

function previewRequestId(): string {
  try {
    return `runtime_${crypto.randomUUID()}`;
  } catch {
    return `runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }
}

const PREVIEW_DIAG_BRIDGE = `(function(){
  var mutationCount = 0;
  var scrollTimer = 0;
  function send(kind, detail){
    try {
      parent.postMessage({ source: ${JSON.stringify(PREVIEW_DIAG_SOURCE)}, kind: kind, detail: detail || {} }, "*");
    } catch (e) {}
  }
  function sendRuntime(kind, requestId, detail){
    try {
      parent.postMessage({ source: ${JSON.stringify(PREVIEW_RUNTIME_SOURCE)}, kind: kind, requestId: requestId, detail: detail || {} }, "*");
    } catch (e) {}
  }
  function text(value, limit){
    var rendered;
    if (typeof value === "string") rendered = value;
    else if (value instanceof Error) rendered = value.name + ": " + value.message;
    else { try { rendered = JSON.stringify(value); } catch (e) { rendered = String(value); } }
    return String(rendered == null ? "" : rendered).slice(0, limit || 500);
  }
  function safeUrl(value){
    var raw = String(value || "");
    try {
      var parsed = new URL(raw, document.baseURI);
      return (parsed.origin === "null" ? "" : parsed.origin) + parsed.pathname;
    } catch (e) {
      return raw.split(/[?#]/)[0].slice(0, 500);
    }
  }
  function targetLabel(target){
    if (!target || !target.tagName) return "unknown";
    var label = String(target.tagName).toLowerCase();
    if (target.id) label += "#" + String(target.id).slice(0, 80);
    if (target.getAttribute && target.getAttribute("role")) label += "[role=" + String(target.getAttribute("role")).slice(0, 80) + "]";
    if (target.getAttribute && target.getAttribute("name")) label += "[name=" + String(target.getAttribute("name")).slice(0, 80) + "]";
    return label.slice(0, 240);
  }
  function captureDom(){
    var root = document.documentElement;
    var clone = root.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("[data-genehub-render-sandbox]"), function(node){ node.remove(); });
    Array.prototype.forEach.call(clone.querySelectorAll("script,style"), function(node){
      node.textContent = "[omitted from runtime DOM snapshot]";
    });
    var originals = root.querySelectorAll("input,textarea,select,option,details,dialog");
    var copies = clone.querySelectorAll("input,textarea,select,option,details,dialog");
    Array.prototype.forEach.call(originals, function(node, index){
      var copy = copies[index];
      if (!copy) return;
      var tag = String(node.tagName || "").toLowerCase();
      if (tag === "input") {
        var type = String(node.type || "text").toLowerCase();
        copy.setAttribute("data-runtime-value", type === "password" ? "[redacted]" : String(node.value || "").slice(0, 500));
        copy.setAttribute("data-runtime-checked", node.checked ? "true" : "false");
      } else if (tag === "textarea") {
        copy.textContent = String(node.value || "").slice(0, 2_000);
      } else if (tag === "select") {
        copy.setAttribute("data-runtime-selected-index", String(node.selectedIndex));
      } else if (tag === "option") {
        if (node.selected) copy.setAttribute("selected", ""); else copy.removeAttribute("selected");
      } else if (tag === "details" || tag === "dialog") {
        copy.setAttribute("data-runtime-open", node.open ? "true" : "false");
      }
    });
    Array.prototype.forEach.call(clone.querySelectorAll("*"), function(node){
      Array.prototype.forEach.call(Array.prototype.slice.call(node.attributes || []), function(attribute){
        var name = String(attribute.name || "");
        var value = String(attribute.value || "");
        if (/password|authorization|access[-_]?token|secret/i.test(name)) {
          node.setAttribute(name, "[redacted]");
        } else if (value.indexOf("data:") === 0 && value.length > 240) {
          node.setAttribute(name, value.slice(0, 80) + "…[data omitted]");
        } else if (value.length > 2_000) {
          node.setAttribute(name, value.slice(0, 2_000) + "…[truncated]");
        }
      });
    });
    var html = "<!doctype html>\\n" + clone.outerHTML;
    var limit = 300000;
    return {
      capturedAt: Date.now(),
      html: html.slice(0, limit),
      truncated: html.length > limit,
      title: String(document.title || "").slice(0, 500),
      location: safeUrl(location.href),
      viewportWidth: window.innerWidth || 0,
      viewportHeight: window.innerHeight || 0,
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
      activeElement: targetLabel(document.activeElement),
      mutationCount: mutationCount
    };
  }
  function captureRenderedFrame(requestId){
    var api = window.modernScreenshot;
    if (!api || typeof api.createContext !== "function" || typeof api.domToBlob !== "function") {
      sendRuntime("render-snapshot", requestId, { error: "Preview 画面采样器未就绪" });
      return;
    }
    var root = document.documentElement;
    var viewportWidth = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1));
    var viewportHeight = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1));
    var edgeScale = 1600 / Math.max(viewportWidth, viewportHeight);
    var scale = Math.max(0.25, Math.min(window.devicePixelRatio || 1, edgeScale));
    var background = "#ffffff";
    try {
      var bodyBackground = document.body ? getComputedStyle(document.body).backgroundColor : "";
      var rootBackground = getComputedStyle(root).backgroundColor;
      background = bodyBackground && bodyBackground !== "rgba(0, 0, 0, 0)" && bodyBackground !== "transparent"
        ? bodyBackground
        : rootBackground && rootBackground !== "rgba(0, 0, 0, 0)" && rootBackground !== "transparent"
          ? rootBackground
          : background;
    } catch (e) {}
    // Descendant iframes inherit this Preview's opaque sandbox origin, so the
    // renderer cannot read its usual style-probe iframe. A hidden shadow root
    // supplies uncontaminated UA default styles without weakening the Preview.
    var sandboxHost = document.createElement("div");
    sandboxHost.setAttribute("data-genehub-render-sandbox", "");
    sandboxHost.style.setProperty("position", "fixed", "important");
    sandboxHost.style.setProperty("left", "-10000px", "important");
    sandboxHost.style.setProperty("top", "-10000px", "important");
    sandboxHost.style.setProperty("width", "1px", "important");
    sandboxHost.style.setProperty("height", "1px", "important");
    sandboxHost.style.setProperty("overflow", "hidden", "important");
    sandboxHost.style.setProperty("visibility", "hidden", "important");
    var sandboxRoot = sandboxHost.attachShadow ? sandboxHost.attachShadow({ mode: "closed" }) : sandboxHost;
    document.documentElement.appendChild(sandboxHost);
    var sandboxDocument = {
      createElement: document.createElement.bind(document),
      createElementNS: document.createElementNS.bind(document),
      body: {
        appendChild: function(node){ return sandboxRoot.appendChild(node); },
        removeChild: function(node){ return sandboxRoot.removeChild(node); }
      }
    };
    var sandboxFrame = {
      contentWindow: {
        document: sandboxDocument,
        getComputedStyle: window.getComputedStyle.bind(window)
      },
      remove: function(){ sandboxHost.remove(); }
    };
    Promise.resolve(api.createContext(root, {
      width: viewportWidth,
      height: viewportHeight,
      scale: scale,
      type: "image/webp",
      quality: 0.78,
      backgroundColor: background,
      maximumCanvasSize: 1600,
      timeout: 10000,
      features: { restoreScrollPosition: true },
      filter: function(node){
        return !(node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-genehub-render-sandbox"));
      },
      autoDestruct: true
    })).then(function(context){
      context.sandbox = sandboxFrame;
      return api.domToBlob(context);
    }).then(function(blob){
      if (!blob || !blob.size) throw new Error("Preview 画面为空");
      sendRuntime("render-snapshot", requestId, {
        blob: blob,
        width: Math.max(1, Math.floor(viewportWidth * scale)),
        height: Math.max(1, Math.floor(viewportHeight * scale)),
        capturedAt: Date.now(),
        mode: "dom-render"
      });
    }).catch(function(error){
      sendRuntime("render-snapshot", requestId, { error: text(error, 500) || "无法生成 Preview 画面" });
    }).finally(function(){
      sandboxHost.remove();
    });
  }
  window.addEventListener("message", function(event){
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== ${JSON.stringify(PREVIEW_RUNTIME_COMMAND_SOURCE)}) return;
    var requestId = String(data.requestId || "");
    if (data.command === "snapshot-render") {
      captureRenderedFrame(requestId);
      return;
    }
    if (data.command !== "snapshot-dom") return;
    try {
      sendRuntime("dom-snapshot", requestId, captureDom());
    } catch (error) {
      sendRuntime("dom-snapshot", requestId, {
        capturedAt: Date.now(), html: "<!-- DOM snapshot failed: " + text(error, 500) + " -->", truncated: false,
        title: String(document.title || ""), location: safeUrl(location.href), viewportWidth: window.innerWidth || 0,
        viewportHeight: window.innerHeight || 0, scrollX: 0, scrollY: 0, activeElement: "unknown", mutationCount: mutationCount
      });
    }
  });
  window.addEventListener("error", function(e){
    var t = e.target;
    if (t && t !== window && t.tagName) {
      send("resource", {
        tag: String(t.tagName).toLowerCase(),
        src: safeUrl(t.currentSrc || t.src || t.href || ""),
        message: "resource load failed"
      });
      return;
    }
    send("error", {
      message: text(e.message || "error", 500),
      source: safeUrl(e.filename || ""),
      line: e.lineno || 0,
      column: e.colno || 0
    });
  }, true);
  window.addEventListener("unhandledrejection", function(e){
    send("error", { message: text(e.reason, 500) });
  });
  window.addEventListener("securitypolicyviolation", function(e){
    send("csp", {
      violatedDirective: text(e.violatedDirective, 200),
      effectiveDirective: text(e.effectiveDirective, 200),
      blockedURI: safeUrl(e.blockedURI),
      disposition: text(e.disposition, 80),
      sampleLength: String(e.sample || "").length
    });
  });
  ["debug", "log", "info", "warn", "error"].forEach(function(level){
    var original = console[level] && console[level].bind(console);
    if (!original) return;
    console[level] = function(){
      var rendered = Array.prototype.slice.call(arguments).map(function(arg){ return text(arg, 500); }).join(" ").slice(0, 1000);
      send("console", { level: level, text: rendered });
      return original.apply(console, arguments);
    };
  });
  function shouldInterceptAsset(url){
    try {
      return new URL(String(url || ""), document.baseURI).hostname === "preview.invalid";
    } catch (e) {
      return false;
    }
  }
  function requestPreviewAsset(url){
    var requestId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    return new Promise(function(resolve, reject){
      function onMessage(event){
        if (event.source !== parent) return;
        var data = event.data;
        if (!data || data.source !== ${JSON.stringify(PREVIEW_ASSET_SOURCE)} || data.requestId !== requestId) return;
        window.removeEventListener("message", onMessage);
        if (!data.ok || !data.body) {
          reject(new Error(data.message || "asset load failed"));
          return;
        }
        resolve(new Response(data.body, {
          status: 200,
          headers: { "Content-Type": data.mediaType || "application/octet-stream" }
        }));
      }
      window.addEventListener("message", onMessage);
      parent.postMessage({ source: ${JSON.stringify(PREVIEW_ASSET_SOURCE)}, requestId: requestId, url: String(url || "") }, "*");
      setTimeout(function(){
        window.removeEventListener("message", onMessage);
        reject(new Error("asset load timed out"));
      }, 60000);
    });
  }
  if (window.fetch) {
    var originalFetch = window.fetch;
    window.fetch = function(){
      var args = arguments;
      var started = Date.now();
      var input = args[0];
      var method = text((args[1] && args[1].method) || (input && input.method) || "GET", 20).toUpperCase();
      var rawUrl = (input && input.url) || input;
      var url = safeUrl(rawUrl);
      var pending = shouldInterceptAsset(rawUrl) ? requestPreviewAsset(rawUrl) : originalFetch.apply(window, args);
      return pending.then(function(response){
        send("log", { topic: "network", transport: "fetch", method: method, url: url, status: response.status || 0, durationMs: Date.now() - started });
        return response;
      }, function(error){
        send("error", { topic: "network", transport: "fetch", method: method, url: url, message: text(error, 500), durationMs: Date.now() - started });
        throw error;
      });
    };
  }
  if (window.XMLHttpRequest) {
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){
      this.__genehubMethod = text(method || "GET", 20).toUpperCase();
      this.__genehubUrl = safeUrl(url);
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(){
      var xhr = this;
      var started = Date.now();
      xhr.addEventListener("loadend", function(){
        send(xhr.status >= 400 || xhr.status === 0 ? "error" : "log", {
          topic: "network", transport: "xhr", method: xhr.__genehubMethod || "GET", url: xhr.__genehubUrl || "",
          status: xhr.status || 0, durationMs: Date.now() - started
        });
      }, { once: true });
      return xhrSend.apply(this, arguments);
    };
  }
  ["click", "input", "change"].forEach(function(type){
    document.addEventListener(type, function(event){
      var target = event.target;
      var detail = { topic: "interaction", action: type, target: targetLabel(target) };
      if (type !== "click" && target) {
        detail.inputType = text(target.type || target.tagName || "", 80);
        detail.valueLength = typeof target.value === "string" ? target.value.length : 0;
        detail.checked = typeof target.checked === "boolean" ? target.checked : null;
      }
      send("log", detail);
    }, true);
  });
  document.addEventListener("keydown", function(event){
    var allowed = /^(Enter|Escape|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;
    send("log", { topic: "interaction", action: "keydown", key: allowed.test(event.key) ? event.key : "character", target: targetLabel(event.target) });
  }, true);
  window.addEventListener("scroll", function(){
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(function(){
      scrollTimer = 0;
      send("log", { topic: "interaction", action: "scroll", x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) });
    }, 200);
  }, true);
  ["pushState", "replaceState"].forEach(function(method){
    var original = history[method];
    history[method] = function(){
      var result = original.apply(history, arguments);
      send("log", { topic: "navigation", action: method, url: safeUrl(location.href) });
      return result;
    };
  });
  window.addEventListener("hashchange", function(){ send("log", { topic: "navigation", action: "hashchange", url: safeUrl(location.href) }); });
  window.addEventListener("popstate", function(){ send("log", { topic: "navigation", action: "popstate", url: safeUrl(location.href) }); });
  try {
    new MutationObserver(function(records){ mutationCount += records.length; }).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true
    });
  } catch (e) {}
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
    onDiagnostic: emitClientDiagnostic,
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

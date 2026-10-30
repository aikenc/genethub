import { previewFeedback, useFileFeedback, type FileFeedbackReview } from "./fileFeedback";
import { PreviewFeedbackPanel } from "./PreviewFeedbackPanel";
import { PreviewShareButton, PreviewShareCopyButton } from "./PreviewShareButton";
import { PreviewFileFeedbackOpenContext, PreviewShareOpenContext } from "./PreviewToolbar";
import type { PreviewSourceInfo } from "@genehub/proto";
import { ServicePreviewClient, classifyServiceFailure, htmlServiceMedia } from "./serviceClient";
import { previewServiceInfo, PreviewServiceSection, type PreviewServiceInfo, type ServiceMark } from "./ServiceStatusMenu";
import { ServiceMediaPanel } from "./ServiceMediaPanel";
import { serviceBridgeScript, useServiceBridge, type ServiceBridgePolicy } from "./serviceBridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssetPreviewMetadata, SessionArtifactBundle } from "@genehub/proto";
import modernScreenshotSource from "modern-screenshot/dist/index.js?raw";

import { emitClientDiagnostic, registerDiagnosticClient } from "../diagnostics";
import { detectHost, type Endpoint, type Host } from "../host";
import {
  Client,
  AssetPreviewError_,
  type AssetPreviewResult,
  type AssetPreviewTransferStats,
  type ProtocolDial,
} from "../protocol/client";
import { HighlightedCode, languageForPath, Markdown } from "../session/Markdown";
import { loadSessionImage } from "../session/imagePreviewRequests";
import { HtmlAnnotationOverlay, ImageAnnotationLayer, PreviewReviewChrome } from "./PreviewAnnotation";
import { readRtcEnabled } from "../settings/rtc";
import { remapHtmlSite, resolveRuntimeAssetPath, resolveSiteReference, virtualFileUrl } from "./htmlSite";
import {
  applyPreviewStoreMutation,
  clearPreviewStore,
  loadPreviewStore,
  parsePreviewStoreMutation,
  PREVIEW_STORAGE_SOURCE,
  previewStorageNamespace,
  previewStorageShimSource,
  type PreviewStorageScope,
} from "./storage";
import {
  PreviewRuntimeControls,
  ProductFeedbackOverflow,
  type PreviewDomSnapshot,
  type PreviewRuntimeEvent,
  type RuntimeArtifactSubmit,
} from "./PreviewRuntimeControls";
import type { PixelSnapshot } from "./runtimeCapture";
import { isAbsoluteFilePath, type AssetPreviewLocation } from "./url";
import { uploadSessionArtifact } from "./sessionArtifactUpload";
import { PreviewToolbarContext, PreviewToolbarPortal } from "./PreviewToolbar";

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; result: AssetPreviewResult; client: Client }
  | { kind: "legacy-image"; client: Client }
  | { kind: "error"; message: string };

export type PreviewMeta = {
  location?: Pick<AssetPreviewLocation, "path" | "docQuery" | "docFragment" | "siteEntryPath">;
  sourceInfo?: PreviewSourceInfo;
  resourcePaths?: Set<string>;
  documentTitle: string | null;
  infoLines: string[];
  /** Measured entry-file transfer facts shared by page and float chrome. */
  transfer?: AssetPreviewTransferStats;
  /**
   * Sandbox storage shim state, when the preview persists localStorage through
   * the parent. `onClear` wipes both the parent-side store and the live frame.
   */
  storage?: { count: number; onClear: () => void };
  /** Local service registration for this HTML file, shown in 预览信息. */
  service?: PreviewServiceInfo | null;
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
  annotationWrite = false,
  toolbarTarget = null,
  shareAccess = false,
  feedbackAccessScope = "owner",
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
  /** Fullscreen workbench preview and same-origin popout may write. Shared links save to file feedback. */
  annotationWrite?: boolean;
  toolbarTarget?: HTMLElement | null;
  shareAccess?: boolean;
  feedbackAccessScope?: string;
}) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const resources = useRef(new Set<string>());
  const [feedbackSource, setFeedbackSource] = useState<{path: string; version: string} | null>(null);
  const [folders, setFolders] = useState<Array<{root: string; rootHandle: string}>>([]);
  const [sourceInfo, setSourceInfo] = useState<PreviewSourceInfo | null>(null);
  const [pageInfoOpen, setPageInfoOpen] = useState(false);
  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const legacyAbort = useRef<AbortController | null>(null);
  const [pageToolbarTarget, setPageToolbarTarget] = useState<HTMLDivElement | null>(null);
  const serviceRef = useRef<PreviewServiceInfo | null>(null);
  const metaRef = useRef<PreviewMeta | null>(null);

  const publishMeta = useCallback(
    (next: PreviewMeta | null) => {
      metaRef.current = next;
      setMeta(next);
      onMetaChange?.(next);
    },
    [onMetaChange],
  );

  const reportMeta = useCallback(
    (next: PreviewMeta | null) => {
      const merged = next
        ? { ...next, resourcePaths: resources.current, ...(sourceInfo ? { sourceInfo } : {}), service: serviceRef.current }
        : null;
      publishMeta(merged);
    },
    [publishMeta, sourceInfo],
  );

  const reportService = useCallback(
    (service: PreviewServiceInfo | null) => {
      serviceRef.current = service;
      if (!metaRef.current) return;
      publishMeta({ ...metaRef.current, service });
    },
    [publishMeta],
  );

  useEffect(() => {
    legacyAbort.current?.abort();
    legacyAbort.current = null;
    serviceRef.current = null;
    publishMeta(null);
    setPageInfoOpen(false);
  }, [source.path, source.workspaceHandle, source.deviceHandle, publishMeta]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let owned: Client | null = null;
    let unregisterDiagnosticClient: (() => void) | null = null;
    setState({ kind: "loading" });
    setSourceInfo(null);
    setFeedbackSource(null);
    resources.current = new Set([source.path]);
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
        const imageFile = /\.(?:png|jpe?g|gif|webp)$/i.test(source.path);
        if (imageFile && !active.identity?.features?.includes("asset.preview.image.v1")) {
          setState({ kind: "legacy-image", client: active });
          return;
        }
        const result = await active.preview(
          source.workspaceHandle,
          source.path,
          imageFile ? "image-1024" : "original",
          abort.signal,
        );
        // Only linked v2 documents need the catalogue mapping. Images and
        // representation negotiation must not depend on project-list access.
        if (!isAbsoluteFilePath(source.path) && !shareAccess && ["html", "markdown"].includes(result.metadata.kind)) {
          const reply = await active.call({type: "workspace.list"}).catch(() => null);
          if (!cancelled && reply?.type === "workspaces") setFolders(reply.data.find(w => w.id === source.workspaceHandle)?.folders ?? []);
        }
        if (active.identity?.features?.includes("preview.feedback.v1")) {
          // Feedback metadata is optional. A workspace-scoped peer can read
          // the file without access to the machine-wide feedback namespace.
          const info = await previewFeedback(active, isAbsoluteFilePath(source.path) ? "" : source.workspaceHandle, { kind: "source", path: source.path }).catch(() => null);
          if (!cancelled && info?.kind === "source") setSourceInfo(info.data);
        }
        if (cancelled) {
          owned?.close();
          return;
        }
        emitPreviewDiagnostic("log", {
          topic: "preview-load",
          path: source.path,
          kind: result.metadata.kind,
          sourceBytes: result.metadata.sourceBytes,
          transport: result.transfer.transport,
          durationMs: Math.round(result.transfer.elapsedMs),
          firstByteMs: result.transfer.firstByteMs,
          averageBytesPerSecond:
            result.transfer.averageBytesPerSecond === null
              ? null
              : Math.round(result.transfer.averageBytesPerSecond),
          chunks: result.transfer.chunkCount,
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
      abort.abort();
      legacyAbort.current?.abort();
      legacyAbort.current = null;
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

  const feedbackClient = state.kind === "ready" ? state.client : null;
  const fileFeedbackEnabled = !!feedbackClient?.identity?.features?.includes("preview.feedback.v1");
  const [openFileFeedback, setOpenFileFeedback] = useState<(() => void) | null>(null);
  const bindFileFeedback = useCallback((open: (() => void) | null) => {
    setOpenFileFeedback(() => open);
  }, []);
  const [openShare, setOpenShare] = useState<(() => void) | null>(null);
  const bindShare = useCallback((open: (() => void) | null) => {
    setOpenShare(() => open);
  }, []);
  const annotatable = state.kind === "ready" && (state.result.metadata.kind === "markdown" || state.result.metadata.kind === "html" || state.result.metadata.kind === "image");
  const feedback = useFileFeedback(feedbackClient, isAbsoluteFilePath(feedbackSource?.path ?? source.path) ? "" : source.workspaceHandle, feedbackSource?.path ?? source.path, feedbackSource?.version ?? (state.kind === "ready" ? state.result.metadata.version : ""), feedbackAccessScope);
  useEffect(() => {
    if (!feedbackClient || !fileFeedbackEnabled || !feedbackSource || feedbackSource.path === source.path) return;
    let cancelled = false;
    void previewFeedback(feedbackClient, isAbsoluteFilePath(feedbackSource.path) ? "" : source.workspaceHandle, {kind: "source", path: feedbackSource.path}).then(reply => {
      if (!cancelled && reply.kind === "source") setSourceInfo(reply.data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [feedbackClient, fileFeedbackEnabled, feedbackSource?.path, source.workspaceHandle, source.path]);
  const submitFileArtifact = useCallback<RuntimeArtifactSubmit>(async (artifact, onProgress) => {
    const bundle = await feedback.upload(artifact, ({ uploadedBytes, totalBytes }) => onProgress(uploadedBytes, totalBytes));
    return { relativePath: bundle.relativePath, addedToDraft: false, feedbackSaved: true };
  }, [feedback.upload]);
  const runtimeArtifactSubmit = fileFeedbackEnabled ? submitFileArtifact :
    onRuntimeArtifact ?? (runtimeSessionId ? submitStandaloneArtifact : undefined);

  return (
    <PreviewFileFeedbackOpenContext.Provider value={fileFeedbackEnabled ? openFileFeedback : null}>
    <PreviewShareOpenContext.Provider value={fileFeedbackEnabled ? openShare : null}>
    <PreviewToolbarContext.Provider value={toolbarTarget ?? pageToolbarTarget}>
    <main className={`${chrome === "page" ? "safe-area-page" : ""} flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg`}>
      {chrome === "page" ? (
        <header aria-label="预览工具栏" className="gh-preview-toolbar relative z-30 flex min-h-9 shrink-0 items-center gap-1 border-b border-line px-2 py-1">
          <button
            type="button"
            aria-label="预览信息"
            title="预览信息"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
            onClick={() => setPageInfoOpen(true)}
          >
            <PageInfoIcon />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{sourceInfo?.displayPath ?? basenamePath(source.path)}</span>
          <div ref={setPageToolbarTarget} className="gh-preview-toolbar-slot flex shrink-0 items-center gap-1 text-xs" />
        </header>
      ) : null}
      {state.kind === "loading" ? (
        <p role="status" className="m-auto text-sm text-muted">正在安全读取文件…</p>
      ) : state.kind === "legacy-image" ? (
        <section className="m-auto max-w-lg px-6 text-center text-sm">
          <p>当前设备不支持图片缩略图预览。</p>
          <button type="button" className="mt-3 rounded border border-line px-3 py-2" onClick={() => {
            const active = state.client;
            const abort = new AbortController();
            legacyAbort.current = abort;
            setState({ kind: "loading" });
            void active.preview(source.workspaceHandle, source.path, "original", abort.signal)
              .then((result) => {
                if (!abort.signal.aborted) setState({ kind: "ready", result, client: active });
              })
              .catch((error) => {
                if (!abort.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "无法读取原图" });
              });
          }}>查看原图</button>
        </section>
      ) : state.kind === "error" ? (
        <section role="alert" className="m-auto max-w-lg px-6 text-center">
          <p className="text-sm">无法预览</p>
          <p className="mt-2 text-xs text-muted">{state.message}</p>
        </section>
      ) : (
        <PreviewDocument
          result={state.result}
          path={source.path}
          folders={folders}
          siteEntryPath={source.siteEntryPath ?? source.path}
          docQuery={source.docQuery}
          docFragment={source.docFragment}
          storageAccessScope={feedbackAccessScope}
          deviceHandle={source.deviceHandle}
          workspaceHandle={source.workspaceHandle}
          client={state.client}
          onMetaChange={reportMeta}
          onRuntimeArtifact={runtimeArtifactSubmit}
          runtimeSessionId={runtimeSessionId}
          onRuntimeReady={onRuntimeReady}
          annotationWrite={fileFeedbackEnabled || annotationWrite}
          fileFeedback={fileFeedbackEnabled ? feedback.review : undefined}
          onSourceChange={setFeedbackSource}
          onServiceChange={reportService}
          resourcePaths={resources.current}
        />
      )}
      {fileFeedbackEnabled ? <PreviewFeedbackPanel feedback={feedback} bindOpen={annotatable ? bindFileFeedback : undefined} showToolbarButton={!annotatable} /> : null}
      {fileFeedbackEnabled && !shareAccess && feedbackClient ? <PreviewShareButton client={feedbackClient} source={{...source, ...meta?.location, path: feedbackSource?.path ?? source.path, siteEntryPath: source.siteEntryPath ?? source.path}} resources={resources.current} trigger={false} bindOpen={bindShare} /> : null}
      {fileFeedbackEnabled && shareAccess ? <PreviewShareCopyButton trigger={false} bindOpen={bindShare} /> : null}
      {chrome === "page" && pageInfoOpen ? (
        <EmbeddedInfoDialog
          path={sourceInfo?.displayPath ?? basenamePath(source.path)}
          absolutePath={sourceInfo ? `${sourceInfo.machineName}：${sourceInfo.absolutePath}` : undefined}
          title={meta?.documentTitle?.trim() || basenamePath(source.path)}
          lines={meta?.infoLines ?? ["预览信息尚未就绪，请稍候再打开。"]}
          transfer={meta?.transfer}
          storage={meta?.storage}
          service={meta?.service}
          onClose={() => setPageInfoOpen(false)}
        />
      ) : null}
    </main>
    </PreviewToolbarContext.Provider>
    </PreviewShareOpenContext.Provider>
    </PreviewFileFeedbackOpenContext.Provider>
  );
}

function PreviewDocument({
  result,
  path,
  folders,
  siteEntryPath,
  docQuery = "",
  docFragment = "",
  storageAccessScope,
  deviceHandle,
  workspaceHandle,
  client,
  onMetaChange,
  onRuntimeArtifact,
  runtimeSessionId,
  onRuntimeReady,
  annotationWrite = false,
  fileFeedback,
  onSourceChange,
  onServiceChange,
  resourcePaths,
}: {
  result: AssetPreviewResult;
  path: string;
  folders: Array<{root: string; rootHandle: string}>;
  siteEntryPath: string;
  docQuery?: string;
  docFragment?: string;
  storageAccessScope: string;
  deviceHandle: string;
  workspaceHandle: string;
  client: Client;
  onMetaChange?: (meta: PreviewMeta | null) => void;
  onRuntimeArtifact?: RuntimeArtifactSubmit;
  runtimeSessionId?: string | null;
  onRuntimeReady?: () => void;
  annotationWrite?: boolean;
  fileFeedback?: FileFeedbackReview;
  onSourceChange?: (source: {path: string; version: string}) => void;
  onServiceChange?: (service: PreviewServiceInfo | null) => void;
  resourcePaths?: Set<string>;
}) {
  type Visit = {path: string; result: AssetPreviewResult; query: string; fragment: string};
  const [history, setHistory] = useState<Visit[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const followGeneration = useRef(0);
  const followAbort = useRef<AbortController | null>(null);
  const documentRef = useRef<HTMLElement | null>(null);
  const scrollPositions = useRef(new Map<number, {x: number; y: number}>());
  const visitKey = Math.max(0, historyIndex);
  const rememberScroll = useCallback((x: number, y: number) => {scrollPositions.current.set(visitKey, {x, y});}, [visitKey]);
  useEffect(() => {
    followGeneration.current += 1;
    followAbort.current?.abort();
    setHistory([]); setHistoryIndex(-1); setLinkProblem(null); scrollPositions.current.clear();
    return () => { followAbort.current?.abort(); };
  }, [path, result]);
  const shown = history[historyIndex] ?? {path, result, query: docQuery, fragment: docFragment};
  const {metadata, bytes, transfer} = shown.result;
  useEffect(() => { onSourceChange?.({path: shown.path, version: metadata.version}); }, [shown.path, metadata.version, onSourceChange]);
  const openFile = useCallback(async (nextPath: string, query = "", fragment = "") => {
    const generation = ++followGeneration.current;
    followAbort.current?.abort();
    const abort = new AbortController(); followAbort.current = abort;
    setLinkProblem(null);
    try {
      const loaded = nextPath === shown.path ? shown.result : await client.preview(workspaceHandle, nextPath, "original", abort.signal);
      if (generation !== followGeneration.current) return;
      const prior = historyIndex < 0 ? [{path, result, query: docQuery, fragment: docFragment}] : history.slice(0, historyIndex + 1);
      setHistory([...prior, {path: nextPath, result: loaded, query, fragment}]);
      setHistoryIndex(prior.length);
      if (nextPath !== shown.path) { resourcePaths?.clear(); resourcePaths?.add(nextPath); }
    } catch (error) {
      if (generation === followGeneration.current && !abort.signal.aborted) setLinkProblem(error instanceof Error ? error.message : "无法打开这个链接");
    }
  }, [client, workspaceHandle, shown, history, historyIndex, path, result, docQuery, docFragment, resourcePaths]);
  const navigateHistory = (next: number) => {
    followGeneration.current += 1; followAbort.current?.abort(); setLinkProblem(null); setHistoryIndex(next);
    resourcePaths?.clear(); if (history[next]) resourcePaths?.add(history[next]!.path);
  };
  useEffect(() => {
    const node = documentRef.current;
    if (!node) return;
    const saved = scrollPositions.current.get(visitKey);
    if (saved) { node.scrollTo(saved.x, saved.y); return; }
    node.scrollTo(0, 0);
    let id: string; try { id = decodeURIComponent(shown.fragment.replace(/^#/, "")); } catch { return; }
    if (id) Array.from(node.querySelectorAll("[id]")).find(target => target.id === id)?.scrollIntoView();
  }, [shown.path, shown.fragment, metadata.kind, visitKey]);
  const publishDocumentMeta = useCallback((meta: PreviewMeta | null) => {
    onMetaChange?.(meta ? {...meta, location: {path: shown.path, docQuery: shown.query, docFragment: shown.fragment, siteEntryPath}} : null);
  }, [onMetaChange, shown.path, shown.query, shown.fragment, siteEntryPath]);
  const rootHandle = path.split("/")[0] ?? "";
  const loadPreview = useCallback(
    async (assetPath: string, signal?: AbortSignal) => {
      try {
        const loaded = await client.preview(workspaceHandle, assetPath, "original", signal);
        resourcePaths?.add(assetPath);
        return { bytes: loaded.bytes, mediaType: loaded.metadata.mediaType, status: 200 };
      } catch (error) {
        if (signal?.aborted) throw error;
        const status = error instanceof AssetPreviewError_ ? error.status : 503;
        return {bytes: new TextEncoder().encode(error instanceof Error ? error.message : "资源读取失败"), mediaType: "text/plain", status};
      }
    },
    [client, workspaceHandle, resourcePaths],
  );
  const loadInlineImage = useCallback(
    (assetPath: string, signal?: AbortSignal) =>
      loadSessionImage(client, workspaceHandle, assetPath, signal),
    [client, workspaceHandle],
  );
  // Only markdown/text are UTF-8. Decoding a PNG here crashed the workbench.
  const text = useMemo(() => {
    if (metadata.kind !== "markdown" && metadata.kind !== "text") return "";
    return decodeText(bytes);
  }, [bytes, metadata.kind]);
  const artifact = useMemo(
    () => ({
      deviceHandle,
      workspaceHandle,
      folders: folders.length ? folders : [{ root: "", rootHandle }],
      documentPath: shown.path,
      docQuery: shown.query,
      machineFiles: isAbsoluteFilePath(shown.path),
      onNavigate: (next: string, query?: string, fragment?: string) => void openFile(next, query, fragment),
      ...(runtimeSessionId ? { sessionId: runtimeSessionId } : {}),
      loadPreview: loadInlineImage,
    }),
    [deviceHandle, workspaceHandle, rootHandle, folders, shown.path, shown.query, runtimeSessionId, loadInlineImage, openFile],
  );

  useEffect(() => {
    if (metadata.kind === "html") return;
    publishDocumentMeta({
      documentTitle: null,
      transfer,
      infoLines: [
        `类型：${metadata.kind}`,
        `媒体类型：${metadata.mediaType}`,
        `大小：${metadata.sourceBytes} bytes`,
        "单文件预览（无静态站点重写）",
      ],
    });
  }, [metadata, publishDocumentMeta, transfer]);

  const body = metadata.kind === "markdown" ? (
    <article ref={documentRef} onScroll={event => rememberScroll(event.currentTarget.scrollLeft, event.currentTarget.scrollTop)} className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain touch-pan-y">
      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8 sm:py-10">
        <Markdown text={text} variant="document" artifact={artifact} />
      </div>
    </article>
  ) : metadata.kind === "text" ? (
    <HighlightedCode text={text} language={languageForPath(shown.path)} document />
  ) : metadata.kind === "html" ? (
    <>
      <ServiceHtmlDocument
        client={client}
        workspaceHandle={workspaceHandle}
        bytes={shown.result.bytes}
        metadata={shown.result.metadata}
        transfer={shown.result.transfer}
        entryPath={shown.path}
        siteEntryPath={siteEntryPath}
        docQuery={shown.query}
        docFragment={shown.fragment}
        storageScope={{ deviceHandle, workspaceHandle, accessScope: storageAccessScope, principalScope: shown.result.metadata.storageScope }}
        fetchAsset={loadPreview}
        initialScroll={scrollPositions.current.get(visitKey)}
        onScroll={rememberScroll}
        onMetaChange={publishDocumentMeta}
        onRuntimeArtifact={onRuntimeArtifact}
        onRuntimeReady={onRuntimeReady}
        onOpenHtml={(next, query, fragment) => void openFile(next, query, fragment)}
        onServiceChange={onServiceChange}
      />
    </>
  ) : metadata.kind === "wasm" || metadata.kind === "binary" ? (
    <p className="m-auto max-w-lg px-6 text-center text-sm text-muted">
      二进制资源（{metadata.mediaType}，{metadata.sourceBytes} bytes）。请从入口 HTML 打开以运行游戏或站点。
    </p>
  ) : (
    <BlobDocument bytes={bytes} metadata={metadata} client={client} workspaceHandle={workspaceHandle} path={shown.path} />
  );
  return (
    <PreviewReviewChrome
      client={client}
      fileFeedback={fileFeedback}
      sessionId={runtimeSessionId ?? null}
      enabled={annotationWrite}
      path={shown.path}
      version={shown.result.metadata.version}
      kind={shown.result.metadata.kind}
      sourceText={text}
    >
      {history.length > 0 ? <nav aria-label="预览浏览记录" className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-xs"><button disabled={historyIndex <= 0} onClick={() => navigateHistory(historyIndex - 1)}>后退</button><button disabled={historyIndex >= history.length - 1} onClick={() => navigateHistory(historyIndex + 1)}>前进</button><span className="truncate">{shown.path}{shown.query}{shown.fragment}</span></nav> : null}
      {linkProblem ? <p role="alert" className="px-3 py-1 text-xs text-danger">{linkProblem}</p> : null}
      {shown.query ? <p role="status" className="px-3 py-1 text-xs text-muted">页面参数：{shown.query}（srcdoc 的原生 location.search 不可改写；页面可读取 genehubPreviewLocation.search）</p> : null}
      {body}
      {shown.result.metadata.kind === "html" ? null : <ProductFeedbackOverflow />}
    </PreviewReviewChrome>
  );
}

function BlobDocument({
  bytes,
  metadata,
  client,
  workspaceHandle,
  path,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
  client: Client;
  workspaceHandle: string;
  path: string;
}) {
  const [original, setOriginal] = useState<AssetPreviewResult | null>(null);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const originalAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    setOriginal(null);
    setOriginalError(null);
    setOriginalLoading(false);
    return () => {
      originalAbort.current?.abort();
      originalAbort.current = null;
    };
  }, [path, metadata.version]);
  const shown = original?.bytes ?? bytes;
  const mediaType = original?.metadata.mediaType ?? metadata.mediaType;
  const url = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([shown.slice().buffer as ArrayBuffer], { type: mediaType }),
      ),
    [shown, mediaType],
  );
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return metadata.kind === "image" ? (
    <div className="flex min-h-0 flex-1 flex-col bg-black/5">
      {metadata.representation === "image-1024" && !original ? (
        <div className="shrink-0 p-2 text-center text-xs">
          <button type="button" disabled={originalLoading} onClick={() => {
            const abort = new AbortController();
            originalAbort.current = abort;
            setOriginalLoading(true);
            setOriginalError(null);
            void client.preview(workspaceHandle, path, "original", abort.signal)
              .then((result) => {
                if (!abort.signal.aborted && result.metadata.kind === "image") setOriginal(result);
              })
              .catch((error) => {
                if (!abort.signal.aborted) setOriginalError(error instanceof Error ? error.message : "原图读取失败");
              })
              .finally(() => {
                if (!abort.signal.aborted) setOriginalLoading(false);
              });
          }}>
            {originalLoading ? "正在读取原图…" : "查看原图"}
          </button>
          {originalError ? <span role="alert" className="ml-3">{originalError}</span> : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <div className="relative max-h-full max-w-full">
          <img
            ref={setImage}
            src={url}
            alt="预览"
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
          <ImageAnnotationLayer image={image} />
        </div>
      </div>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
      <video src={url} controls className="max-h-full max-w-full" />
    </div>
  );
}

function serviceMark(client: ServicePreviewClient): ServiceMark {
  return {
    state: "reachable",
    name: client.descriptor.name,
    policy: client.descriptor.dataPolicy === "direct-only" ? "业务仅直连" : "允许 GeneHub 数据中继",
  };
}

function ServiceHtmlDocument(props: React.ComponentProps<typeof HtmlDocument> & {client:Client;workspaceHandle:string;onServiceChange?:(service:PreviewServiceInfo|null)=>void}) {
  const [candidate,setCandidate]=useState<ServicePreviewClient|null>(null);
  const [mark,setMark]=useState<ServiceMark|null>(null);
  const [generation,setGeneration]=useState(0);
  const [enabled,setEnabled]=useState(false);
  const enabledBinding = useRef<{client: Client; key: string} | null>(null);
  const bindingKey = JSON.stringify([props.workspaceHandle,props.entryPath,props.metadata.version,generation]);
  const accessEnabled = enabled && enabledBinding.current?.client === props.client && enabledBinding.current?.key === bindingKey;
  const [allowTurn,setAllowTurn]=useState(false);
  const [allowControl,setAllowControl]=useState(false);
  const [controlState,setControlState]=useState("released");
  const htmlMedia = candidate ? htmlServiceMedia(candidate.descriptor) : null;
  const releaseControl = useCallback(() => { setAllowControl(false); setControlState(state => state === "granted" || state === "waiting-for-yield" ? "release-pending" : state); }, []);
  const onControlState = useCallback((state: "granted" | "released" | "waiting-for-yield" | "release-pending" | "release-unconfirmed") => {
    setControlState(previous => state === "release-pending" && (previous === "released" || previous === "release-unconfirmed") ? previous : state);
    if (state === "released" || state === "release-unconfirmed") setAllowControl(false);
  }, []);
  useEffect(() => {
    if (controlState !== "release-pending") return;
    // Closing a bridge is not proof of OS key release. If its confirmation
    // path has also closed, show uncertainty instead of waiting indefinitely.
    const timer=window.setTimeout(() => setControlState(state => state === "release-pending" ? "release-unconfirmed" : state),6000);
    return () => window.clearTimeout(timer);
  }, [controlState]);
  useEffect(() => { if (!accessEnabled) releaseControl(); }, [accessEnabled, releaseControl]);
  useEffect(() => {
    if (!allowControl) return;
    const lostFocus = () => { if (document.visibilityState === "hidden" || !document.hasFocus()) releaseControl(); };
    const blur = () => { window.setTimeout(lostFocus, 0); };
    const pointer = () => { if (!document.pointerLockElement) releaseControl(); };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", lostFocus);
    document.addEventListener("pointerlockchange", pointer);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", lostFocus);
      document.removeEventListener("pointerlockchange", pointer);
    };
  }, [allowControl, releaseControl]);
  const supported = !!props.client.identity?.features?.includes("service.preview.v1");
  const onToggle = useCallback(() => {
    if (accessEnabled) setEnabled(false);
    else { enabledBinding.current={client:props.client,key:bindingKey}; setEnabled(true); }
  }, [accessEnabled,props.client,bindingKey]);
  const onRecheck = useCallback(() => setGeneration(n => n + 1), []);
  const { onServiceChange } = props;
  useEffect(() => {
    onServiceChange?.(mark ? previewServiceInfo(mark, accessEnabled, onToggle, onRecheck) : null);
  }, [accessEnabled, mark, onRecheck, onServiceChange, onToggle]);
  useEffect(() => () => onServiceChange?.(null), [onServiceChange]);
  useEffect(() => props.client.onStateChange(state => {
    setEnabled(false);
    if (state === "ready") setGeneration(n => n + 1);
    else if (supported) {
      setCandidate(null);
      setMark({ state: "unreachable", detail: "源电脑连接已断开，请重连后重新检查服务。" });
    }
  }), [props.client, supported]);
  useEffect(()=>{let cancelled=false;let loaded:ServicePreviewClient|null=null;setCandidate(null);setEnabled(false);setMark(null);
    if(!supported)return;
    void ServicePreviewClient.discover(props.client,isAbsoluteFilePath(props.entryPath) ? "" : props.workspaceHandle,props.entryPath).then(value=>{loaded=value;if(cancelled || props.client.connectionState!=="ready")value?.close();else { setCandidate(value); setMark(value ? serviceMark(value) : { state: "absent" }); }}).catch(error=>{if(!cancelled)setMark(classifyServiceFailure(error));});
    return()=>{cancelled=true;loaded?.close();};
  },[props.client,props.workspaceHandle,props.entryPath,props.metadata.version,generation,supported]);
  return <>{htmlMedia ? <PreviewToolbarPortal>
    <span className="truncate" title={candidate?.descriptor.name}>{htmlMedia.protocol === "pixel-streaming/1" ? "引擎串流" : `桌面共享 · ${controlState === "granted" ? "正在控制" : controlState === "waiting-for-yield" ? "等待交还" : controlState === "release-pending" ? "等待源端释放" : controlState === "release-unconfirmed" ? "释放未确认，请检查源端" : "仅观看"}`}</span>
    <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={allowTurn} onChange={event => { setAllowTurn(event.target.checked); setEnabled(false); setGeneration(n => n + 1); }}/>允许媒体中继</label>
    {htmlMedia.protocol === "pixel-streaming/1" ? null : <button type="button" disabled={!accessEnabled} className="ml-2 rounded border border-line px-2 py-1 disabled:opacity-40" onClick={() => allowControl ? releaseControl() : setAllowControl(true)}>{allowControl ? "交还控制" : "允许本页接管"}</button>}
    <button type="button" disabled={!accessEnabled} className="rounded border border-line px-2 py-1 disabled:opacity-40" onClick={() => setEnabled(false)}>停止观看</button>
  </PreviewToolbarPortal> : accessEnabled&&candidate?<ServiceMediaPanel service={candidate}/>:null}
  <HtmlDocument {...props} service={accessEnabled?candidate:null} servicePolicy={{allowTurn,allowControl:allowControl&&accessEnabled,onControlState}}/></>;
}

/** Exported for tests. */
export function HtmlDocument({
  bytes,
  metadata,
  transfer,
  entryPath,
  siteEntryPath = entryPath,
  docQuery = "",
  docFragment = "",
  initialScroll,
  onScroll,
  storageScope,
  fetchAsset,
  onMetaChange,
  onRuntimeArtifact,
  onRuntimeReady,
  onOpenHtml,
  service = null,
  servicePolicy,
}: {
  service?: ServicePreviewClient | null;
  servicePolicy?: ServiceBridgePolicy;
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
  transfer?: AssetPreviewTransferStats;
  entryPath: string;
  siteEntryPath?: string;
  docQuery?: string;
  docFragment?: string;
  initialScroll?: {x: number; y: number};
  onScroll?: (x: number, y: number) => void;
  /** Identifies the device/workspace the store namespace is confined to. */
  storageScope?: PreviewStorageScope;
  fetchAsset: (path: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mediaType: string; status?: number } | null>;
  onMetaChange?: (meta: PreviewMeta | null) => void;
  onRuntimeArtifact?: RuntimeArtifactSubmit;
  onRuntimeReady?: () => void;
  /** Opens another HTML file from this site without leaving the sandbox. */
  onOpenHtml?: (path: string, query?: string, fragment?: string) => void;
}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [collectorReady, setCollectorReady] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onScrollRef = useRef(onScroll); onScrollRef.current = onScroll;
  const onOpenHtmlRef = useRef(onOpenHtml);
  onOpenHtmlRef.current = onOpenHtml;
  useServiceBridge(frameRef, service, srcDoc, servicePolicy);
  const htmlMedia = service ? htmlServiceMedia(service.descriptor) : null;
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

  const storageNamespace = storageScope
    ? previewStorageNamespace(storageScope, siteEntryPath)
    : null;
  const [storageCount, setStorageCount] = useState(0);
  const [baseMeta, setBaseMeta] = useState<{
    documentTitle: string | null;
    infoLines: string[];
  } | null>(null);

  const clearPreviewStorage = useCallback(() => {
    if (!storageNamespace) return;
    clearPreviewStore(storageNamespace);
    try {
      frameRef.current?.contentWindow?.postMessage(
        { source: PREVIEW_STORAGE_SOURCE, command: "clear" },
        "*",
      );
    } catch {
      // Frame already gone; the parent-side store is cleared regardless.
    }
    setStorageCount(0);
    emitPreviewDiagnostic("log", {
      topic: "preview-storage",
      path: entryPath,
      phase: "cleared",
    });
  }, [storageNamespace, entryPath]);

  useEffect(() => {
    if (!baseMeta) return;
    onMetaChange?.({
      ...baseMeta,
      ...(transfer ? { transfer } : {}),
      ...(storageNamespace
        ? { storage: { count: storageCount, onClear: clearPreviewStorage } }
        : {}),
    });
  }, [
    baseMeta,
    storageCount,
    storageNamespace,
    clearPreviewStorage,
    onMetaChange,
    transfer,
  ]);

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
    const assetRequests = new Map<string, AbortController>();
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
      if (data.source === PREVIEW_RUNTIME_SOURCE && data.kind === "open-path") {
        const url = data.detail && typeof data.detail === "object"
          ? String((data.detail as { url?: unknown }).url ?? "")
          : "";
        const next = url ? resolveSiteReference(entryPath, url, siteEntryPath) : null;
        if (next) onOpenHtmlRef.current?.(next.path, url.startsWith("#") ? docQuery : next.query, next.fragment);
        return;
      }
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
        const request = data as typeof data & {url?: string; method?: string; cancel?: boolean};
        if (request.cancel) { assetRequests.get(data.requestId)?.abort(); assetRequests.delete(data.requestId); return; }
        if (assetRequests.has(data.requestId) || assetRequests.size >= 64) return;
        const abort = new AbortController(); assetRequests.set(data.requestId, abort);
        const frame = frameRef.current?.contentWindow;
        void (async () => {
          try {
            const method = String(request.method ?? "GET").toUpperCase();
            const path = resolveRuntimeAssetPath(entryPath, String(request.url ?? ""), siteEntryPath);
            const loaded = !["GET", "HEAD"].includes(method)
              ? {bytes: new Uint8Array(), mediaType: "text/plain", status: 405}
              : path ? await fetchAsset(path, abort.signal) : null;
            if (abort.signal.aborted || frame !== frameRef.current?.contentWindow) return;
            const status = loaded?.status ?? (loaded ? 200 : 403);
            const body = method === "HEAD" ? new ArrayBuffer(0) : loaded?.bytes.slice().buffer ?? new ArrayBuffer(0);
            frame?.postMessage({source: PREVIEW_ASSET_SOURCE, requestId: data.requestId, status,
              mediaType: loaded?.mediaType ?? "text/plain", sourceBytes: loaded?.bytes.byteLength ?? 0, body}, "*", [body]);
          } catch (error) {
            if (!abort.signal.aborted) frame?.postMessage({source: PREVIEW_ASSET_SOURCE, requestId: data.requestId, message: String(error)}, "*");
          } finally { assetRequests.delete(data.requestId!); }
        })();
        return;
      }
      if (data.source === PREVIEW_DIAG_SOURCE && data.detail && typeof data.detail === "object") {
        const detail = data.detail as Record<string, unknown>;
        if (detail.topic === "interaction" && detail.action === "scroll" && typeof detail.x === "number" && typeof detail.y === "number") onScrollRef.current?.(detail.x, detail.y);
      }
      if (data.source === PREVIEW_STORAGE_SOURCE) {
        if (!storageNamespace) return;
        const op = (data as { op?: unknown }).op;
        if (op === "ready") {
          const count = Number((data as { value?: unknown }).value);
          const keys = Number.isFinite(count) ? count : 0;
          setStorageCount(keys);
          emitPreviewDiagnostic("log", {
            topic: "preview-storage",
            path: entryPath,
            keys,
            phase: "shim-ready",
          });
          return;
        }
        const mutation = parsePreviewStoreMutation(
          data as { op?: unknown; key?: unknown; value?: unknown },
        );
        if (!mutation) return;
        if (applyPreviewStoreMutation(storageNamespace, mutation)) {
          setStorageCount(Object.keys(loadPreviewStore(storageNamespace)).length);
        } else {
          emitPreviewDiagnostic("error", {
            topic: "preview-storage",
            path: entryPath,
            op: mutation.op,
            phase: "mutation-rejected",
          });
        }
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
      for (const abort of assetRequests.values()) abort.abort();
      assetRequests.clear();
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
  }, [entryPath, siteEntryPath, docQuery, fetchAsset, storageNamespace]);

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
    setBaseMeta({
      documentTitle: extractHtmlTitle(decodeText(bytes)),
      infoLines: ["正在解析静态资源…"],
    });
    void (async () => {
      const sourceHtml = decodeText(bytes);
      const documentTitle = extractHtmlTitle(sourceHtml);
      // Sandboxed frames have no origin storage: seed the shim with what the
      // parent persisted for this site so scripts see it synchronously.
      const storageSnapshot = storageNamespace ? loadPreviewStore(storageNamespace) : null;
      if (storageSnapshot) setStorageCount(Object.keys(storageSnapshot).length);
      try {
        const remapped = await remapHtmlSite({
          entryPath,
          siteEntryPath,
          html: sourceHtml,
          fetchAsset,
        });
        blobUrls.push(...remapped.blobUrls);
        if (cancelled) {
          for (const url of blobUrls) URL.revokeObjectURL(url);
          return;
        }
        const infoLines = [
          "模式：多文件站点（内联 CSS/JS/module，媒体按需加载）",
          "运行时 fetch / import 已转发到工作区",
          "WASM / Worker：已开启",
          "网络：已开启（https / wss）",
          ...(storageSnapshot ? ["本地存储：沙箱 shim（持久化到本浏览器，同目录页面共享）"] : []),
          `源文件大小：${metadata.sourceBytes} bytes`,
          remapped.warnings.length > 0
            ? `未加载资源：${remapped.warnings.length} 个`
            : "未加载资源：0",
          ...remapped.warnings.slice(0, 40).map((warning) => `· ${warning}`),
        ];
        setSrcDoc(isolatedHtml(remapped.html, storageSnapshot, Boolean(service), {entryPath, query: docQuery, fragment: docFragment, scroll: initialScroll}));
        setBaseMeta({ documentTitle, infoLines });
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
          setSrcDoc(isolatedHtml(sourceHtml, storageSnapshot, Boolean(service), {entryPath, query: docQuery, fragment: docFragment, scroll: initialScroll}));
          setBaseMeta({
            documentTitle,
            infoLines: [
              "模式：单文件回退",
              "网络：已开启（https / wss）",
              ...(storageSnapshot ? ["本地存储：沙箱 shim（持久化到本浏览器，同目录页面共享）"] : []),
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
  }, [bytes, entryPath, siteEntryPath, docQuery, docFragment, fetchAsset, metadata.sourceBytes, storageNamespace, service]);

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
              key={srcDoc}
              ref={frameRef}
              title="HTML 文件预览"
              sandbox={htmlMedia ? "allow-scripts allow-pointer-lock" : "allow-scripts"}
              referrerPolicy="no-referrer"
              allow={`camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; display-capture 'none'; fullscreen 'none'; presentation 'none'${htmlMedia ? "; autoplay *" : ""}`}
              srcDoc={srcDoc}
              onLoad={() => setFrameReady(true)}
              className="absolute inset-0 h-full w-full border-0 bg-white [isolation:isolate]"
            />
            <HtmlAnnotationOverlay frameRef={frameRef} frameReady={frameReady} />
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
  absolutePath,
  title,
  lines,
  transfer,
  storage,
  service,
  onClose,
}: {
  path: string;
  absolutePath?: string;
  title: string;
  lines: string[];
  transfer?: PreviewMeta["transfer"];
  storage?: PreviewMeta["storage"];
  service?: PreviewServiceInfo | null;
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
            {absolutePath ? <div><dt className="text-faint">绝对路径</dt><dd className="break-all font-mono text-fg">{absolutePath}</dd></div> : null}
          </dl>
          {service ? <PreviewServiceSection service={service} /> : null}
          {transfer ? <PreviewTransferSummary stats={transfer} /> : null}
          <ul className="mt-4 list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted">
            {lines.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
          {storage ? (
            <div className="mt-4 flex items-center gap-3 border-t border-line pt-3 text-xs">
              <span className="min-w-0 flex-1 text-muted">
                本地存储：{storage.count} 项（沙箱 shim，已持久化到本浏览器）
              </span>
              <button
                type="button"
                disabled={storage.count === 0}
                className="shrink-0 rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                onClick={storage.onClear}
              >
                清除
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

const TRANSFER_TRANSPORT_LABELS: Record<
  AssetPreviewTransferStats["transport"],
  string
> = {
  websocket: "WebSocket 直连",
  fabric: "Fabric Relay",
  rtc: "WebRTC 直连",
};

/** Shared transfer facts for the standalone Preview page and PreviewFloat. */
export function PreviewTransferSummary({
  stats,
}: {
  stats: AssetPreviewTransferStats;
}) {
  const chunks = stats.chunkCount.toLocaleString("zh-CN");
  return (
    <section aria-label="入口文件传输" className="mt-4 border-y border-line py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-fg">入口文件传输</h3>
        <span className="text-[11px] text-faint">
          {TRANSFER_TRANSPORT_LABELS[stats.transport]}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <TransferFact
          label="文件大小"
          value={formatTransferBytes(stats.responseBytes)}
        />
        <TransferFact label="总等待" value={formatTransferDuration(stats.elapsedMs)} />
        <TransferFact
          label="首字节"
          value={
            stats.firstByteMs === null
              ? "无正文"
              : formatTransferDuration(stats.firstByteMs)
          }
        />
        <TransferFact
          label="正文平均"
          value={
            stats.averageBytesPerSecond === null
              ? "不可测"
              : `${formatTransferBytes(stats.averageBytesPerSecond)}/s`
          }
        />
        <TransferFact
          label="DATA 分片"
          value={`${chunks} 个`}
          detail={
            stats.chunkCount > 0
              ? `最大 ${formatTransferBytes(stats.largestChunkBytes)}/片`
              : undefined
          }
        />
      </dl>
      <p className="mt-2 text-[11px] leading-relaxed text-faint">
        首字节包含请求 RTT、daemon 扫描与排队；浏览器 WebSocket
        没有可跨链路比较的独立 RTT 读数，因此不展示估算值。DATA 分片是 GeneHub
        逻辑记录，不是 TCP 包。
      </p>
    </section>
  );
}

function TransferFact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md bg-raised px-2 py-2">
      <dt className="text-[10px] text-faint">{label}</dt>
      <dd className="mt-0.5 whitespace-nowrap text-xs font-medium text-fg">{value}</dd>
      {detail ? <dd className="mt-0.5 text-[10px] text-muted">{detail}</dd> : null}
    </div>
  );
}

function formatTransferBytes(bytes: number): string {
  const magnitude = Math.max(0, bytes);
  if (magnitude >= 1024 * 1024) {
    return `${(magnitude / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (magnitude >= 1024) return `${(magnitude / 1024).toFixed(1)} KiB`;
  return `${Math.round(magnitude)} B`;
}

function formatTransferDuration(milliseconds: number): string {
  const duration = Math.max(0, milliseconds);
  if (duration < 1_000) return `${Math.round(duration)} ms`;
  return `${(duration / 1_000).toFixed(duration < 10_000 ? 2 : 1)} s`;
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

export function isolatedHtml(
  source: string,
  storageSnapshot?: Record<string, string> | null,
  serviceEnabled = false,
  documentLocation?: {entryPath: string; query: string; fragment: string; scroll?: {x: number; y: number}},
): string {
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
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "font-src data: blob: https:",
    "connect-src https: wss: blob: data:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src blob: data:",
    "form-action 'none'",
    "base-uri https://preview.invalid",
    "navigate-to 'none'",
  ].join("; ");
  const base = document_.createElement("base");
  base.href = documentLocation ? virtualFileUrl(documentLocation.entryPath) : "https://preview.invalid/";
  // Opaque sandboxed iframe events never reach the parent. Install the bridge
  // before application scripts so startup logs/errors and the initial DOM are
  // part of the runtime artifact as well.
  const bridge = document_.createElement("script");
  bridge.textContent = PREVIEW_DIAG_BRIDGE;
  const renderer = document_.createElement("script");
  renderer.textContent = modernScreenshotSource;
  const locationShim = document_.createElement("script");
  const locator = JSON.stringify({pathname: documentLocation?.entryPath ?? "", search: documentLocation?.query ?? "", hash: documentLocation?.fragment ?? "", scroll: documentLocation?.scroll}).replace(/</g, "\\u003c");
  locationShim.textContent = `Object.defineProperty(window,"genehubPreviewLocation",{value:Object.freeze(${locator})});document.addEventListener("DOMContentLoaded",function(){var scroll=window.genehubPreviewLocation.scroll;if(scroll){window.scrollTo(scroll.x,scroll.y);return;}var hash=window.genehubPreviewLocation.hash;if(hash){try{var target=document.getElementById(decodeURIComponent(hash.slice(1)));if(target)target.scrollIntoView();}catch(e){}}});`;
  const injected = [policy, base, locationShim, renderer, bridge];
  if (serviceEnabled) { const serviceScript = document_.createElement("script"); serviceScript.textContent = serviceBridgeScript(); injected.push(serviceScript); }
  if (storageSnapshot) {
    // Sandboxed frames have no storage of their own: the shim backed by a
    // parent-persisted snapshot must precede application scripts as well.
    const shim = document_.createElement("script");
    shim.textContent = previewStorageShimSource(storageSnapshot);
    injected.push(shim);
  }
  document_.head.prepend(...injected);
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
  function previewSelector(element) {
    if (element.id && /^[A-Za-z][\\w-]*$/.test(element.id)) return element.tagName.toLowerCase() + "#" + element.id;
    var testid = element.getAttribute && element.getAttribute("data-testid");
    if (testid && testid.length < 80 && testid.indexOf("\\"") < 0) return element.tagName.toLowerCase() + "[data-testid=\\"" + testid + "\\"]";
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.nodeType === 1 && current !== document.body && depth < 6) {
      var tag = current.tagName.toLowerCase();
      var parentNode = current.parentElement;
      if (parentNode) {
        var same = 0;
        var index = 1;
        for (var i = 0; i < parentNode.children.length; i++) {
          if (parentNode.children[i].tagName === current.tagName) {
            same++;
            if (parentNode.children[i] === current) index = same;
          }
        }
        if (same > 1) tag += ":nth-of-type(" + index + ")";
      }
      parts.unshift(tag);
      current = parentNode;
      depth++;
    }
    return parts.join(" > ");
  }
  function scrollableAt(x, y) {
    var node = document.elementFromPoint(x, y);
    while (node && node !== document.documentElement) {
      var taller = node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
      if (taller) {
        var style = window.getComputedStyle(node);
        var scrollable = /auto|scroll|overlay/.test(style.overflowY) || /auto|scroll|overlay/.test(style.overflowX);
        if (scrollable) return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  var locatedItems = [];
  var annotationActive = false;
  var selectedElement = null;
  var annotationPointer = null;
  var annotationMoved = false;
  var markFrame = 0;
  function elementHit(target) {
    var excerpt = String(target.innerText || target.getAttribute("alt") || "").replace(/\\s+/g, " ").trim().slice(0, 256);
    var box = target.getBoundingClientRect();
    return {
      selector: previewSelector(target).slice(0, 512), tag: target.tagName.toLowerCase().slice(0, 32),
      excerpt: excerpt, domFingerprint: (target.tagName.toLowerCase() + ":" + excerpt.slice(0, 80)).slice(0, 128),
      x: box.left, y: box.top, width: box.width, height: box.height
    };
  }
  function scheduleMarks() {
    if (markFrame || (!locatedItems.length && !selectedElement)) return;
    markFrame = requestAnimationFrame(function(){ markFrame = 0; locateMarks("locate"); });
  }
  function locateMarks(requestId) {
    var marks = [];
    for (var i = 0; i < locatedItems.length && i < 32; i++) {
      var item = locatedItems[i] || {};
      var node = null;
      try { node = document.querySelector(String(item.selector || "")); } catch (e) { node = null; }
      if (!node || !node.getBoundingClientRect) {
        marks.push({ id: String(item.id || ""), missing: true });
        continue;
      }
      var box = node.getBoundingClientRect();
      marks.push({ id: String(item.id || ""), x: box.left, y: box.top, width: box.width, height: box.height });
    }
    sendRuntime("locate", requestId || "locate", {
      marks: marks, selection: selectedElement && selectedElement.isConnected ? elementHit(selectedElement) : null
    });
  }
  // Let WebKit handle pan, momentum and nested scrolling inside the iframe.
  // Capture taps only; no transparent parent layer or synthetic scroll deltas.
  document.addEventListener("pointerdown", function(event){
    if (!annotationActive) return;
    annotationPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    annotationMoved = false;
  }, true);
  document.addEventListener("pointermove", function(event){
    if (!annotationPointer || event.pointerId !== annotationPointer.id) return;
    if (Math.hypot(event.clientX - annotationPointer.x, event.clientY - annotationPointer.y) > 8) annotationMoved = true;
  }, true);
  document.addEventListener("pointercancel", function(){ annotationMoved = true; annotationPointer = null; }, true);
  document.addEventListener("click", function(event) {
    if (annotationActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (annotationMoved && event.detail !== 0) return;
      var picked = event.target;
      if (picked && picked.nodeType !== 1) picked = picked.parentElement;
      if (!picked || picked === document.documentElement || picked === document.body) return;
      selectedElement = picked;
      sendRuntime("hit-test", "annotation-pick", elementHit(picked));
      return;
    }
    var node = event.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== document.body && String(node.tagName || "").toUpperCase() !== "A") node = node.parentElement;
    if (!node || String(node.tagName || "").toUpperCase() !== "A") return;
    var href = node.getAttribute("href") || "";
    if (!href || /^(javascript:|mailto:|tel:)/i.test(href)) return;
    var parsed;
    try { parsed = new URL(href, document.baseURI); } catch (e) { return; }
    if (parsed.protocol !== "https:" || parsed.hostname !== "preview.invalid") return;
    event.preventDefault();
    event.stopPropagation();
    var path = parsed.pathname.replace(/^\\/+/, "");
    if (href.charAt(0) === "#" || !path) {
      sendRuntime("open-path", "open-path", {url: href});
      if (parsed.hash) {
        var target = document.getElementById(decodeURIComponent(parsed.hash.slice(1)));
        if (target && target.scrollIntoView) target.scrollIntoView();
      }
      return;
    }
    sendRuntime("open-path", "open-path", { url: href });
  }, true);
  window.addEventListener("message", function(event){
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== ${JSON.stringify(PREVIEW_RUNTIME_COMMAND_SOURCE)}) return;
    var requestId = String(data.requestId || "");
    if (data.command === "snapshot-render") {
      captureRenderedFrame(requestId);
      return;
    }
    if (data.command === "annotation-mode") {
      annotationActive = data.active === true;
      selectedElement = null;
      if (annotationActive && typeof data.selection === "string") {
        try { selectedElement = document.querySelector(data.selection); } catch (e) {}
      }
      annotationPointer = null;
      annotationMoved = false;
      locateMarks("locate");
      return;
    }
    if (data.command === "scroll-by") {
      var scroller = scrollableAt(Number(data.x) || 0, Number(data.y) || 0);
      if (scroller && scroller.scrollBy) scroller.scrollBy(Number(data.dx) || 0, Number(data.dy) || 0);
      return;
    }
    if (data.command === "locate") {
      locatedItems = Array.isArray(data.items) ? data.items.slice(0, 32) : [];
      locateMarks(requestId);
      return;
    }
    if (data.command === "hit-test") {
      var target = document.elementFromPoint(Number(data.x), Number(data.y));
      if (!target || target === document.documentElement || target === document.body) {
        sendRuntime("hit-test", requestId, { error: "empty" });
        return;
      }
      var excerpt = String(target.innerText || target.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 256);
      var fingerprint = target.tagName.toLowerCase() + ":" + excerpt.slice(0, 80);
      var hitBox = target.getBoundingClientRect();
      sendRuntime("hit-test", requestId, {
        selector: previewSelector(target).slice(0, 512),
        tag: target.tagName.toLowerCase().slice(0, 32),
        excerpt: excerpt,
        domFingerprint: fingerprint.slice(0, 128),
        x: hitBox.left,
        y: hitBox.top,
        width: hitBox.width,
        height: hitBox.height
      });
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
      var failedUrl = String(t.currentSrc || t.src || t.href || "");
      // Placeholder failures are expected: the lazy media resolver swaps them
      // for blob URLs and reports its own errors.
      if (isPlaceholderUrl(failedUrl)) return;
      send("resource", {
        tag: String(t.tagName).toLowerCase(),
        src: safeUrl(failedUrl),
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
  function requestPreviewAsset(url, options){
    options = options || {};
    var method = String(options.method || "GET").toUpperCase();
    var signal = options.signal;
    if (signal && signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    var requestId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    return new Promise(function(resolve, reject){
      var timer;
      function cleanup(){clearTimeout(timer);window.removeEventListener("message",onMessage);if(signal)signal.removeEventListener("abort",abort);}
      function abort(){cleanup();parent.postMessage({source:${JSON.stringify(PREVIEW_ASSET_SOURCE)},requestId:requestId,cancel:true},"*");reject(new DOMException("Aborted","AbortError"));}
      function onMessage(event){
        if(event.source!==parent)return;
        var data=event.data;
        if(!data||data.source!==${JSON.stringify(PREVIEW_ASSET_SOURCE)}||data.requestId!==requestId)return;
        cleanup();
        if(typeof data.status!=="number"||!data.body){reject(new Error(data.message||"asset load failed"));return;}
        resolve(new Response(method==="HEAD"?null:data.body,{status:data.status,headers:{"Content-Type":data.mediaType||"application/octet-stream","Content-Length":String(data.sourceBytes||0)}}));
      }
      window.addEventListener("message",onMessage);
      if(signal)signal.addEventListener("abort",abort,{once:true});
      timer=setTimeout(function(){cleanup();reject(new Error("asset load timed out"));},60000);
      // Send the original reference: new URL(raw, origin) would erase ../.
      parent.postMessage({source:${JSON.stringify(PREVIEW_ASSET_SOURCE)},requestId:requestId,url:String(url||""),method:method},"*");
    });
  }
  // --- Lazy media resolver -------------------------------------------------
  // The remap rewrites media URLs to https://preview.invalid/... placeholders
  // without fetching bytes. Native loads of placeholders would fail (the host
  // does not resolve), so this resolver swaps them for iframe-local blob:
  // URLs fetched through the asset bridge. Three coverage paths:
  //   1. prototype setter hooks  — el.src = "assets/a.png" before the browser
  //      starts a doomed native load;
  //   2. MutationObserver        — static HTML, innerHTML, setAttribute,
  //      srcset and SVG image/use (catch-all);
  //   3. runtime fetch/XHR       — handled by the fetch interception below.
  var mediaBlobCache = new Map();
  function isPlaceholderUrl(value){
    if (!value) return false;
    try {
      return new URL(String(value), document.baseURI).hostname === "preview.invalid";
    } catch (e) {
      return false;
    }
  }
  function resolveMediaBlob(rawUrl){
    var key = String(rawUrl);
    var cached = mediaBlobCache.get(key);
    if (cached) return cached;
    var pending = requestPreviewAsset(key).then(function(response){
      return response.blob();
    }).then(function(blob){
      return URL.createObjectURL(blob);
    }).catch(function(error){
      send("resource", { tag: "media", src: safeUrl(key), message: text(error, 500) });
      return null;
    });
    mediaBlobCache.set(key, pending);
    return pending;
  }
  function resolveMediaAttribute(el, attr){
    var value = el.getAttribute && el.getAttribute(attr);
    if (!isPlaceholderUrl(value)) return;
    var absolute = new URL(String(value), document.baseURI).href;
    resolveMediaBlob(absolute).then(function(blobUrl){
      if (blobUrl) el.setAttribute(attr, blobUrl);
    });
  }
  function resolveSrcsetValue(value){
    var candidates = String(value).split(",");
    return Promise.all(candidates.map(function(candidate){
      var parts = candidate.trim().split(/\s+/);
      var url = parts[0];
      if (!isPlaceholderUrl(url)) return candidate.trim();
      return resolveMediaBlob(new URL(url, document.baseURI).href).then(function(blobUrl){
        parts[0] = blobUrl || url;
        return parts.join(" ");
      });
    })).then(function(list){ return list.join(", "); });
  }
  function hookMediaSetter(prototype, attr){
    if (!prototype) return;
    var desc = Object.getOwnPropertyDescriptor(prototype, attr);
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(prototype, attr, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function(value){
        if (isPlaceholderUrl(value)) {
          var el = this;
          var apply = attr === "srcset"
            ? resolveSrcsetValue(value)
            : resolveMediaBlob(new URL(String(value), document.baseURI).href);
          apply.then(function(resolved){
            if (resolved) desc.set.call(el, resolved);
          });
          return;
        }
        desc.set.call(this, value);
      }
    });
  }
  try {
    hookMediaSetter(window.HTMLImageElement && HTMLImageElement.prototype, "src");
    hookMediaSetter(window.HTMLImageElement && HTMLImageElement.prototype, "srcset");
    hookMediaSetter(window.HTMLMediaElement && HTMLMediaElement.prototype, "src");
    hookMediaSetter(window.HTMLSourceElement && HTMLSourceElement.prototype, "src");
    hookMediaSetter(window.HTMLSourceElement && HTMLSourceElement.prototype, "srcset");
    hookMediaSetter(window.HTMLVideoElement && HTMLVideoElement.prototype, "poster");
    hookMediaSetter(window.HTMLTrackElement && HTMLTrackElement.prototype, "src");
  } catch (e) {}
  function scanMediaNode(node){
    if (!node || node.nodeType !== 1) return;
    var tag = String(node.tagName || "").toLowerCase();
    var watched = tag === "img" || tag === "source" || tag === "video" || tag === "audio" ||
      tag === "track" || tag === "image" || tag === "use" || tag === "link";
    if (watched) {
      resolveMediaAttribute(node, "src");
      resolveMediaAttribute(node, "poster");
      if (tag === "image" || tag === "use" || tag === "link") resolveMediaAttribute(node, "href");
      var srcset = node.getAttribute && node.getAttribute("srcset");
      if (isPlaceholderUrl(srcset)) {
        resolveSrcsetValue(srcset).then(function(resolved){
          if (resolved) node.setAttribute("srcset", resolved);
        });
      }
    }
    if (node.querySelectorAll) {
      var nested = node.querySelectorAll("img,source,video,audio,track,image,use,link");
      for (var i = 0; i < nested.length; i++) scanMediaNode(nested[i]);
    }
  }
  if (window.MutationObserver) {
    var mediaObserver = new MutationObserver(function(records){
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.type === "attributes") {
          scanMediaNode(record.target);
        } else if (record.type === "childList") {
          for (var j = 0; j < record.addedNodes.length; j++) scanMediaNode(record.addedNodes[j]);
        }
      }
    });
    mediaObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "poster", "href"]
    });
  }
  // --- End lazy media resolver ---------------------------------------------
  if (window.fetch) {
    var originalFetch = window.fetch;
    window.fetch = function(){
      var args = arguments;
      var started = Date.now();
      var input = args[0];
      var method = text((args[1] && args[1].method) || (input && input.method) || "GET", 20).toUpperCase();
      var rawUrl = (input && input.url) || input;
      var url = safeUrl(rawUrl);
      var pending = shouldInterceptAsset(rawUrl) ? requestPreviewAsset(rawUrl, {method:method, signal:(args[1] && args[1].signal) || (input && input.signal)}) : originalFetch.apply(window, args);
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
    var xhrOpen=XMLHttpRequest.prototype.open, xhrSend=XMLHttpRequest.prototype.send, xhrAbort=XMLHttpRequest.prototype.abort;
    var xhrSetHeader=XMLHttpRequest.prototype.setRequestHeader, xhrGetHeader=XMLHttpRequest.prototype.getResponseHeader, xhrGetHeaders=XMLHttpRequest.prototype.getAllResponseHeaders;
    function xhrEmit(xhr,type){xhr.dispatchEvent(new Event(type));}
    function xhrState(xhr,state){xhr.__genehubLocal.readyState=state;xhrEmit(xhr,"readystatechange");}
    XMLHttpRequest.prototype.open=function(method,url,async){
      if(this.__genehubLocal && this.__genehubLocal.abort)this.__genehubLocal.abort.abort();
      this.__genehubLocal=null;
      if(!shouldInterceptAsset(url))return xhrOpen.apply(this,arguments);
      if(async===false)throw new DOMException("Synchronous local Preview XHR is unsupported","NotSupportedError");
      var xhr=this;
      this.__genehubLocal={method:String(method||"GET").toUpperCase(),url:String(url),readyState:1,status:0,statusText:"",response:null,responseText:"",responseXML:null,responseURL:"",headers:new Headers(),requestHeaders:{},sent:false};
      ["readyState","status","statusText","response","responseText","responseXML","responseURL"].forEach(function(key){
        Object.defineProperty(xhr,key,{configurable:true,get:function(){
          var local=xhr.__genehubLocal;
          if(!local){var p=XMLHttpRequest.prototype;return Object.getOwnPropertyDescriptor(p,key).get.call(xhr);}
          if(key==="responseText" && xhr.responseType && xhr.responseType!=="text")throw new DOMException("Response type is not text","InvalidStateError");
          return local[key];
        }});
      });
      xhrEmit(this,"readystatechange");
    };
    XMLHttpRequest.prototype.setRequestHeader=function(name,value){var local=this.__genehubLocal;if(!local)return xhrSetHeader.apply(this,arguments);if(local.readyState!==1||local.sent)throw new DOMException("XHR is not opened","InvalidStateError");local.requestHeaders[name]=value;};
    XMLHttpRequest.prototype.getResponseHeader=function(name){var local=this.__genehubLocal;return local?(local.readyState>=2?local.headers.get(name):null):xhrGetHeader.apply(this,arguments);};
    XMLHttpRequest.prototype.getAllResponseHeaders=function(){var local=this.__genehubLocal;if(!local)return xhrGetHeaders.apply(this,arguments);var out="";if(local.readyState>=2)local.headers.forEach(function(value,key){out+=key+": "+value+"\\r\\n";});return out;};
    XMLHttpRequest.prototype.abort=function(){var local=this.__genehubLocal;if(!local)return xhrAbort.apply(this,arguments);if(local.abort)local.abort.abort();};
    XMLHttpRequest.prototype.send=function(body){
      var xhr=this,local=this.__genehubLocal;
      if(!local)return xhrSend.apply(this,arguments);
      if(local.readyState!==1||local.sent)throw new DOMException("XHR is not opened","InvalidStateError");
      local.sent=true;local.abort=new AbortController();var ended=false,timedOut=false;
      var timer=xhr.timeout?setTimeout(function(){timedOut=true;local.abort.abort();},xhr.timeout):null;
      xhrEmit(xhr,"loadstart");
      // Dispatch through the current fetch so registered API routes retain
      // their service bridge and consent; local files use the same file bridge.
      window.fetch(local.url,{method:local.method,headers:local.requestHeaders,body:["GET","HEAD"].indexOf(local.method)>=0?undefined:body,signal:local.abort.signal}).then(async function(response){
        if(xhr.__genehubLocal!==local)return;
        local.status=response.status;local.statusText=response.statusText;local.headers=response.headers;local.responseURL=local.url;xhrState(xhr,2);
        var buffer=await response.arrayBuffer();if(local.abort.signal.aborted)throw new DOMException("Aborted","AbortError");
        var value=new TextDecoder().decode(buffer),type=xhr.responseType;
        local.responseText=value;
        if(type==="arraybuffer")local.response=buffer;
        else if(type==="blob")local.response=new Blob([buffer],{type:response.headers.get("Content-Type")||""});
        else if(type==="json"){try{local.response=JSON.parse(value);}catch(e){local.response=null;}}
        else if(type==="document"){local.responseXML=new DOMParser().parseFromString(value,/html/i.test(response.headers.get("Content-Type")||"")?"text/html":"application/xml");local.response=local.responseXML;}
        else local.response=value;
        xhrState(xhr,3);xhr.dispatchEvent(new ProgressEvent("progress",{lengthComputable:true,loaded:buffer.byteLength,total:buffer.byteLength}));
        xhrState(xhr,4);ended=true;clearTimeout(timer);xhrEmit(xhr,"load");xhrEmit(xhr,"loadend");
      }).catch(function(error){
        clearTimeout(timer);if(ended||xhr.__genehubLocal!==local)return;ended=true;
        local.status=0;local.statusText="";local.response=null;local.responseText="";xhrState(xhr,4);
        xhrEmit(xhr,timedOut?"timeout":local.abort.signal.aborted?"abort":"error");xhrEmit(xhr,"loadend");
        if(local.abort.signal.aborted)local.readyState=0;
        send("error",{topic:"network",transport:"xhr",url:safeUrl(local.url),message:text(error,500)});
      });
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
    scheduleMarks();
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(function(){
      scrollTimer = 0;
      send("log", { topic: "interaction", action: "scroll", x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) });
    }, 200);
  }, true);
  window.addEventListener("resize", scheduleMarks);
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
    new MutationObserver(function(records){ mutationCount += records.length; scheduleMarks(); }).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true
    });
  } catch (e) {}
  if (new URL(document.baseURI).hostname !== "preview.invalid") {
    send("error", {topic: "preview-platform-policy", message: "Preview base URL was blocked by the parent Content-Security-Policy. Update the workbench base-uri policy."});
    document.addEventListener("DOMContentLoaded", function(){ var alert=document.createElement("p"); alert.setAttribute("role","alert"); alert.textContent="平台预览策略阻止了资源基址，请更新工作台 CSP 的 base-uri 配置。"; document.body.prepend(alert); });
    window.stop();
  }
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
    bulk: endpoint.bulk,
    url: endpoint.url,
    fabricRouteTicket: endpoint.fabricRouteTicket,
    fabricAuthorizationExpiresAt: endpoint.fabricAuthorizationExpiresAt,
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

import { PreviewVideo } from "./PreviewVideo";
import { PreviewReceivedFeedback } from "./PreviewReceivedFeedback";
import previewReviewBridge from "./previewReviewBridge.js?raw";
import { previewFeedback, useFileFeedback, type FileFeedbackReview } from "./fileFeedback";
import { PreviewFeedbackPanel } from "./PreviewFeedbackPanel";
import { PreviewShareButton, PreviewShareCopyButton } from "./PreviewShareButton";
import { IndependentPreviewMenu } from "./IndependentPreviewMenu";
import { PreviewFileFeedbackOpenContext, PreviewShareOpenContext } from "./PreviewToolbar";
import type { PreviewFeedbackRecord, PreviewSourceInfo } from "@genehub/proto";
import { ServicePreviewClient, classifyServiceFailure, htmlServiceMedia } from "./serviceClient";
import { previewServiceInfo, PreviewServiceSection, type PreviewServiceInfo, type ServiceMark } from "./ServiceStatusMenu";
import { ServiceMediaPanel } from "./ServiceMediaPanel";
import { serviceBridgeScript, useServiceBridge, type ServiceBridgePolicy } from "./serviceBridge";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { AssetPreviewMetadata, SessionArtifactBundle } from "@genehub/proto";
import modernScreenshotSource from "modern-screenshot/dist/index.js?raw";

import { emitClientDiagnostic, registerDiagnosticClient } from "../diagnostics";
import { MachineConnectionsContext } from "../protocol/machine-connection-context";
import type { MachineLease } from "../protocol/machine-connections";
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
  type PreviewDomSnapshot,
  type PreviewRuntimeEvent,
  type RuntimeArtifactSubmit,
} from "./PreviewRuntimeControls";
import type { PixelSnapshot } from "./runtimeCapture";
import { assetPreviewUrl, isAbsoluteFilePath, type AssetPreviewLocation } from "./url";
import { uploadSessionArtifact } from "./sessionArtifactUpload";
import { PreviewNavigation, PreviewShareAction, PreviewShell, PreviewToolbarContext, PreviewToolbarPortal } from "./PreviewToolbar";

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
  navigation,
  onAddFeedbackToChat,
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
  navigation?: React.ReactNode;
  onAddFeedbackToChat?: (receipt: PreviewFeedbackRecord) => void;
}) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const resources = useRef(new Set<string>());
  const [feedbackSource, setFeedbackSource] = useState<{path: string; version: string; kind: AssetPreviewMetadata["kind"]} | null>(null);
  const [folders, setFolders] = useState<Array<{root: string; rootHandle: string}>>([]);
  const [sourceInfo, setSourceInfo] = useState<PreviewSourceInfo | null>(null);
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
  }, [source.path, source.workspaceHandle, source.deviceHandle, publishMeta]);

  const connections = useContext(MachineConnectionsContext);
  const [independentClient, setIndependentClient] = useState<Client | null>(null);
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let borrowed: MachineLease | null = null;
    let owned: Client | null = null;
    let unregisterDiagnosticClient: (() => void) | null = null;
    setState({ kind: "loading" });
    setSourceInfo(null);
    setFeedbackSource(null);
    setIndependentClient(null);
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
        } else if (connections && !shareAccess) {
          const targets = await connections.targets();
          const target = targets.find(target => target.deviceHandle === source.deviceHandle || target.id === source.deviceHandle);
          if (!target) throw new Error("资源所在机器未授权或已移除");
          borrowed = await connections.acquire(target, { signal: abort.signal, foreground: true });
          if (cancelled) { borrowed.release(); return; }
          active = borrowed.client;
        } else {
          const endpoint =
            (await endpointForDevice(host, source.deviceHandle)) ??
            (await host.endpoint());
          if (!endpoint) throw new Error("这台浏览器尚未获准连接资源所在的设备");
          owned = connectPreview(endpoint, host, source.deviceHandle);
          unregisterDiagnosticClient = registerDiagnosticClient(owned);
          await ready(owned);
          if (owned.identity?.machineId !== source.deviceHandle) {
            throw new Error("链接指向的设备与当前连接不一致");
          }
          active = owned;
        }
        if (!cancelled && !shareAccess && active.identity?.features?.includes("asset.preview.independent.v1")) {
          setIndependentClient(active);
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
          owned?.close(); borrowed?.release();
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
        owned?.close(); borrowed?.release();
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
      owned?.close(); borrowed?.release();
    };
  }, [host, sharedClient, source.deviceHandle, source.path, source.workspaceHandle, connections, shareAccess]);

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

  useEffect(() => {
    const previous = document.title;
    const title = meta?.documentTitle?.trim() || basenamePath(source.path);
    document.title = title;
    return () => { if (document.title === title) document.title = previous; };
  }, [meta?.documentTitle, source.path]);

  const feedbackClient = state.kind === "ready" ? state.client : null;
  const fileFeedbackAvailable = !!feedbackClient?.identity?.features?.includes("preview.feedback.v1");
  const fileFeedbackEnabled = fileFeedbackAvailable && (!shareAccess ||
    (sourceInfo ? sourceInfo.feedbackWritable !== false : !feedbackClient?.identity?.features?.includes("preview.share.view-only.v1")));
  const [openFileFeedback, setOpenFileFeedback] = useState<(() => void) | null>(null);
  const bindFileFeedback = useCallback((open: (() => void) | null) => {
    setOpenFileFeedback(() => open);
  }, []);
  const [openShare, setOpenShare] = useState<(() => void) | null>(null);
  const bindShare = useCallback((open: (() => void) | null) => {
    setOpenShare(() => open);
  }, []);
  const currentKind = feedbackSource?.kind ?? (state.kind === "ready" ? state.result.metadata.kind : undefined);
  const annotatable = currentKind === "markdown" || currentKind === "html" || currentKind === "image"
    || (currentKind === "video" && !!feedbackClient?.identity?.features?.includes("preview.feedback.media-time.v1"));
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
  const runtimeArtifactSubmit = fileFeedbackEnabled ? submitFileArtifact : shareAccess ? undefined :
    onRuntimeArtifact ?? (runtimeSessionId ? submitStandaloneArtifact : undefined);

  return (
    <PreviewFileFeedbackOpenContext.Provider value={fileFeedbackEnabled ? openFileFeedback : null}>
    <PreviewShareOpenContext.Provider value={fileFeedbackEnabled ? openShare : null}>
    <PreviewToolbarContext.Provider value={toolbarTarget ?? pageToolbarTarget}>
    <main className={`${chrome === "page" ? "safe-area-page" : ""} flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg`}>
      <PreviewShell bindTools={setPageToolbarTarget} readOnly={shareAccess && !fileFeedbackEnabled} navigation={navigation} information={
        <PreviewInformation
          path={meta?.location?.path ?? sourceInfo?.displayPath ?? source.path}
          query={meta?.location?.docQuery ?? source.docQuery}
          fragment={meta?.location?.docFragment ?? source.docFragment}
          absolutePath={!shareAccess && sourceInfo ? `${sourceInfo.machineName}：${sourceInfo.absolutePath}` : undefined}
          title={meta?.documentTitle?.trim() || basenamePath(source.path)}
          lines={meta?.infoLines ?? []}
          transfer={meta?.transfer}
          storage={meta?.storage}
          service={meta?.service}
        />
      }>
      <PreviewShareAction />
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
          shareAccess={shareAccess}
          allowCapture={!shareAccess || fileFeedbackEnabled}
          deviceHandle={source.deviceHandle}
          workspaceHandle={source.workspaceHandle}
          client={state.client}
          onMetaChange={reportMeta}
          onRuntimeArtifact={runtimeArtifactSubmit}
          runtimeSessionId={runtimeSessionId}
          onRuntimeReady={onRuntimeReady}
          annotationWrite={fileFeedbackEnabled || (annotationWrite && !shareAccess)}
          fileFeedback={fileFeedbackEnabled ? feedback.review : undefined}
          onSourceChange={setFeedbackSource}
          onServiceChange={reportService}
          resourcePaths={resources.current}
        />
      )}
      {fileFeedbackEnabled && !shareAccess && feedbackClient?.identity?.features?.includes("preview.feedback.list.v1") ? <PreviewReceivedFeedback
        onAddToChat={onAddFeedbackToChat} key={`received:${feedbackSource?.path ?? source.path}`} client={feedbackClient} path={feedbackSource?.path ?? source.path}
        version={feedbackSource?.version ?? (state.kind === "ready" ? state.result.metadata.version : "")}
        workspaceId={isAbsoluteFilePath(feedbackSource?.path ?? source.path) ? "" : source.workspaceHandle} /> : null}
      {fileFeedbackEnabled ? <PreviewFeedbackPanel key={`compose:${feedbackSource?.path ?? source.path}`} feedback={feedback} bindOpen={annotatable ? bindFileFeedback : undefined} showToolbarButton={!annotatable} /> : null}
      {fileFeedbackEnabled && !shareAccess && feedbackClient ? <PreviewShareButton client={feedbackClient} source={{...source, ...meta?.location, path: feedbackSource?.path ?? source.path, siteEntryPath: meta?.location?.siteEntryPath ?? source.siteEntryPath ?? source.path}} resources={resources.current} trigger={false} bindOpen={bindShare} /> : null}
      {fileFeedbackAvailable && shareAccess ? <PreviewShareCopyButton trigger={false} bindOpen={bindShare} /> : null}
      {independentClient && /\.html?$/i.test(source.path) ? (
          <IndependentPreviewMenu
            client={independentClient}
            source={{...source, ...meta?.location, path: feedbackSource?.path ?? source.path}}
            resources={resources.current}
            canShare={state.kind === "ready"}
          />
        ) : null}
      </PreviewShell>
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
  shareAccess,
  allowCapture,
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
  shareAccess: boolean;
  allowCapture: boolean;
  deviceHandle: string;
  workspaceHandle: string;
  client: Client;
  onMetaChange?: (meta: PreviewMeta | null) => void;
  onRuntimeArtifact?: RuntimeArtifactSubmit;
  runtimeSessionId?: string | null;
  onRuntimeReady?: () => void;
  annotationWrite?: boolean;
  fileFeedback?: FileFeedbackReview;
  onSourceChange?: (source: {path: string; version: string; kind: AssetPreviewMetadata["kind"]}) => void;
  onServiceChange?: (service: PreviewServiceInfo | null) => void;
  resourcePaths?: Set<string>;
}) {
  type Visit = {path: string; result: AssetPreviewResult; query: string; fragment: string; siteEntryPath: string};
  const [history, setHistory] = useState<Visit[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const [newWindowLink, setNewWindowLink] = useState<string>();
  const followGeneration = useRef(0);
  const followAbort = useRef<AbortController | null>(null);
  const documentRef = useRef<HTMLElement | null>(null);
  const scrollPositions = useRef(new Map<number, {x: number; y: number}>());
  const visitKey = Math.max(0, historyIndex);
  const rememberScroll = useCallback((x: number, y: number) => {scrollPositions.current.set(visitKey, {x, y});}, [visitKey]);
  useEffect(() => {
    followGeneration.current += 1;
    followAbort.current?.abort();
    setHistory([]); setHistoryIndex(-1); setLinkProblem(null); setNewWindowLink(undefined); scrollPositions.current.clear();
    return () => { followAbort.current?.abort(); };
  }, [path, result]);
  const shown = history[historyIndex] ?? {path, result, query: docQuery, fragment: docFragment, siteEntryPath};
  const {metadata, bytes, transfer} = shown.result;
  useEffect(() => { onSourceChange?.({path: shown.path, version: metadata.version, kind: metadata.kind}); }, [shown.path, metadata.version, metadata.kind, onSourceChange]);
  const openFile = useCallback(async (nextPath: string, query = "", fragment = "") => {
    const generation = ++followGeneration.current;
    followAbort.current?.abort();
    const abort = new AbortController(); followAbort.current = abort;
    setLinkProblem(null);
    try {
      const loaded = nextPath === shown.path ? shown.result : await client.preview(workspaceHandle, nextPath, "original", abort.signal);
      if (generation !== followGeneration.current) return;
      const prior = historyIndex < 0 ? [{path, result, query: docQuery, fragment: docFragment, siteEntryPath}] : history.slice(0, historyIndex + 1);
      // Child documents keep their site's root (storage and /assets alike).
      // Leaving that directory opens another site, just as its chat link does.
      // Store this per visit so back/forward and popout keep the same identity.
      const siteDirectory = shown.siteEntryPath.slice(0, shown.siteEntryPath.lastIndexOf('/') + 1);
      const nextSiteEntryPath = nextPath.startsWith(siteDirectory) ? shown.siteEntryPath : nextPath;
      for (const index of scrollPositions.current.keys()) {
        if (index >= prior.length) scrollPositions.current.delete(index);
      }
      setHistory([...prior, {path: nextPath, result: loaded, query, fragment, siteEntryPath: nextSiteEntryPath}]);
      setHistoryIndex(prior.length);
      if (nextPath !== shown.path) { resourcePaths?.clear(); resourcePaths?.add(nextPath); }
    } catch (error) {
      if (generation === followGeneration.current && !abort.signal.aborted) setLinkProblem(error instanceof Error ? error.message : "无法打开这个链接");
    }
  }, [client, workspaceHandle, shown, history, historyIndex, path, result, docQuery, docFragment, siteEntryPath, resourcePaths]);
  const navigateHistory = (next: number) => {
    followGeneration.current += 1; followAbort.current?.abort(); setLinkProblem(null); setHistoryIndex(next);
    resourcePaths?.clear(); if (history[next]) resourcePaths?.add(history[next]!.path);
  };
  useEffect(() => {
    const node = documentRef.current;
    if (!node) return;
    const saved = scrollPositions.current.get(visitKey);
    if (saved) { node.scrollTo(saved.x, saved.y); return; }
    const scroll = requestAnimationFrame(() => {
      let id: string;
      try { id = decodeURIComponent(shown.fragment.replace(/^#/, "")); }
      catch { id = ""; }
      const target = id && Array.from(node.querySelectorAll("[id]")).find(element => element.id === id);
      if (target) {
        const offset = target.getBoundingClientRect().top - node.getBoundingClientRect().top;
        node.scrollTo(0, node.scrollTop + offset);
      } else {
        node.scrollTo(0, 0);
      }
    });
    return () => cancelAnimationFrame(scroll);
  }, [shown.path, shown.fragment, metadata.kind, visitKey]);
  const publishDocumentMeta = useCallback((meta: PreviewMeta | null) => {
    onMetaChange?.(meta ? {...meta, location: {path: shown.path, docQuery: shown.query, docFragment: shown.fragment, siteEntryPath: shown.siteEntryPath}} : null);
  }, [onMetaChange, shown.path, shown.query, shown.fragment, shown.siteEntryPath]);
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
        siteEntryPath={shown.siteEntryPath}
        docQuery={shown.query}
        docFragment={shown.fragment}
        storageScope={{ deviceHandle, workspaceHandle, accessScope: storageAccessScope, principalScope: shown.result.metadata.storageScope }}
        fetchAsset={loadPreview}
        initialScroll={scrollPositions.current.get(visitKey)}
        onScroll={rememberScroll}
        onMetaChange={publishDocumentMeta}
        onRuntimeArtifact={onRuntimeArtifact}
        allowCapture={allowCapture}
        onRuntimeReady={onRuntimeReady}
        onOpenHtml={(next, query, fragment, newWindow) => {
          if (!newWindow) {
            setNewWindowLink(undefined);
            void openFile(next, query, fragment);
            return;
          }
          const url = new URL(assetPreviewUrl(deviceHandle, workspaceHandle, next, undefined, undefined, {
            docQuery: query, docFragment: fragment, siteEntryPath: shown.siteEntryPath,
          }), window.location.href);
          if (shareAccess) url.hash = window.location.hash;
          setNewWindowLink(url.href);
        }}
        onServiceChange={onServiceChange}
      />
    </>
  ) : metadata.kind === "wasm" || metadata.kind === "binary" ? (
    <p className="m-auto max-w-lg px-6 text-center text-sm text-muted">
      二进制资源（{metadata.mediaType}，{metadata.sourceBytes} bytes）。请从入口 HTML 打开以运行游戏或站点。
    </p>
  ) : (
    <BlobDocument bytes={bytes} metadata={metadata} client={client} workspaceHandle={workspaceHandle} path={shown.path}
      allowCapture={allowCapture} onRuntimeArtifact={onRuntimeArtifact} />
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
      <PreviewNavigation back={historyIndex > 0 ? () => navigateHistory(historyIndex - 1) : undefined}
        forward={historyIndex >= 0 && historyIndex < history.length - 1 ? () => navigateHistory(historyIndex + 1) : undefined} />
      {newWindowLink ? <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
        <a href={newWindowLink} target="_blank" rel="noopener noreferrer" className="text-accent underline">在新窗口打开目标页</a>
        <button type="button" className="rounded px-2 py-1 hover:bg-raised" onClick={() => setNewWindowLink(undefined)}>取消</button>
      </div> : null}
      {linkProblem ? <p role="alert" className="px-3 py-1 text-xs text-danger">{linkProblem}</p> : null}
      {body}
    </PreviewReviewChrome>
  );
}

function BlobDocument({
  bytes,
  metadata,
  client,
  workspaceHandle,
  path,
  allowCapture,
  onRuntimeArtifact,
}: {
  bytes: Uint8Array;
  metadata: AssetPreviewMetadata;
  client: Client;
  workspaceHandle: string;
  path: string;
  allowCapture: boolean;
  onRuntimeArtifact?: RuntimeArtifactSubmit;
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
  ) : <PreviewVideo key={url} url={url} path={path} version={metadata.version}
    allowCapture={allowCapture} onSubmit={onRuntimeArtifact} />;
}

function serviceMark(client: ServicePreviewClient): ServiceMark {
  return {
    state: "reachable",
    name: client.descriptor.name,
    policy: client.descriptor.dataPolicy === "direct-only" ? "业务仅直连" : "允许 GeneHub 数据中继",
  };
}

export function ServiceHtmlDocument(props: React.ComponentProps<typeof HtmlDocument> & {client:Client;workspaceHandle:string;onServiceChange?:(service:PreviewServiceInfo|null)=>void}) {
  const [candidate,setCandidate]=useState<ServicePreviewClient|null>(null);
  const [mark,setMark]=useState<ServiceMark|null>(null);
  const [generation,setGeneration]=useState(0);
  const [stopped,setStopped]=useState(false);
  const candidateBinding = useRef<{client: Client; key: string} | null>(null);
  const bindingKey = JSON.stringify([props.workspaceHandle,props.entryPath,props.metadata.version,generation]);
  const currentCandidate = candidateBinding.current?.client === props.client && candidateBinding.current?.key === bindingKey ? candidate : null;
  const accessEnabled = !!currentCandidate && !stopped;
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
  const hadRegistration = useRef(false);
  const stoppedRef = useRef(stopped); stoppedRef.current = stopped;
  const reconnect = useCallback(() => {
    if (retryTimer.current || stoppedRef.current || retries.current >= 5) return;
    retries.current++;
    retryTimer.current = setTimeout(() => { retryTimer.current = null; setGeneration(n => n + 1); }, 2000);
  }, []);
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); retryTimer.current = null; }, [props.client, props.entryPath, stopped]);
  const [allowControl,setAllowControl]=useState(false);
  const [mediaPath, setMediaPath] = useState("");
  const [controlState,setControlState]=useState("released");
  const htmlMedia = currentCandidate ? htmlServiceMedia(currentCandidate.descriptor) : null;
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
  useEffect(() => setMediaPath(""), [currentCandidate, accessEnabled]);
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
  const onToggle = useCallback(() => setStopped(value => !value), []);
  const onRecheck = useCallback(() => { retries.current = 0; setStopped(false); setGeneration(n => n + 1); }, []);
  const { onServiceChange } = props;
  useEffect(() => {
    const currentMark = mark?.state === "reachable" && !currentCandidate ? null : mark;
    onServiceChange?.(currentMark ? previewServiceInfo(currentMark, accessEnabled, onToggle, onRecheck) : null);
  }, [accessEnabled, currentCandidate, mark, onRecheck, onServiceChange, onToggle]);
  useEffect(() => () => onServiceChange?.(null), [onServiceChange]);
  useEffect(() => props.client.onStateChange(state => {
    if (state === "ready") { retries.current = 0; setGeneration(n => n + 1); }
    else if (supported) {
      setCandidate(null);
      setMark({ state: "unreachable", detail: "源电脑连接已断开，请重连后重新检查服务。" });
    }
  }), [props.client, supported]);
  useEffect(()=>{let cancelled=false;let loaded:ServicePreviewClient|null=null;setCandidate(null);setMark(null);
    if(!supported)return;
    void ServicePreviewClient.discover(props.client,isAbsoluteFilePath(props.entryPath) ? "" : props.workspaceHandle,props.entryPath).then(value=>{loaded=value;if(cancelled || props.client.connectionState!=="ready")value?.close();else { candidateBinding.current={client:props.client,key:bindingKey}; setCandidate(value); setMark(value ? serviceMark(value) : { state: "absent" }); if (value) hadRegistration.current = true; else if (hadRegistration.current) reconnect(); }}).catch(error=>{if(!cancelled) { const failure=classifyServiceFailure(error); setMark(failure); if (failure.state !== "unauthorized") reconnect(); }});
    return()=>{cancelled=true;loaded?.close();};
  },[props.client,props.workspaceHandle,props.entryPath,props.metadata.version,generation,supported,reconnect,bindingKey]);
  return <>
  {mediaPath && accessEnabled ? <PreviewToolbarPortal slot="information">
    <div className="mt-4 border-t border-line pt-3">媒体连接 · {mediaPath}</div>
  </PreviewToolbarPortal> : null}
  {htmlMedia ? <PreviewToolbarPortal>
    <span className="truncate" title={candidate?.descriptor.name}>{htmlMedia.protocol === "pixel-streaming/1" ? "引擎串流" : `桌面共享 · ${controlState === "granted" ? "正在控制" : controlState === "waiting-for-yield" ? "等待交还" : controlState === "release-pending" ? "等待源端释放" : controlState === "release-unconfirmed" ? "释放未确认，请检查源端" : "仅观看"}`}</span>
    {htmlMedia.protocol === "pixel-streaming/1" ? null : <button type="button" disabled={!accessEnabled} className="ml-2 rounded border border-line px-2 py-1 disabled:opacity-40" onClick={() => allowControl ? releaseControl() : setAllowControl(true)}>{allowControl ? "交还控制" : "允许本页接管"}</button>}
    <button type="button" disabled={!accessEnabled} className="rounded border border-line px-2 py-1 disabled:opacity-40" onClick={() => setStopped(true)}>停止观看</button>
    <button type="button" className="rounded border border-line px-2 py-1" onClick={onRecheck}>重新连接</button>
  </PreviewToolbarPortal> : accessEnabled&&currentCandidate?<ServiceMediaPanel service={currentCandidate}/>:null}
  <HtmlDocument {...props} service={accessEnabled?currentCandidate:null} servicePolicy={{allowControl:allowControl&&accessEnabled,onControlState,onMediaPath:setMediaPath,onUnavailable:reconnect}}/></>;
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
  allowCapture,
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
  allowCapture?: boolean;
  onOpenHtml?: (path: string, query?: string, fragment?: string, newWindow?: boolean) => void;
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
        const detail = data.detail as { url?: unknown; newWindow?: unknown } | undefined;
        const url = typeof detail?.url === "string" && detail.url.length <= 4096 ? detail.url : "";
        const next = url ? resolveSiteReference(entryPath, url, siteEntryPath) : null;
        if (next) onOpenHtmlRef.current?.(next.path, url.startsWith("#") ? docQuery : next.query, next.fragment, detail?.newWindow === true);
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
        setEventCount(count => count + 1);
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
          <PreviewRuntimeControls allowCapture={allowCapture}
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
              // Local submit handlers must run before they can preventDefault.
              // The document CSP still blocks form-action navigation/requests.
              sandbox={htmlMedia ? "allow-scripts allow-forms allow-pointer-lock" : "allow-scripts allow-forms"}
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

function PreviewInformation({ path, query, fragment, absolutePath, title, lines, transfer, storage, service }: {
  path: string;
  query?: string;
  fragment?: string;
  absolutePath?: string;
  title: string;
  lines: string[];
  transfer?: PreviewMeta["transfer"];
  storage?: PreviewMeta["storage"];
  service?: PreviewServiceInfo | null;
}) {
  return <>
          <dl className="space-y-2 text-xs">
            <div>
              <dt className="text-faint">标题</dt>
              <dd className="break-words text-fg">{title}</dd>
            </div>
            <div>
              <dt className="text-faint">路径</dt>
              <dd className="break-all font-mono text-fg">{path}{query}{fragment}</dd>
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
  </>;
}

const TRANSFER_TRANSPORT_LABELS: Record<AssetPreviewTransferStats["transport"], string> = {
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
${previewReviewBridge}  function shouldInterceptAsset(url){
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

export async function endpointForDevice(host: Host, machineId: string): Promise<Endpoint | null> {
  if (!host.targets || !host.openTarget) return null;
  const target = (await host.targets()).find(
    (candidate) => (candidate.deviceHandle ?? candidate.id) === machineId,
  );
  return target ? host.openTarget(target.id) : null;
}

export function connectPreview(endpoint: Endpoint, host: Host, deviceHandle: string): Client {
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

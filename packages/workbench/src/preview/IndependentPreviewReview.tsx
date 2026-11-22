import { assetPreviewUrl, previewBasePath } from "./url";
import { clearPreviewStore, loadPreviewStore, mergePreviewStoreSnapshot, previewStorageNamespace, readPreviewStoreSnapshot } from "./storage";
import { CornerUpLeft } from "lucide-react";
import { PreviewReceivedFeedback } from "./PreviewReceivedFeedback";
import modernScreenshotSource from "modern-screenshot/dist/index.js?raw";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewSourceInfo, StaticPreviewGrant } from "@genehub/proto";
import type { Client } from "../protocol/client";
import { previewFeedback, useFileFeedback } from "./fileFeedback";
import { HtmlAnnotationOverlay, PreviewReviewChrome } from "./PreviewAnnotation";
import { PreviewFeedbackPanel } from "./PreviewFeedbackPanel";
import {
  PreviewRuntimeControls,
  type PreviewDomSnapshot,
  type PreviewRuntimeEvent,
  type RuntimeArtifactSubmit,
} from "./PreviewRuntimeControls";
import { PreviewFileFeedbackOpenContext, PreviewShareOpenContext, PreviewShareAction, PreviewShell, previewIconButton, PreviewToolbarContext, PreviewToolbarPortal, PreviewNavigation } from "./PreviewToolbar";
import { ServiceMediaPanel } from "./ServiceMediaPanel";
import type { ServicePreviewClient } from "./serviceClient";
import type { PixelSnapshot } from "./runtimeCapture";
import { PreviewShareButton, PreviewShareCopyButton } from "./PreviewShareButton";
import { independentPreviewUrl, isAbsoluteFilePath, type AssetPreviewLocation } from "./url";

type Request = {
  resolve(detail: unknown): void;
  reject(error: Error): void;
  timer: number;
};

function viewedPath(origin: string, start: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.origin !== origin || !/\.html?$/i.test(decodeURIComponent(url.pathname))) return null;
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    if (parts.some(part => !part || part.startsWith(".") || /[/\\\x00-\x1f]/.test(part))) return null;
    return start.slice(0, start.lastIndexOf("/") + 1) + parts.join("/");
  } catch {
    return null;
  }
}

function runtimeDetail(value: unknown): PreviewRuntimeEvent["detail"] {
  const result: PreviewRuntimeEvent["detail"] = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      if (key.length > 80 || key === "__proto__") continue;
      if (typeof item === "string") result[key] = item.slice(0, 1024);
      else if (item === null || typeof item === "boolean" || typeof item === "number") result[key] = item;
    }
  }
  return result;
}

function expectDom(value: unknown): PreviewDomSnapshot {
  const snapshot = value as Partial<PreviewDomSnapshot> | null;
  if (!snapshot || typeof snapshot.html !== "string" || snapshot.html.length > 300_000
    || typeof snapshot.location !== "string" || typeof snapshot.truncated !== "boolean"
    || typeof snapshot.viewportWidth !== "number" || typeof snapshot.viewportHeight !== "number") {
    throw new Error("独立预览返回了无效的 DOM 快照");
  }
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const bounded = (value: unknown, maximum: number) => typeof value === "string" ? value.slice(0, maximum) : "";
  return {
    capturedAt: finite(snapshot.capturedAt),
    html: snapshot.html,
    truncated: snapshot.truncated,
    title: bounded(snapshot.title, 500),
    location: bounded(snapshot.location, 4096),
    viewportWidth: finite(snapshot.viewportWidth),
    viewportHeight: finite(snapshot.viewportHeight),
    scrollX: finite(snapshot.scrollX),
    scrollY: finite(snapshot.scrollY),
    activeElement: bounded(snapshot.activeElement, 240),
    mutationCount: finite(snapshot.mutationCount),
  };
}

function expectPixels(value: unknown): PixelSnapshot {
  const snapshot = value as (Partial<PixelSnapshot> & { error?: unknown }) | null;
  if (typeof snapshot?.error === "string") throw new Error(snapshot.error.slice(0, 300));
  if (!snapshot || !(snapshot.blob instanceof Blob) || snapshot.blob.size > 2_000_000
    || !/^image\/(png|jpeg|webp)$/.test(snapshot.blob.type)
    || typeof snapshot.width !== "number" || !Number.isFinite(snapshot.width) || snapshot.width <= 0
    || typeof snapshot.height !== "number" || !Number.isFinite(snapshot.height) || snapshot.height <= 0
    || typeof snapshot.capturedAt !== "number" || !Number.isFinite(snapshot.capturedAt)
    || snapshot.mode !== "dom-render") {
    throw new Error("独立预览返回了无效的画面");
  }
  return {
    blob: snapshot.blob, width: snapshot.width, height: snapshot.height,
    capturedAt: snapshot.capturedAt, mode: snapshot.mode,
  };
}

export function IndependentPreviewReview({ client, source, grant, feedbackScope, serviceUrl, stopPlayerUrl, media }: {
  client: Client;
  source: AssetPreviewLocation;
  grant: StaticPreviewGrant;
  feedbackScope: string;
  serviceUrl?: string;
  stopPlayerUrl?: string;
  media?: ServicePreviewClient;
}) {
  const form = useRef<HTMLFormElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const requests = useRef(new Map<string, Request>());
  const eventsRef = useRef<PreviewRuntimeEvent[]>([]);
  const origin = new URL(grant.action).origin;
  const storageNamespace = grant.storageScope ? previewStorageNamespace({
    deviceHandle: source.deviceHandle, workspaceHandle: source.workspaceHandle,
    accessScope: feedbackScope, principalScope: grant.storageScope,
  }, source.siteEntryPath ?? source.path) : null;
  const previousStorage = useRef<Record<string, string>>({});
  const storageSeeded = useRef(false);
  const [storageCount, setStorageCount] = useState(0);
  const [storageProblem, setStorageProblem] = useState("");
  const sendStorage = useCallback(() => {
    if (!storageNamespace || submitted.current === grant.code) return;
    previousStorage.current = loadPreviewStore(storageNamespace);
    frame.current?.contentWindow?.postMessage({source: "genehub-preview-storage-seed", state: previousStorage.current}, origin);
  }, [grant.code, origin, storageNamespace]);
  const [frameName] = useState(() => `genehub-review-${crypto.randomUUID()}`);
  const submitted = useRef<string>();
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [filePath, setFilePath] = useState(source.path);
  const [info, setInfo] = useState<PreviewSourceInfo>();
  const [eventCount, setEventCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");
  const [openShare, setOpenShare] = useState<(() => void) | null>(null);
  const bindShare = useCallback((open: (() => void) | null) => setOpenShare(() => open), []);
  const [documentTitle, setDocumentTitle] = useState("");
  const [navigation, setNavigation] = useState({ at: -1, length: 0 });
  const trail = useRef<{ entries: string[]; at: number; pending?: number }>({ entries: [], at: -1 });
  const [route, setRoute] = useState("");
  const initialRelatedPage = useRef(new URLSearchParams(window.location.search).get("previewPath"));
  const [newWindowLink, setNewWindowLink] = useState<{ url: string; label: string }>();
  const [openFeedback, setOpenFeedback] = useState<(() => void) | null>(null);
  const bindFeedback = useCallback((open: (() => void) | null) => setOpenFeedback(() => open), []);
  const workspaceId = isAbsoluteFilePath(filePath) ? "" : source.workspaceHandle;
  const version = info?.path === filePath ? info.version : "";
  const mayWrite = !!version && info?.feedbackWritable !== false;
  const feedback = useFileFeedback(client, workspaceId, filePath, version, feedbackScope);

  useEffect(() => {
    const pending = requests.current;
    const submit = () => {
      if (submitted.current === grant.code || !form.current) return;
      submitted.current = grant.code;
      form.current.submit();
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      if (storageNamespace && event.data?.source === "genehub-preview-storage-waiting") {
        sendStorage();
        return;
      }
      if (storageNamespace && event.data?.source === "genehub-preview-storage-seeded") {
        if (submitted.current === grant.code) return;
        storageSeeded.current = event.data.restored === true;
        if (!storageSeeded.current) {
          setStorageProblem("浏览器限制了独立域存储。本次对存档的改动可能无法保留。");
        }
        setStorageCount(Object.keys(previousStorage.current).length);
        submit();
        return;
      }
      if (storageNamespace && event.data?.source === "genehub-preview-storage-native") {
        if (!storageSeeded.current || submitted.current !== grant.code) return;
        const snapshot = readPreviewStoreSnapshot(event.data.snapshot);
        if (!snapshot) return;
        if (mergePreviewStoreSnapshot(storageNamespace, previousStorage.current, snapshot)) {
          previousStorage.current = snapshot;
          setStorageCount(Object.keys(snapshot).length);
        } else {
          setStorageProblem("存档未写入。请检查浏览器存储空间。");
        }
        return;
      }
      const { source: protocol, kind, requestId, detail } = event.data ?? {};
      if (protocol === "genehub-preview-diag" && ["console", "error", "resource", "csp", "log"].includes(kind)) {
        const sanitized = runtimeDetail(detail);
        if (sanitized.topic === "html-preview-iframe" && sanitized.phase === "bridge-ready") {
          const path = viewedPath(origin, source.path, sanitized.url);
          if (!path) return;
          eventsRef.current = [];
          setFilePath(path);
          setReady(true);
        }
        const events = eventsRef.current;
        if (events.length >= 1_000) events.shift();
        events.push({ at: Date.now(), kind, detail: sanitized });
        setEventCount(count => count + 1);
        return;
      }
      if (protocol !== "genehub-preview-runtime") return;
      if (kind === "review-new-window") {
        const urlText = detail?.url;
        if (typeof urlText !== "string" || urlText.length > 4096) return;
        let target: URL;
        try { target = new URL(urlText); } catch { return; }
        if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) return;
        if (target.origin !== origin) {
          setNewWindowLink({ url: target.href, label: `打开外部网站 ${target.host}` });
          return;
        }
        if (!viewedPath(origin, source.path, target.href)) return;
        const url = new URL(independentPreviewUrl(source));
        url.searchParams.set("review", "1");
        url.searchParams.set("previewPath", target.pathname + target.search + target.hash);
        if (feedbackScope !== "owner") url.hash = window.location.hash;
        setNewWindowLink({ url: url.href, label: "在新窗口打开目标页" });
        return;
      }
      if (kind === "review-location") {
        const urlText = detail?.url;
        if (typeof urlText !== "string" || urlText.length > 4096) return;
        let url: URL;
        try { url = new URL(urlText); } catch { return; }
        if (url.origin !== origin || url.username || url.password || url.pathname.startsWith("/.well-known/")) return;
        const initial = initialRelatedPage.current;
        initialRelatedPage.current = null;
        if (initial?.startsWith("/") && initial.length <= 4096) {
          try {
            const related = new URL(initial, origin);
            if (related.href !== url.href && viewedPath(origin, source.path, related.href)) {
              frame.current?.contentWindow?.postMessage({
                source: "genehub-preview-runtime-command", command: "review-go", url: related.href,
              }, origin);
              return;
            }
          } catch { /* Ignore an invalid linked page and retain the entry. */ }
        }
        const history = trail.current;
        const pendingIndex = history.pending;
        if (pendingIndex !== undefined && url.href === history.entries[pendingIndex]) {
          history.at = pendingIndex;
        } else if (url.href !== history.entries[history.at]) {
          if (detail.action === "replace" && history.at >= 0) history.entries[history.at] = url.href;
          else {
            history.entries = [...history.entries.slice(0, history.at + 1), url.href].slice(-100);
            history.at = history.entries.length - 1;
          }
        }
        history.pending = undefined;
        setNavigation({ at: history.at, length: history.entries.length });
        setRoute(url.pathname + url.search + url.hash);
        setDocumentTitle(typeof detail.title === "string" ? detail.title.slice(0, 500) : "");
        return;
      }
      if (kind !== "dom-snapshot" && kind !== "render-snapshot") return;
      const request = pending.get(requestId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.resolve(detail);
    };
    window.addEventListener("message", receive);
    // Older daemons have no storage handshake. If the browser blocks the
    // handshake, still attempt opening the page without clearing old saves.
    const storageTimeout = storageNamespace ? window.setTimeout(() => {
      if (submitted.current === grant.code) return;
      setStorageProblem("独立域存档连接超时，本次打开保留之前的存档。");
      submit();
    }, 2500) : undefined;
    if (storageNamespace) sendStorage();
    else submit();
    return () => {
      window.clearTimeout(storageTimeout);
      window.removeEventListener("message", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("独立预览已关闭"));
      }
      pending.clear();
    };
  }, [feedbackScope, grant.code, origin, sendStorage, source, storageNamespace]);

  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => setProblem("独立预览未返回工具就绪信号。请重新打开。"), 15_000);
    return () => clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    let current = true;
    setProblem("");
    void previewFeedback(client, workspaceId, { kind: "source", path: filePath })
      .then(reply => {
        if (!current) return;
        if (reply.kind !== "source") throw new Error("无法读取独立预览的文件版本");
        setInfo(reply.data);
      })
      .catch(error => { if (current) setProblem(String(error)); });
    return () => { current = false; };
  }, [client, filePath, ready, workspaceId]);

  useEffect(() => {
    if (!documentTitle) return;
    const previous = document.title;
    document.title = documentTitle;
    return () => { if (document.title === documentTitle) document.title = previous; };
  }, [documentTitle]);

  const go = (index: number) => {
    const url = trail.current.entries[index];
    if (!url || index === trail.current.at || !frame.current?.contentWindow) return;
    trail.current.pending = index;
    for (const request of requests.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("预览页面已切换"));
    }
    requests.current.clear();
    frame.current.contentWindow.postMessage({
      source: "genehub-preview-runtime-command", command: "review-go", url,
    }, origin);
  };

  const queryFrame = useCallback((command: "snapshot-dom" | "snapshot-render", timeout: number) => {
    const target = frame.current?.contentWindow;
    if (!target) return Promise.reject(new Error("独立预览页面未就绪"));
    const requestId = crypto.randomUUID();
    const pending = requests.current;
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("独立预览采集超时"));
      }, timeout);
      pending.set(requestId, { resolve, reject, timer });
      target.postMessage({
        source: "genehub-preview-runtime-command", command, requestId,
        ...(command === "snapshot-render" ? { renderer: modernScreenshotSource } : {}),
      }, origin);
    });
  }, [origin]);
  const requestDomSnapshot = useCallback(() => queryFrame("snapshot-dom", 3000).then(expectDom), [queryFrame]);
  const requestRenderedSnapshot = useCallback(() => queryFrame("snapshot-render", 15000).then(expectPixels), [queryFrame]);
  const save: RuntimeArtifactSubmit = useCallback(async (artifact, progress) => {
    const bundle = await feedback.upload(artifact, ({ uploadedBytes, totalBytes }) => progress(uploadedBytes, totalBytes));
    return { relativePath: bundle.relativePath, addedToDraft: false, feedbackSaved: true };
  }, [feedback.upload]);

  const returnUrl = new URLSearchParams(window.location.search).get("workbenchReturn");
  const base = previewBasePath().replace(/\/$/, "");
  const mayReturn = feedbackScope === "owner" && returnUrl?.startsWith(base + "/")
    && !returnUrl.startsWith("//") && !returnUrl.includes("\\");
  const legacyUrl = new URL(assetPreviewUrl(source.deviceHandle, source.workspaceHandle, source.path, undefined, undefined, source));
  if (feedbackScope !== "owner") legacyUrl.hash = window.location.hash;
  return (
    <PreviewToolbarContext.Provider value={toolbar}>
      <PreviewFileFeedbackOpenContext.Provider value={openFeedback}>
        <main className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
          <PreviewShareOpenContext.Provider value={openShare}>
          <PreviewShell bindTools={setToolbar}
            navigation={mayReturn ? <a className={previewIconButton} href={returnUrl ?? undefined} aria-label="返回对话" title="返回对话"><CornerUpLeft size={16} /></a> : null} readOnly={info?.feedbackWritable === false} information={<dl className="space-y-2">
            <div><dt className="text-muted">页面</dt><dd className="break-words">{documentTitle}</dd></div>
            <div><dt className="text-muted">页面地址</dt><dd className="break-all font-mono">{route}</dd></div>
            {feedbackScope === "owner" && info ? <div><dt className="text-muted">源文件</dt><dd className="break-all">{info.displayPath}</dd></div> : null}
            {storageNamespace ? <div><dt className="text-muted">作品存档</dt><dd>{storageCount} 项
              {storageCount && storageSeeded.current ? <button type="button" className="ml-2 underline" onClick={() => {
                clearPreviewStore(storageNamespace);
                previousStorage.current = {};
                frame.current?.contentWindow?.postMessage({
                  source: "genehub-preview-runtime-command", command: "clear-native-storage",
                }, origin);
                setStorageCount(0);
              }}>清除</button> : null}</dd></div> : null}
            {storageProblem ? <p role="status">{storageProblem}</p> : null}
            <div><dt className="text-muted">访问权限</dt><dd>{feedbackScope === "owner" ? "已有权限" : info?.feedbackWritable === false ? "仅观看" : "限时分享"}</dd></div>
          </dl>}>
          <PreviewNavigation back={navigation.at > 0 ? () => go(navigation.at - 1) : undefined}
            forward={navigation.at >= 0 && navigation.at + 1 < navigation.length ? () => go(navigation.at + 1) : undefined} />
          <PreviewShareAction />
          <PreviewToolbarPortal>
            {serviceUrl ? <a href={serviceUrl} className="truncate rounded px-1 text-xs">启用本地服务</a> : null}
            {stopPlayerUrl ? <a href={stopPlayerUrl} className="truncate rounded px-1 text-xs">停止引擎串流</a> : null}
          </PreviewToolbarPortal>
          {newWindowLink ? <div className="flex gap-2 border-b border-line px-3 py-1 text-xs">
            <a href={newWindowLink.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">{newWindowLink.label}</a>
            <button type="button" className="rounded px-2 py-1 hover:bg-raised" onClick={() => setNewWindowLink(undefined)}>取消</button>
          </div> : null}
          {problem ? <p role="alert" className="px-3 py-1 text-xs text-danger">{problem}
            <a className="ml-2 underline" href={legacyUrl.href}>使用兼容预览打开</a></p> : null}
          <form ref={form} hidden method="post" target={frameName} action={grant.action}>
            <input type="hidden" name="code" value={grant.code} />
          </form>
          <PreviewReviewChrome
            client={client} sessionId={null} path={filePath} version={version} kind="html"
            enabled={mayWrite} fileFeedback={mayWrite ? feedback.review : undefined}
          >
            <PreviewRuntimeControls
              frameRef={frame} ready={ready} entryPath={filePath} sourceVersion={version}
              eventCount={eventCount} eventsRef={eventsRef}
              requestDomSnapshot={requestDomSnapshot} requestRenderedSnapshot={requestRenderedSnapshot}
              onSubmit={mayWrite ? save : undefined} allowCapture={feedbackScope === "owner" || mayWrite}
            />
            {media ? <ServiceMediaPanel service={media} /> : null}
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <iframe ref={frame} title="独立 HTML 预览" name={frameName} src={origin + "/.well-known/genehub/preview-frame"}
                onLoad={sendStorage}
                sandbox={`allow-scripts allow-same-origin${stopPlayerUrl ? " allow-pointer-lock" : ""}`}
                allow={`cross-origin-isolated; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'${stopPlayerUrl ? "; autoplay 'src'" : ""}`}
                referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full border-0 bg-white"
              />
              <HtmlAnnotationOverlay frameRef={frame} frameReady={ready} origin={origin} />
            </div>
          </PreviewReviewChrome>
          {feedbackScope === "owner" && client.identity?.features?.includes("preview.feedback.list.v1") ? <PreviewReceivedFeedback
            key={`received:${filePath}`} client={client} workspaceId={workspaceId} path={filePath} version={version} /> : null}
          {mayWrite ? <PreviewFeedbackPanel key={`compose:${filePath}`} feedback={feedback} bindOpen={bindFeedback} /> : null}
          {feedbackScope === "owner"
            ? <PreviewShareButton client={client} source={source} trigger={false} bindOpen={bindShare} independent allowReview />
            : <PreviewShareCopyButton trigger={false} bindOpen={bindShare} />}
          </PreviewShell>
          </PreviewShareOpenContext.Provider>
        </main>
      </PreviewFileFeedbackOpenContext.Provider>
    </PreviewToolbarContext.Provider>
  );
}

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
import { PreviewFileFeedbackOpenContext, PreviewToolbarContext } from "./PreviewToolbar";
import { ServiceMediaPanel } from "./ServiceMediaPanel";
import type { ServicePreviewClient } from "./serviceClient";
import type { PixelSnapshot } from "./runtimeCapture";
import { isAbsoluteFilePath, type AssetPreviewLocation } from "./url";

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
  const [frameName] = useState(() => `genehub-review-${crypto.randomUUID()}`);
  const submitted = useRef<string>();
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [filePath, setFilePath] = useState(source.path);
  const [info, setInfo] = useState<PreviewSourceInfo>();
  const [eventCount, setEventCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");
  const [openFeedback, setOpenFeedback] = useState<(() => void) | null>(null);
  const bindFeedback = useCallback((open: (() => void) | null) => setOpenFeedback(() => open), []);
  const workspaceId = isAbsoluteFilePath(filePath) ? "" : source.workspaceHandle;
  const version = info?.path === filePath ? info.version : "";
  const feedback = useFileFeedback(client, workspaceId, filePath, version, feedbackScope);

  useEffect(() => {
    const pending = requests.current;
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
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
        setEventCount(events.length);
        return;
      }
      if (protocol !== "genehub-preview-runtime") return;
      if (kind !== "dom-snapshot" && kind !== "render-snapshot") return;
      const request = pending.get(requestId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.resolve(detail);
    };
    window.addEventListener("message", receive);
    if (submitted.current !== grant.code) {
      submitted.current = grant.code;
      form.current?.submit();
    }
    return () => {
      window.removeEventListener("message", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("独立预览已关闭"));
      }
      pending.clear();
    };
  }, [grant.code, origin, source.path]);

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

  return (
    <PreviewToolbarContext.Provider value={toolbar}>
      <PreviewFileFeedbackOpenContext.Provider value={openFeedback}>
        <main className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1">
            <span className="truncate text-sm">{filePath.slice(filePath.lastIndexOf("/") + 1)}</span>
            <div className="flex items-center gap-2">
              {serviceUrl ? <a href={serviceUrl} className="rounded border border-line px-2 py-1 text-xs">启用本地服务</a> : null}
              {stopPlayerUrl ? <a href={stopPlayerUrl} className="rounded border border-line px-2 py-1 text-xs">停止引擎串流</a> : null}
              <div ref={setToolbar} className="flex items-center gap-2" />
            </div>
          </header>
          {problem ? <p role="alert" className="px-3 py-1 text-xs text-danger">{problem}</p> : null}
          <form ref={form} hidden method="post" target={frameName} action={grant.action}>
            <input type="hidden" name="code" value={grant.code} />
          </form>
          <PreviewReviewChrome
            client={client} sessionId={null} path={filePath} version={version} kind="html"
            enabled={!!version} fileFeedback={feedback.review}
          >
            <PreviewRuntimeControls
              frameRef={frame} ready={ready} entryPath={filePath} sourceVersion={version}
              eventCount={eventCount} eventsRef={eventsRef}
              requestDomSnapshot={requestDomSnapshot} requestRenderedSnapshot={requestRenderedSnapshot}
              onSubmit={version ? save : undefined}
            />
            {media ? <ServiceMediaPanel service={media} /> : null}
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <iframe ref={frame} title="独立 HTML 预览" name={frameName} src={origin + "/.well-known/genehub/preview-frame"}
                sandbox={`allow-scripts allow-same-origin${stopPlayerUrl ? " allow-pointer-lock" : ""}`}
                allow={`cross-origin-isolated; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'${stopPlayerUrl ? "; autoplay 'src'" : ""}`}
                referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full border-0 bg-white"
              />
              <HtmlAnnotationOverlay frameRef={frame} frameReady={ready} origin={origin} />
            </div>
          </PreviewReviewChrome>
          <PreviewFeedbackPanel feedback={feedback} bindOpen={bindFeedback} />
        </main>
      </PreviewFileFeedbackOpenContext.Provider>
    </PreviewToolbarContext.Provider>
  );
}

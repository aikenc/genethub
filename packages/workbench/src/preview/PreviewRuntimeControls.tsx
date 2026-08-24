import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PreviewPixelCapture,
  supportsDisplayCapture,
  type PixelRecording,
  type PixelSnapshot,
} from "./runtimeCapture";

export type PreviewRuntimeEvent = {
  at: number;
  kind: string;
  detail: Record<string, string | number | boolean | null>;
};

export type PreviewDomSnapshot = {
  capturedAt: number;
  html: string;
  truncated: boolean;
  title: string;
  location: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  activeElement: string;
  mutationCount: number;
};

export type RuntimeArtifactSubmission = {
  files: Array<{ name: string; mime: string; blob: Blob }>;
  metadata: RuntimeArtifactJson;
  summary: {
    eventCount: number;
    frameCount: number;
    recording: null | { durationMs: number; bytes: number };
  };
};

export type RuntimeArtifactJson =
  | null
  | boolean
  | number
  | string
  | RuntimeArtifactJson[]
  | { [key: string]: RuntimeArtifactJson };

export type RuntimeArtifactSaveResult = {
  relativePath: string;
  addedToDraft: boolean;
  draftError?: string;
};

export type RuntimeArtifactSubmit = (
  artifact: RuntimeArtifactSubmission,
  onProgress: (uploadedBytes: number, totalBytes: number) => void,
) => Promise<RuntimeArtifactSaveResult>;

type RuntimeFrame = {
  at: number;
  reason: "manual" | "recording-start" | "recording-sample" | "recording-end" | "upload";
  pixel: PixelSnapshot | null;
  pixelError: string | null;
  dom: PreviewDomSnapshot;
};

export type RuntimeRecording =
  | ({ kind: "video" } & PixelRecording)
  | {
      kind: "frame-sequence";
      durationMs: number;
      requestedFps: number;
      actualFps: number | null;
      mode: "dom-render";
    };

const RECORDING_FPS = 30;
const FRAME_SEQUENCE_FPS = 1;
const DOM_SAMPLE_MS = 1_000;
const MAX_RECORDING_MS = 60_000;
const MAX_RUNTIME_FRAMES = 60;

export function PreviewRuntimeControls({
  frameRef,
  ready,
  entryPath,
  sourceVersion,
  eventsRef,
  eventCount,
  requestDomSnapshot,
  requestRenderedSnapshot,
  onSubmit,
}: {
  frameRef: React.RefObject<HTMLIFrameElement>;
  ready: boolean;
  entryPath: string;
  sourceVersion?: string;
  eventsRef: React.MutableRefObject<PreviewRuntimeEvent[]>;
  eventCount: number;
  requestDomSnapshot(): Promise<PreviewDomSnapshot>;
  requestRenderedSnapshot(): Promise<PixelSnapshot>;
  onSubmit?: RuntimeArtifactSubmit;
}) {
  const captureHandle = useMemo(
    () => runtimeId("capture"),
    [entryPath, sourceVersion],
  );
  const engineRef = useRef<PreviewPixelCapture | null>(null);
  const framesRef = useRef<RuntimeFrame[]>([]);
  const frameInFlight = useRef(false);
  const recordingRef = useRef(false);
  const recordingStartedAt = useRef(0);
  const captureStrategyRef = useRef<"display" | "dom-render">(
    supportsDisplayCapture() ? "display" : "dom-render",
  );
  const recordingKindRef = useRef<RuntimeRecording["kind"] | null>(null);
  const sampleTimer = useRef<number | null>(null);
  const elapsedTimer = useRef<number | null>(null);
  const maximumTimer = useRef<number | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [captureActive, setCaptureActive] = useState(false);
  const [busy, setBusy] = useState<"screenshot" | "recording" | "upload" | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingResult, setRecordingResult] = useState<RuntimeRecording | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState("正在连接日志采集…");

  const clearRecordingTimers = useCallback(() => {
    for (const timer of [sampleTimer, elapsedTimer, maximumTimer]) {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    const engine = new PreviewPixelCapture(captureHandle, () => {
      recordingRef.current = false;
      setRecording(false);
      setCaptureActive(false);
      clearRecordingTimers();
      setNotice("浏览器已停止共享 Preview");
    });
    engineRef.current = engine;
    framesRef.current = [];
    captureStrategyRef.current = supportsDisplayCapture() ? "display" : "dom-render";
    recordingKindRef.current = null;
    setFrameCount(0);
    setCaptureActive(false);
    setRecordingResult(null);
    setRecordingUrl(null);
    setNotice("正在连接日志采集…");
    return () => {
      clearRecordingTimers();
      engine.dispose();
      engineRef.current = null;
    };
  }, [captureHandle, clearRecordingTimers]);

  useEffect(() => {
    setNotice(
      ready
        ? "日志已开始记录"
        : onSubmit
          ? "可先保存当前日志；截图与录制正在就绪…"
          : "未关联会话，无法保存运行产物",
    );
  }, [onSubmit, ready]);

  useEffect(() => {
    if (!recordingResult || recordingResult.kind !== "video") {
      setRecordingUrl(null);
      return;
    }
    const url = URL.createObjectURL(recordingResult.blob);
    setRecordingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recordingResult]);

  const captureFrame = useCallback(
    async (
      reason: RuntimeFrame["reason"],
      {
        allowDomOnly = false,
        nonInteractive = false,
      }: { allowDomOnly?: boolean; nonInteractive?: boolean } = {},
    ): Promise<RuntimeFrame | null> => {
      if (frameInFlight.current) return null;
      const target = frameRef.current;
      const engine = engineRef.current;
      if (!target || !engine || !ready) throw new Error("Preview 尚未准备好");
      frameInFlight.current = true;
      try {
        const capturePixel = async (): Promise<PixelSnapshot> => {
          if (nonInteractive || captureStrategyRef.current === "dom-render") {
            return requestRenderedSnapshot();
          }
          try {
            return await engine.capture(target);
          } catch (error) {
            if (!shouldFallBackToDomRender(error)) throw error;
            engine.dispose();
            captureStrategyRef.current = "dom-render";
            setCaptureActive(false);
            return requestRenderedSnapshot();
          }
        };
        const pixelPromise = capturePixel().then(
          (pixel) => ({ pixel, error: null }),
          (error: unknown) => ({ pixel: null, error }),
        );
        const domPromise = requestDomSnapshot().catch((error) =>
          failedDomSnapshot(error, target),
        );
        const [{ pixel, error }, dom] = await Promise.all([pixelPromise, domPromise]);
        if (!pixel && !allowDomOnly) throw error;
        const frame = {
          at: Date.now(),
          reason,
          pixel,
          pixelError: pixel ? null : errorMessage(error),
          dom,
        } satisfies RuntimeFrame;
        const next = [...framesRef.current, frame].slice(-MAX_RUNTIME_FRAMES);
        framesRef.current = next;
        setFrameCount(next.length);
        return frame;
      } finally {
        frameInFlight.current = false;
      }
    },
    [frameRef, ready, requestDomSnapshot, requestRenderedSnapshot],
  );

  const takeScreenshot = useCallback(async () => {
    setBusy("screenshot");
    setNotice(
      captureStrategyRef.current === "display"
        ? "请选择共享当前标签页…"
        : "正在生成 Preview 画面…",
    );
    try {
      const frame = await captureFrame("manual");
      if (frame?.pixel) {
        setCaptureActive(Boolean(engineRef.current?.active));
        setNotice(
          frame.pixel.mode === "dom-render"
            ? `已截取 Preview 画面 ${frame.pixel.width}×${frame.pixel.height} 和 DOM 状态`
            : `已截取真实渲染图 ${frame.pixel.width}×${frame.pixel.height} 和 DOM 状态`,
        );
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [captureFrame]);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return recordingResult;
    setBusy("recording");
    clearRecordingTimers();
    try {
      await captureFrame("recording-end", { allowDomOnly: true }).catch(() => null);
      const durationMs = Math.max(0, Date.now() - recordingStartedAt.current);
      let result: RuntimeRecording | null = null;
      if (recordingKindRef.current === "video") {
        const video = await engineRef.current?.stopRecording();
        if (video) result = { kind: "video", ...video };
      } else if (recordingKindRef.current === "frame-sequence") {
        const imageCount = framesRef.current.filter(
          (frame) => frame.at >= recordingStartedAt.current && frame.pixel,
        ).length;
        result = {
          kind: "frame-sequence",
          durationMs,
          requestedFps: FRAME_SEQUENCE_FPS,
          actualFps: durationMs > 0 ? imageCount / (durationMs / 1_000) : null,
          mode: "dom-render",
        };
      }
      recordingRef.current = false;
      recordingKindRef.current = null;
      setRecording(false);
      setCaptureActive(Boolean(engineRef.current?.active));
      if (result) {
        setRecordingResult(result);
        setNotice(
          result.kind === "video"
            ? `体验录制完成：${formatSeconds(result.durationMs)}，视频 ${displayFps(result)}，DOM 1fps`
            : `体验录制完成：${formatSeconds(result.durationMs)}，画面与 DOM 1fps`,
        );
      }
      return result ?? null;
    } catch (error) {
      recordingRef.current = false;
      recordingKindRef.current = null;
      setRecording(false);
      setNotice(errorMessage(error));
      return null;
    } finally {
      setBusy(null);
    }
  }, [captureFrame, clearRecordingTimers, recordingResult]);

  const startRecording = useCallback(async () => {
    const target = frameRef.current;
    const engine = engineRef.current;
    if (!target || !engine || !ready) return;
    setBusy("recording");
    let displayCapture = captureStrategyRef.current === "display";
    setNotice(displayCapture ? "请选择共享当前标签页…" : "正在启动移动端画面采样…");
    try {
      if (displayCapture) {
        try {
          await engine.startRecording(target, RECORDING_FPS);
        } catch (error) {
          if (!shouldFallBackToDomRender(error)) throw error;
          engine.dispose();
          captureStrategyRef.current = "dom-render";
          displayCapture = false;
        }
      }
      recordingKindRef.current = displayCapture ? "video" : "frame-sequence";
      setCaptureActive(displayCapture);
      recordingStartedAt.current = Date.now();
      recordingRef.current = true;
      setRecording(true);
      setElapsedSeconds(0);
      setRecordingResult(null);
      await captureFrame("recording-start", { allowDomOnly: true });
      sampleTimer.current = window.setInterval(() => {
        void captureFrame("recording-sample", { allowDomOnly: true }).catch((error) =>
          setNotice(errorMessage(error)),
        );
      }, DOM_SAMPLE_MS);
      elapsedTimer.current = window.setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - recordingStartedAt.current) / 1_000));
      }, 500);
      maximumTimer.current = window.setTimeout(() => {
        void stopRecording();
      }, MAX_RECORDING_MS);
      setNotice(
        displayCapture
          ? "体验录制中：视频 30fps，DOM 与关键帧 1fps"
          : "体验录制中：画面与 DOM 1fps，日志持续记录",
      );
    } catch (error) {
      recordingRef.current = false;
      recordingKindRef.current = null;
      setRecording(false);
      engine.dispose();
      setCaptureActive(false);
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [captureFrame, frameRef, ready, stopRecording]);

  const uploadArtifact = useCallback(async () => {
    if (!onSubmit) {
      setNotice("请在会话内打开 Preview 后上传运行产物");
      return;
    }
    setBusy("upload");
    try {
      let recordingForReport = recordingResult;
      if (recordingRef.current) recordingForReport = await stopRecording();
      // Saving must never open a screen-share picker. A picker can remain pending
      // forever in a popout and prevent the artifact receipt from being shown.
      await captureFrame("upload", {
        allowDomOnly: true,
        nonInteractive: true,
      }).catch((error) => {
        eventsRef.current = [
          ...eventsRef.current,
          {
            at: Date.now(),
            kind: "error",
            detail: { topic: "artifact-capture", message: errorMessage(error) },
          },
        ].slice(-1_000);
      });
      const artifact = await buildRuntimeArtifactSubmission({
        entryPath,
        sourceVersion,
        events: eventsRef.current,
        frames: framesRef.current,
        recording: recordingForReport,
      });
      const saved = await onSubmit(artifact, (uploadedBytes, totalBytes) => {
        const percentage = totalBytes > 0 ? Math.floor((uploadedBytes / totalBytes) * 100) : 100;
        setNotice(`正在写入 daemon 当前 session… ${percentage}%`);
      });
      engineRef.current?.dispose();
      setCaptureActive(false);
      setNotice(
        saved.addedToDraft
          ? `已保存到 ${saved.relativePath}，已加入输入框`
          : `已保存到 ${saved.relativePath}；${saved.draftError ?? "未加入输入框"}`,
      );
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [captureFrame, entryPath, eventsRef, onSubmit, recordingResult, sourceVersion, stopRecording]);

  const captureDisabled = !ready || busy !== null;
  const saveDisabled = busy !== null || !onSubmit;
  const videoExtension =
    recordingResult?.kind === "video" && recordingResult.mimeType.includes("mp4")
      ? "mp4"
      : "webm";

  return (
    <div className="flex min-h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2 text-[11px] text-muted">
      <span className="min-w-0 flex-1 truncate" role="status" title={notice}>
        {recording ? (
          <span className="text-red-500">● 录制 {elapsedSeconds}s</span>
        ) : (
          notice
        )}
      </span>
      <span className="hidden shrink-0 text-faint sm:inline">
        日志 {eventCount} · 现场 {frameCount}
      </span>
      {recordingUrl ? (
        <a
          className="shrink-0 rounded px-2 py-1 text-accent hover:bg-raised"
          href={recordingUrl}
          download={`preview-experience-${Date.now()}.${videoExtension}`}
          title="保存完整高帧率体验视频"
        >
          保存视频
        </a>
      ) : null}
      {captureActive && !recording ? (
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-faint hover:bg-raised hover:text-fg"
          disabled={busy !== null}
          onClick={() => {
            engineRef.current?.dispose();
            setCaptureActive(false);
            setNotice("已结束 Preview 像素共享；日志继续记录");
          }}
          title="结束浏览器的 Preview 像素共享"
        >
          结束共享
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded border border-line px-2 py-1 hover:bg-raised disabled:opacity-45"
        disabled={captureDisabled || recording}
        onClick={() => void takeScreenshot()}
        title={
          captureStrategyRef.current === "display"
            ? "截取 Preview 的真实渲染像素和当前 DOM"
            : "截取 Preview 的 DOM 渲染画面和当前 DOM"
        }
      >
        截图
      </button>
      <button
        type="button"
        className={`shrink-0 rounded border px-2 py-1 disabled:opacity-45 ${
          recording
            ? "border-red-500/60 bg-red-500/10 text-red-500"
            : "border-line hover:bg-raised"
        }`}
        disabled={!ready || busy !== null}
        onClick={() => void (recording ? stopRecording() : startRecording())}
        title={
          recording
            ? "停止体验录制"
            : captureStrategyRef.current === "display"
              ? "以 30fps 录制真实像素，1fps 采集 DOM"
              : "以 1fps 采集 Preview 画面和 DOM，日志持续记录"
        }
      >
        {recording ? "停止" : "录制"}
      </button>
      <button
        type="button"
        className="shrink-0 rounded bg-accent px-2 py-1 text-white hover:opacity-90 disabled:opacity-45"
        disabled={saveDisabled}
        onClick={() => void uploadArtifact()}
        title={
          onSubmit
            ? ready
              ? "把日志、DOM、截图和体验录制写入 daemon 当前 session，并把路径加入输入框"
              : "先把当前日志写入 daemon；截图和 DOM 会在采集就绪后加入"
            : "需要关联会话后保存"
        }
      >
        保存运行产物
      </button>
    </div>
  );
}

export async function buildRuntimeArtifactSubmission({
  entryPath,
  sourceVersion,
  events,
  frames,
  recording,
}: {
  entryPath: string;
  sourceVersion?: string;
  events: PreviewRuntimeEvent[];
  frames: RuntimeFrame[];
  recording: RuntimeRecording | null;
}): Promise<RuntimeArtifactSubmission> {
  const eventLines = events.map((event) =>
    JSON.stringify({
      at: new Date(event.at).toISOString(),
      kind: event.kind,
      detail: event.detail,
    }),
  );
  const domLines = frames.map((frame, index) =>
    JSON.stringify({
      frame: index + 1,
      at: new Date(frame.at).toISOString(),
      atMs: relativeMs(frame.at, frames),
      reason: frame.reason,
      pixel: frame.pixel
        ? {
            width: frame.pixel.width,
            height: frame.pixel.height,
            capturedAt: new Date(frame.pixel.capturedAt).toISOString(),
            mode: frame.pixel.mode,
          }
        : null,
      pixelError: frame.pixelError,
      dom: frame.dom,
    }),
  );
  const files: RuntimeArtifactSubmission["files"] = [
    {
      name: "events.jsonl",
      mime: "application/x-ndjson",
      blob: new Blob([`${eventLines.join("\n")}${eventLines.length ? "\n" : ""}`], {
        type: "application/x-ndjson",
      }),
    },
    {
      name: "dom.jsonl",
      mime: "application/x-ndjson",
      blob: new Blob([`${domLines.join("\n")}${domLines.length ? "\n" : ""}`], {
        type: "application/x-ndjson",
      }),
    },
  ];
  const frameSummary = frames.map((frame, index) => {
    const pixel = frame.pixel;
    let name: string | null = null;
    if (pixel) {
      const extension = imageExtension(pixel.blob.type);
      name = `frame-${String(index + 1).padStart(3, "0")}.${extension}`;
      files.push({
        name,
        mime: pixel.blob.type || "image/webp",
        blob: pixel.blob,
      });
    }
    return {
      file: name,
      atMs: relativeMs(frame.at, frames),
      reason: frame.reason,
      width: pixel?.width ?? null,
      height: pixel?.height ?? null,
      captureMode: pixel?.mode ?? "dom-only",
      pixelError: frame.pixelError,
      domMutations: frame.dom.mutationCount,
    };
  });
  if (recording?.kind === "video") {
    const extension = recording.mimeType.includes("mp4") ? "mp4" : "webm";
    files.push({
      name: `recording.${extension}`,
      mime: recording.mimeType || `video/${extension}`,
      blob: recording.blob,
    });
  }
  const sampledFrames = frames.filter(
    (frame) => frame.reason.startsWith("recording-") && frame.pixel,
  );
  const sampledBytes = sampledFrames.reduce(
    (total, frame) => total + (frame.pixel?.blob.size ?? 0),
    0,
  );
  const recordingSummary: RuntimeArtifactJson = recording
    ? recording.kind === "video"
      ? {
          kind: recording.kind,
          file: recording.mimeType.includes("mp4") ? "recording.mp4" : "recording.webm",
          durationMs: recording.durationMs,
          mimeType: recording.mimeType,
          bytes: recording.blob.size,
          requestedFps: recording.requestedFps,
          actualFps: recording.actualFps,
          captureMode: recording.mode,
          frameCount: null,
        }
      : {
          kind: recording.kind,
          file: null,
          durationMs: recording.durationMs,
          mimeType: null,
          bytes: sampledBytes,
          requestedFps: recording.requestedFps,
          actualFps: recording.actualFps,
          captureMode: recording.mode,
          frameCount: sampledFrames.length,
        }
    : null;
  return {
    files,
    metadata: {
      schema: "genehub.preview-runtime.v3",
      source: { path: entryPath, version: sourceVersion ?? null },
      capturedAt: new Date().toISOString(),
      eventCount: events.length,
      frameCount: frames.length,
      frames: frameSummary,
      recording: recordingSummary,
    },
    summary: {
      eventCount: events.length,
      frameCount: frames.length,
      recording: recording
        ? {
            durationMs: recording.durationMs,
            bytes: recording.kind === "video" ? recording.blob.size : sampledBytes,
          }
        : null,
    },
  };
}

function relativeMs(at: number, frames: RuntimeFrame[]): number {
  return Math.max(0, at - (frames[0]?.at ?? at));
}

function runtimeId(prefix: string): string {
  try {
    return `genehub-${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `genehub-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function imageExtension(mime: string): "jpg" | "png" | "webp" {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  return "webp";
}

function displayFps(recording: PixelRecording): string {
  const actual = recording.actualFps;
  return `${actual ? Math.round(actual) : recording.requestedFps}fps`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "未获得捕获权限；请重试并选择当前标签页";
  }
  return error instanceof Error ? error.message : "运行产物采集失败";
}

function shouldFallBackToDomRender(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "NotSupportedError") return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("没有向网页开放系统屏幕流") ||
    error.message.includes("不支持 MediaRecorder") ||
    error.message.includes("请选择“当前标签页”")
  );
}

function failedDomSnapshot(error: unknown, target: HTMLElement): PreviewDomSnapshot {
  const message = errorMessage(error);
  return {
    capturedAt: Date.now(),
    html: `<!-- DOM snapshot failed: ${message.replaceAll("--", "—")} -->`,
    truncated: false,
    title: "",
    location: "",
    viewportWidth: Math.max(0, Math.round(target.clientWidth)),
    viewportHeight: Math.max(0, Math.round(target.clientHeight)),
    scrollX: 0,
    scrollY: 0,
    activeElement: "unknown",
    mutationCount: 0,
  };
}

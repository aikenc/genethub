import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PreviewPixelCapture,
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
  pixel: PixelSnapshot;
  dom: PreviewDomSnapshot;
};

const RECORDING_FPS = 30;
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
  onSubmit,
}: {
  frameRef: React.RefObject<HTMLIFrameElement>;
  ready: boolean;
  entryPath: string;
  sourceVersion?: string;
  eventsRef: React.MutableRefObject<PreviewRuntimeEvent[]>;
  eventCount: number;
  requestDomSnapshot(): Promise<PreviewDomSnapshot>;
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
  const sampleTimer = useRef<number | null>(null);
  const elapsedTimer = useRef<number | null>(null);
  const maximumTimer = useRef<number | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [captureActive, setCaptureActive] = useState(false);
  const [busy, setBusy] = useState<"screenshot" | "recording" | "upload" | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingResult, setRecordingResult] = useState<PixelRecording | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState("日志已开始记录");

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
    setFrameCount(0);
    setCaptureActive(false);
    setRecordingResult(null);
    setRecordingUrl(null);
    setNotice("日志已开始记录");
    return () => {
      clearRecordingTimers();
      engine.dispose();
      engineRef.current = null;
    };
  }, [captureHandle, clearRecordingTimers]);

  useEffect(() => {
    if (!recordingResult) {
      setRecordingUrl(null);
      return;
    }
    const url = URL.createObjectURL(recordingResult.blob);
    setRecordingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recordingResult]);

  const captureFrame = useCallback(
    async (reason: RuntimeFrame["reason"]): Promise<RuntimeFrame | null> => {
      if (frameInFlight.current) return null;
      const target = frameRef.current;
      const engine = engineRef.current;
      if (!target || !engine || !ready) throw new Error("Preview 尚未准备好");
      frameInFlight.current = true;
      try {
        const [pixel, dom] = await Promise.all([engine.capture(target), requestDomSnapshot()]);
        const frame = { at: Date.now(), reason, pixel, dom } satisfies RuntimeFrame;
        const next = [...framesRef.current, frame].slice(-MAX_RUNTIME_FRAMES);
        framesRef.current = next;
        setFrameCount(next.length);
        return frame;
      } finally {
        frameInFlight.current = false;
      }
    },
    [frameRef, ready, requestDomSnapshot],
  );

  const takeScreenshot = useCallback(async () => {
    setBusy("screenshot");
    setNotice("请选择共享当前标签页…");
    try {
      const frame = await captureFrame("manual");
      if (frame) {
        setCaptureActive(true);
        setNotice(
          `已截取真实渲染图 ${frame.pixel.width}×${frame.pixel.height} 和 DOM 状态`,
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
      await captureFrame("recording-end");
      const result = await engineRef.current?.stopRecording();
      recordingRef.current = false;
      setRecording(false);
      if (result) {
        setRecordingResult(result);
        setNotice(
          `体验录制完成：${formatSeconds(result.durationMs)}，视频 ${displayFps(result)}，DOM 1fps`,
        );
      }
      return result ?? null;
    } catch (error) {
      recordingRef.current = false;
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
    setNotice("请选择共享当前标签页…");
    try {
      await engine.startRecording(target, RECORDING_FPS);
      setCaptureActive(true);
      recordingStartedAt.current = Date.now();
      recordingRef.current = true;
      setRecording(true);
      setElapsedSeconds(0);
      setRecordingResult(null);
      await captureFrame("recording-start");
      sampleTimer.current = window.setInterval(() => {
        void captureFrame("recording-sample").catch((error) => setNotice(errorMessage(error)));
      }, DOM_SAMPLE_MS);
      elapsedTimer.current = window.setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - recordingStartedAt.current) / 1_000));
      }, 500);
      maximumTimer.current = window.setTimeout(() => {
        void stopRecording();
      }, MAX_RECORDING_MS);
      setNotice("体验录制中：视频 30fps，DOM 与关键帧 1fps");
    } catch (error) {
      recordingRef.current = false;
      setRecording(false);
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
      const finalFrame = await captureFrame("upload");
      if (!finalFrame && framesRef.current.length === 0) {
        throw new Error("没有可上传的运行现场");
      }
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

  const disabled = !ready || busy !== null;
  const videoExtension = recordingResult?.mimeType.includes("mp4") ? "mp4" : "webm";

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
        disabled={disabled || recording}
        onClick={() => void takeScreenshot()}
        title="截取 Preview 的真实渲染像素和当前 DOM"
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
        title={recording ? "停止体验录制" : "以 30fps 录制真实像素，1fps 采集 DOM"}
      >
        {recording ? "停止" : "录制"}
      </button>
      <button
        type="button"
        className="shrink-0 rounded bg-accent px-2 py-1 text-white hover:opacity-90 disabled:opacity-45"
        disabled={disabled || !onSubmit}
        onClick={() => void uploadArtifact()}
        title={
          onSubmit
            ? "把日志、DOM、截图和视频写入 daemon 当前 session，并把路径加入输入框"
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
  recording: PixelRecording | null;
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
      pixel: {
        width: frame.pixel.width,
        height: frame.pixel.height,
        capturedAt: new Date(frame.pixel.capturedAt).toISOString(),
        mode: frame.pixel.mode,
      },
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
    const extension = imageExtension(frame.pixel.blob.type);
    const name = `frame-${String(index + 1).padStart(3, "0")}.${extension}`;
    files.push({
      name,
      mime: frame.pixel.blob.type || "image/webp",
      blob: frame.pixel.blob,
    });
    return {
      file: name,
      atMs: relativeMs(frame.at, frames),
      reason: frame.reason,
      width: frame.pixel.width,
      height: frame.pixel.height,
      captureMode: frame.pixel.mode,
      domMutations: frame.dom.mutationCount,
    };
  });
  if (recording) {
    const extension = recording.mimeType.includes("mp4") ? "mp4" : "webm";
    files.push({
      name: `recording.${extension}`,
      mime: recording.mimeType || `video/${extension}`,
      blob: recording.blob,
    });
  }
  const recordingSummary = recording
    ? {
        file: recording.mimeType.includes("mp4") ? "recording.mp4" : "recording.webm",
        durationMs: recording.durationMs,
        mimeType: recording.mimeType,
        bytes: recording.blob.size,
        requestedFps: recording.requestedFps,
        actualFps: recording.actualFps,
        captureMode: recording.mode,
      }
    : null;
  return {
    files,
    metadata: {
      schema: "genehub.preview-runtime.v2",
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
        ? { durationMs: recording.durationMs, bytes: recording.blob.size }
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

function imageExtension(mime: string): "png" | "webp" {
  return mime === "image/png" ? "png" : "webp";
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

import { useCallback, useRef, useState } from "react";
import { PreviewRuntimeControls, type PreviewRuntimeEvent, type RuntimeArtifactSubmit } from "./PreviewRuntimeControls";
import { VideoTimeAnnotation } from "./PreviewAnnotation";
import type { PixelSnapshot } from "./runtimeCapture";

export function PreviewVideo({ url, path, version, allowCapture, onSubmit }: {
  url: string;
  path: string;
  version: string;
  allowCapture: boolean;
  onSubmit?: RuntimeArtifactSubmit;
}) {
  const player = useRef<HTMLVideoElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const events = useRef<PreviewRuntimeEvent[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const bindVideo = useCallback((node: HTMLVideoElement | null) => {
    player.current = node;
    setVideo(node);
  }, []);

  const log = (message: string, kind = "log") => {
    if (!player.current) return;
    const entry = { at: Date.now(), kind, detail: {
      topic: "media", message, timeMs: Math.round(player.current.currentTime * 1000),
    } };
    events.current = [...events.current, entry].slice(-1000);
    setEventCount(count => count + 1);
  };

  const requestDomSnapshot = useCallback(async () => {
    const media = player.current;
    if (!media) throw new Error("视频未加载");
    // The current playback state is useful evidence. The object URL stays in this document.
    return {
      capturedAt: Date.now(), html: `<video data-time-ms="${Math.round(media.currentTime * 1000)}"></video>`,
      title: "", location: "", truncated: false, viewportWidth: media.clientWidth,
      viewportHeight: media.clientHeight, scrollX: 0, scrollY: 0, activeElement: "", mutationCount: 0,
    };
  }, []);

  const requestRenderedSnapshot = useCallback(async (): Promise<PixelSnapshot> => {
    const media = player.current;
    if (!media?.videoWidth || !media.videoHeight) throw new Error("等待视频首帧后再采集");
    const scale = Math.min(1, 1280 / Math.max(media.videoWidth, media.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法保存当前视频帧");
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.83));
    if (!blob) throw new Error("视频帧编码失败");
    return { blob, width: canvas.width, height: canvas.height, mode: "dom-render", capturedAt: Date.now() };
  }, []);

  return <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-4">
    <video ref={bindVideo} src={url} controls playsInline className="max-h-full max-w-full"
      onLoadedData={() => { setReady(true); log("视频首帧已加载"); }}
      onPlay={() => log("播放")} onPause={() => log("暂停")} onSeeked={() => log("跳转时间点")}
      onError={() => { setReady(false); log("视频无法播放", "error"); }} />
    <VideoTimeAnnotation video={video} />
    <PreviewRuntimeControls frameRef={player} ready={ready} entryPath={path} sourceVersion={version}
      eventsRef={events} eventCount={eventCount} requestDomSnapshot={requestDomSnapshot}
      requestRenderedSnapshot={requestRenderedSnapshot} allowCapture={allowCapture} onSubmit={onSubmit} />
  </div>;
}

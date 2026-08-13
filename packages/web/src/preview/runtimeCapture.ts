export type PreviewCaptureMode = "element" | "region" | "viewport-crop" | "dom-render";

export type PixelSnapshot = {
  blob: Blob;
  width: number;
  height: number;
  capturedAt: number;
  mode: PreviewCaptureMode;
};

export type PixelRecording = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  requestedFps: number;
  actualFps: number | null;
  mode: PreviewCaptureMode;
};

type CaptureHandle = { handle?: string };
type CapturedVideoTrack = MediaStreamTrack & {
  restrictTo?: (target: unknown) => Promise<void>;
  cropTo?: (target: unknown) => Promise<void>;
  getCaptureHandle?: () => CaptureHandle | null;
};
type CaptureTargetFactory = {
  fromElement(element: Element): Promise<unknown>;
};
type CaptureGlobals = typeof globalThis & {
  RestrictionTarget?: CaptureTargetFactory;
  CropTarget?: CaptureTargetFactory;
};
type CaptureMediaDevices = MediaDevices & {
  setCaptureHandleConfig?: (config: {
    handle: string;
    exposeOrigin?: boolean;
    permittedOrigins?: string[];
  }) => void | Promise<void>;
};
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

const MAX_SCREENSHOT_EDGE = 1_600;
const SCREENSHOT_QUALITY = 0.86;
const MAX_SCREENSHOT_BYTES = 1_450_000;

export function supportsDisplayCapture(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      Boolean(
        (navigator.mediaDevices as CaptureMediaDevices | undefined)?.getDisplayMedia,
      )
    );
  } catch {
    return false;
  }
}

/**
 * Captures the browser compositor's real pixels. Element/Region Capture is
 * preferred; coordinate cropping is only allowed after Capture Handle proves
 * that the user selected this tab, so a mistaken picker choice cannot leak a
 * different tab into a runtime artifact.
 */
export class PreviewPixelCapture {
  private stream: MediaStream | null = null;
  private video: FrameVideo | null = null;
  private target: HTMLElement | null = null;
  private mode: PreviewCaptureMode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private recordingStartedAt = 0;
  private recordingFps = 30;
  private recordingStream: MediaStream | null = null;
  private cropCanvas: HTMLCanvasElement | null = null;
  private cropAnimationFrame: number | null = null;
  private ended = false;

  constructor(
    private readonly captureHandle: string,
    private readonly onCaptureEnded?: () => void,
  ) {}

  get active(): boolean {
    return Boolean(this.stream && this.stream.getVideoTracks()[0]?.readyState === "live");
  }

  get captureMode(): PreviewCaptureMode | null {
    return this.mode;
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  async capture(target: HTMLElement): Promise<PixelSnapshot> {
    await this.ensureCapture(target);
    const video = this.requireVideo();
    await nextVideoFrame(video);
    const canvas = this.drawCurrentFrame(target, true);
    return {
      blob: await canvasToBoundedBlob(canvas),
      width: canvas.width,
      height: canvas.height,
      capturedAt: Date.now(),
      mode: this.requireMode(),
    };
  }

  async startRecording(target: HTMLElement, fps = 30): Promise<void> {
    if (this.isRecording) return;
    if (typeof MediaRecorder === "undefined") {
      throw new Error("当前浏览器不支持 MediaRecorder");
    }
    await this.ensureCapture(target, fps);
    const sourceTrack = this.requireStream().getVideoTracks()[0];
    if (!sourceTrack) throw new Error("没有可录制的视频轨道");

    this.recordingFps = fps;
    let recordingStream: MediaStream;
    if (this.mode === "viewport-crop") {
      const canvas = this.drawCurrentFrame(target, false);
      this.cropCanvas = canvas;
      const canvasStream = canvas.captureStream(fps);
      recordingStream = canvasStream;
      this.pumpCroppedFrames(target);
    } else {
      recordingStream = new MediaStream([sourceTrack]);
    }

    const mimeType = preferredRecordingMimeType();
    const recorder = new MediaRecorder(recordingStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 2_500_000,
    });
    this.recordingChunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.recordingChunks.push(event.data);
    });
    recorder.start(1_000);
    this.recorder = recorder;
    this.recordingStream = recordingStream;
    this.recordingStartedAt = Date.now();
  }

  async stopRecording(): Promise<PixelRecording | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    this.stopCropPump();
    for (const track of this.recordingStream?.getTracks() ?? []) {
      if (!this.stream?.getTracks().includes(track)) track.stop();
    }
    const mimeType = recorder.mimeType || this.recordingChunks[0]?.type || "video/webm";
    const result: PixelRecording = {
      blob: new Blob(this.recordingChunks, { type: mimeType }),
      mimeType,
      durationMs: Math.max(0, Date.now() - this.recordingStartedAt),
      requestedFps: this.recordingFps,
      actualFps: this.stream?.getVideoTracks()[0]?.getSettings().frameRate ?? null,
      mode: this.requireMode(),
    };
    this.recorder = null;
    this.recordingStream = null;
    this.recordingChunks = [];
    return result;
  }

  dispose(): void {
    this.ended = true;
    this.stopCropPump();
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    this.recordingStream = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.video = null;
    this.target = null;
    this.mode = null;
  }

  private async ensureCapture(target: HTMLElement, fps = 30): Promise<void> {
    if (this.active && this.target === target) return;
    this.dispose();
    const mediaDevices = navigator.mediaDevices as CaptureMediaDevices | undefined;
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("当前浏览器没有向网页开放系统屏幕流");
    }

    await Promise.resolve(
      mediaDevices.setCaptureHandleConfig?.({
        handle: this.captureHandle,
        permittedOrigins: ["*"],
      }),
    );

    const stream = await mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: false,
      // Chromium hints. They are deliberately hints: the browser keeps the
      // final choice in the user's hands.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
    } as DisplayMediaStreamOptions);
    const track = stream.getVideoTracks()[0] as CapturedVideoTrack | undefined;
    if (!track) {
      stopStream(stream);
      throw new Error("浏览器没有返回视频轨道");
    }
    track.contentHint = "detail";
    await track.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});

    try {
      const mode = await restrictTrackToElement(track, target);
      if (!mode && !isVerifiedSelfCapture(track, this.captureHandle)) {
        throw new Error("请选择“当前标签页”进行共享，才能安全截取 Preview");
      }
      this.stream = stream;
      this.target = target;
      this.mode = mode ?? "viewport-crop";
      this.ended = false;
      track.addEventListener(
        "ended",
        () => {
          if (this.ended) return;
          this.ended = true;
          this.onCaptureEnded?.();
        },
        { once: true },
      );
      this.video = await videoForStream(stream);
    } catch (error) {
      stopStream(stream);
      throw error;
    }
  }

  private drawCurrentFrame(target: HTMLElement, bounded: boolean): HTMLCanvasElement {
    const video = this.requireVideo();
    const source = sourceRectangle(video, target, this.requireMode());
    const scale = bounded
      ? Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(source.width, source.height))
      : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建截图画布");
    context.drawImage(
      video,
      source.x,
      source.y,
      source.width,
      source.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas;
  }

  private pumpCroppedFrames(target: HTMLElement): void {
    const draw = () => {
      const canvas = this.cropCanvas;
      const video = this.video;
      if (!canvas || !video || this.recorder?.state === "inactive") return;
      const source = sourceRectangle(video, target, "viewport-crop");
      if (canvas.width !== Math.round(source.width) || canvas.height !== Math.round(source.height)) {
        canvas.width = Math.max(1, Math.round(source.width));
        canvas.height = Math.max(1, Math.round(source.height));
      }
      canvas
        .getContext("2d")
        ?.drawImage(
          video,
          source.x,
          source.y,
          source.width,
          source.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      this.cropAnimationFrame = requestAnimationFrame(draw);
    };
    this.cropAnimationFrame = requestAnimationFrame(draw);
  }

  private stopCropPump(): void {
    if (this.cropAnimationFrame !== null) cancelAnimationFrame(this.cropAnimationFrame);
    this.cropAnimationFrame = null;
    this.cropCanvas = null;
  }

  private requireStream(): MediaStream {
    if (!this.stream) throw new Error("尚未获得 Preview 捕获权限");
    return this.stream;
  }

  private requireVideo(): FrameVideo {
    if (!this.video) throw new Error("Preview 像素流尚未就绪");
    return this.video;
  }

  private requireMode(): PreviewCaptureMode {
    if (!this.mode) throw new Error("Preview 捕获模式尚未就绪");
    return this.mode;
  }
}

/** Exported for focused browser-capability tests. */
export async function restrictTrackToElement(
  track: CapturedVideoTrack,
  target: HTMLElement,
): Promise<"element" | "region" | null> {
  const globals = globalThis as CaptureGlobals;
  if (globals.RestrictionTarget && track.restrictTo) {
    try {
      const restriction = await globals.RestrictionTarget.fromElement(target);
      await track.restrictTo(restriction);
      return "element";
    } catch {
      // Region Capture is a useful fallback for older Chromium versions and
      // for elements that are temporarily ineligible for Element Capture.
    }
  }
  if (globals.CropTarget && track.cropTo) {
    try {
      const crop = await globals.CropTarget.fromElement(target);
      await track.cropTo(crop);
      return "region";
    } catch {
      return null;
    }
  }
  return null;
}

function isVerifiedSelfCapture(track: CapturedVideoTrack, expected: string): boolean {
  return track.getCaptureHandle?.()?.handle === expected;
}

function sourceRectangle(
  video: HTMLVideoElement,
  target: HTMLElement,
  mode: PreviewCaptureMode,
): { x: number; y: number; width: number; height: number } {
  if (mode !== "viewport-crop") {
    return { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
  }
  const rect = target.getBoundingClientRect();
  const scaleX = video.videoWidth / Math.max(1, window.innerWidth);
  const scaleY = video.videoHeight / Math.max(1, window.innerHeight);
  const x = clamp(rect.left * scaleX, 0, video.videoWidth - 1);
  const y = clamp(rect.top * scaleY, 0, video.videoHeight - 1);
  const width = clamp(rect.width * scaleX, 1, video.videoWidth - x);
  const height = clamp(rect.height * scaleY, 1, video.videoHeight - y);
  return { x, y, width, height };
}

async function videoForStream(stream: MediaStream): Promise<FrameVideo> {
  const video = document.createElement("video") as FrameVideo;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("aria-hidden", "true");
  video.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("等待捕获画面超时")), 5_000);
      video.addEventListener(
        "loadeddata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  await nextVideoFrame(video);
  return video;
}

function nextVideoFrame(video: FrameVideo): Promise<void> {
  return new Promise((resolve) => {
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(() => resolve());
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("截图编码失败"))),
      mime,
      quality,
    );
  });
}

async function canvasToBoundedBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  let last: Blob | null = null;
  for (const quality of [SCREENSHOT_QUALITY, 0.74, 0.62, 0.5]) {
    last = await canvasToBlob(canvas, "image/webp", quality);
    if (last.size <= MAX_SCREENSHOT_BYTES) return last;
  }
  return last ?? canvasToBlob(canvas, "image/webp", 0.5);
}

function preferredRecordingMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

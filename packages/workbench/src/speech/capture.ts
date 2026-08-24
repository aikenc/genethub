const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHUNK_FRAMES = 1_600;
const MIN_FINAL_FRAMES = 320;
const WAVEFORM_BAR_COUNT = 12;
const WAVEFORM_INTERVAL_MS = 32;

export interface CapturedPcmChunk {
  index: number;
  captureStartMs: number;
  durationMs: number;
  pcm: Uint8Array;
}

export interface CapturedWaveform {
  /** Normalized, smoothed peak levels for direct rendering. */
  bars: number[];
  /** Unscaled root-mean-square input level, used only for local voice activity hints. */
  rms: number;
}

/** Stateful linear resampling with exact 16 kHz PCM chunk boundaries. */
export class Pcm16Resampler {
  private source = new Float32Array();
  private position = 0;
  private pending: number[] = [];

  constructor(
    private readonly inputRate: number,
    private readonly outputRate = TARGET_SAMPLE_RATE,
    private readonly chunkFrames = TARGET_CHUNK_FRAMES,
  ) {
    if (inputRate <= 0 || outputRate <= 0 || chunkFrames <= 0) {
      throw new RangeError("invalid PCM resampler configuration");
    }
  }

  push(input: Float32Array): Uint8Array[] {
    if (input.byteLength === 0) return [];
    const joined = new Float32Array(this.source.length + input.length);
    joined.set(this.source);
    joined.set(input, this.source.length);
    this.source = joined;

    const step = this.inputRate / this.outputRate;
    while (Math.floor(this.position) + 1 < this.source.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const sample = this.source[left]! + (this.source[left + 1]! - this.source[left]!) * fraction;
      this.pending.push(floatToPcm(sample));
      this.position += step;
    }

    const discard = Math.max(0, Math.floor(this.position) - 1);
    if (discard > 0) {
      this.source = this.source.slice(discard);
      this.position -= discard;
    }
    return this.takeFullChunks();
  }

  flush(): Uint8Array[] {
    const chunks = this.takeFullChunks();
    // One millisecond is exactly sixteen 16 kHz frames. Keep only a protocol-
    // valid 20 ms-or-longer tail and discard the sub-20 ms microphone residue.
    const frames = Math.floor(this.pending.length / 16) * 16;
    if (frames >= MIN_FINAL_FRAMES) {
      chunks.push(pcmBytes(this.pending.splice(0, frames)));
    }
    this.pending = [];
    this.source = new Float32Array();
    this.position = 0;
    return chunks;
  }

  private takeFullChunks(): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    while (this.pending.length >= this.chunkFrames) {
      chunks.push(pcmBytes(this.pending.splice(0, this.chunkFrames)));
    }
    return chunks;
  }
}

/** Prepared permission/device state. Audio is emitted only after `start`. */
export class MicrophoneCapture {
  private started = false;
  private disposed = false;
  private nextIndex = 0;
  private captureStartMs = 0;
  private trackEnded: (() => void) | null = null;
  private readonly resampler: Pcm16Resampler;
  private waveformBars = Array.from({ length: WAVEFORM_BAR_COUNT }, () => 0);
  private lastWaveformAt = 0;

  private constructor(
    private readonly media: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
  ) {
    this.resampler = new Pcm16Resampler(context.sampleRate);
  }

  static async prepare(): Promise<MicrophoneCapture> {
    if (!window.isSecureContext) {
      throw new Error("麦克风只允许在 HTTPS、localhost 或桌面 App 中使用");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前客户端不能访问麦克风");
    }
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    let context: AudioContext | null = null;
    try {
      const AudioContextClass = window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error("当前客户端不支持音频处理");
      try {
        context = new AudioContextClass({ latencyHint: "interactive" });
      } catch {
        // Older iOS WebViews expose webkitAudioContext but reject constructor
        // options even though the underlying audio graph works.
        context = new AudioContextClass();
      }
      if (!context.audioWorklet) throw new Error("当前客户端不支持实时麦克风处理");
      await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
      const source = context.createMediaStreamSource(media);
      const node = new AudioWorkletNode(context, "genehub-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const sink = context.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(context.destination);
      await context.resume();
      return new MicrophoneCapture(media, context, source, node, sink);
    } catch (error) {
      for (const track of media.getTracks()) track.stop();
      await context?.close().catch(() => {});
      throw error;
    }
  }

  start(
    onChunk: (chunk: CapturedPcmChunk) => void,
    onError: (error: unknown) => void,
    onWaveform?: (waveform: CapturedWaveform) => void,
  ): void {
    if (this.started || this.disposed) throw new Error("麦克风录音状态无效");
    this.started = true;
    this.node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!this.started || !(event.data instanceof Float32Array)) return;
      const now = typeof performance === "undefined" ? Date.now() : performance.now();
      if (onWaveform && now - this.lastWaveformAt >= WAVEFORM_INTERVAL_MS) {
        const waveform = analyzeWaveform(event.data, WAVEFORM_BAR_COUNT, this.waveformBars);
        this.waveformBars = waveform.bars;
        this.lastWaveformAt = now;
        onWaveform(waveform);
      }
      for (const pcm of this.resampler.push(event.data)) onChunk(this.describe(pcm));
    };
    this.node.onprocessorerror = () => onError(new Error("麦克风音频处理已停止"));
    this.trackEnded = () => onError(new Error("麦克风设备已经停止"));
    for (const track of this.media.getAudioTracks()) {
      track.addEventListener("ended", this.trackEnded);
    }
    this.source.connect(this.node);
  }

  async stop(onChunk: (chunk: CapturedPcmChunk) => void): Promise<void> {
    if (this.disposed) return;
    if (this.started) {
      this.started = false;
      this.source.disconnect();
      for (const pcm of this.resampler.flush()) onChunk(this.describe(pcm));
    }
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.node.port.onmessage = null;
    this.node.onprocessorerror = null;
    if (this.trackEnded) {
      for (const track of this.media.getAudioTracks()) {
        track.removeEventListener("ended", this.trackEnded);
      }
      this.trackEnded = null;
    }
    try {
      this.source.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
    } catch {
      // Nodes may already be disconnected by `stop`; tracks still need closing.
    }
    for (const track of this.media.getTracks()) track.stop();
    await this.context.close().catch(() => {});
  }

  private describe(pcm: Uint8Array): CapturedPcmChunk {
    const durationMs = pcm.byteLength / 2 / 16;
    const chunk = {
      index: this.nextIndex,
      captureStartMs: this.captureStartMs,
      durationMs,
      pcm,
    };
    this.nextIndex += 1;
    this.captureStartMs += durationMs;
    return chunk;
  }
}

export function analyzeWaveform(
  samples: Float32Array,
  barCount = WAVEFORM_BAR_COUNT,
  previous = Array.from({ length: barCount }, () => 0),
): CapturedWaveform {
  if (barCount <= 0) throw new RangeError("waveform needs at least one bar");
  if (samples.length === 0) {
    return { bars: Array.from({ length: barCount }, () => 0), rms: 0 };
  }
  let squareSum = 0;
  for (const sample of samples) squareSum += sample * sample;
  const segmentSize = Math.max(1, Math.floor(samples.length / barCount));
  const bars = Array.from({ length: barCount }, (_, barIndex) => {
    const start = barIndex * segmentSize;
    const end = barIndex === barCount - 1
      ? samples.length
      : Math.min(samples.length, start + segmentSize);
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]!));
    }
    const target = Math.min(1, peak * 7.5);
    return Math.max(0, Math.min(1, (previous[barIndex] ?? 0) * 0.48 + target * 0.52));
  });
  return { bars, rms: Math.sqrt(squareSum / samples.length) };
}

function floatToPcm(value: number): number {
  const sample = Math.max(-1, Math.min(1, value));
  return Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
}

function pcmBytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index]!, true);
  }
  return bytes;
}

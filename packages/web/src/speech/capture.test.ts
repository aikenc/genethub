import { describe, expect, it } from "vitest";

import { analyzeWaveform, Pcm16Resampler } from "./capture";

describe("PCM capture resampling", () => {
  it("turns 48 kHz input into exact 100 ms 16 kHz s16le chunks", () => {
    const resampler = new Pcm16Resampler(48_000);
    const source = new Float32Array(4_800).fill(0.5);
    const chunks = resampler.push(source);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3_200);
    expect(new DataView(chunks[0]!.buffer).getInt16(0, true)).toBeCloseTo(16_384, -1);
    expect(resampler.flush()).toEqual([]);
  });

  it("keeps a protocol-valid tail and drops residue shorter than 20 ms", () => {
    const kept = new Pcm16Resampler(16_000);
    kept.push(new Float32Array(801));
    expect(kept.flush()[0]).toHaveLength(1_600);

    const dropped = new Pcm16Resampler(16_000);
    dropped.push(new Float32Array(200));
    expect(dropped.flush()).toEqual([]);
  });
});

describe("live microphone waveform", () => {
  it("turns real samples into bounded smoothed bars and an RMS voice level", () => {
    const samples = new Float32Array([
      0, 0.1, -0.2, 0.3,
      0.5, -0.5, 0.25, -0.25,
    ]);
    const waveform = analyzeWaveform(samples, 2, [0, 0]);

    expect(waveform.bars).toHaveLength(2);
    expect(waveform.bars[0]).toBeGreaterThan(0);
    expect(waveform.bars[1]).toBeGreaterThanOrEqual(waveform.bars[0]!);
    expect(waveform.bars.every((level) => level >= 0 && level <= 1)).toBe(true);
    expect(waveform.rms).toBeGreaterThan(0.2);
  });

  it("returns a quiet baseline when a worklet frame is empty", () => {
    expect(analyzeWaveform(new Float32Array(), 3)).toEqual({ bars: [0, 0, 0], rms: 0 });
  });
});

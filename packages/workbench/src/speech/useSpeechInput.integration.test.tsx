import type { SpeechCompleted, SpeechContextPack, SpeechPartial } from "@genehub/proto";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { MicrophoneCapture } from "./capture";
import { SpeechTranscription } from "./client";
import { useSpeechInput } from "./useSpeechInput";

vi.mock("./capture", () => ({
  MicrophoneCapture: { prepare: vi.fn() },
}));

vi.mock("./client", () => ({
  SpeechTranscription: { open: vi.fn() },
}));

const context: SpeechContextPack = {
  snapshotId: "sc_mock",
  prompt: "专业术语：GeneHub",
  terms: [{ text: "GeneHub", source: "pinned", score: 1 }],
  languageHints: ["zh", "en"],
  compilerVersion: "qwen3-context-v1",
  omitted: {
    pinnedTerms: 0,
    automaticTerms: 0,
    messages: 0,
    projectIndexUnavailable: false,
    projectContextTruncated: false,
  },
};

const firstDefault = "基因 Hub 使用 Qwen 三，";
const firstAlternative = "GeneHub 使用 Qwen3-ASR，";
const secondDefault = "继续使用整句候选。";
const secondAlternative = "改为分段 N-best。";

const completed: SpeechCompleted = {
  requestId: "request-1",
  text: `${firstDefault}${secondDefault}`,
  durationMs: 800,
  contextSnapshotId: "sc_mock",
  candidates: [
    {
      candidateId: "c1",
      rank: 1,
      text: `${firstDefault}${secondDefault}`,
      score: -0.1,
      matchedTerms: [],
    },
    {
      candidateId: "c2",
      rank: 2,
      text: `${firstAlternative}${secondAlternative}`,
      score: -0.2,
      matchedTerms: ["GeneHub", "Qwen3-ASR", "N-best"],
    },
  ],
  defaultCandidateId: "c1",
  scoreKind: "mockRelative",
  scoresCalibrated: false,
  segments: [
    {
      segmentId: "s1",
      startMs: 0,
      endMs: 400,
      textStartChar: 0,
      textEndChar: Array.from(firstDefault).length,
      text: firstDefault,
      candidates: [
        {
          candidateId: "s1-c1",
          rank: 1,
          text: firstDefault,
          score: -0.1,
          matchedTerms: [],
        },
        {
          candidateId: "s1-c2",
          rank: 2,
          text: firstAlternative,
          score: -0.2,
          matchedTerms: ["GeneHub", "Qwen3-ASR"],
        },
      ],
      defaultCandidateId: "s1-c1",
      uncertainSpans: [
        {
          spanId: "span-model",
          startChar: 0,
          endChar: Array.from("基因 Hub").length,
          alternatives: [
            {
              alternativeId: "span-model-1",
              candidateId: "s1-c1",
              text: "基因 Hub",
              score: -0.1,
            },
            {
              alternativeId: "span-model-2",
              candidateId: "s1-c2",
              text: "GeneHub",
              score: -0.2,
            },
          ],
          defaultAlternativeId: "span-model-1",
        },
      ],
      boundary: { kind: "decoderEndpoint", confidence: 0.9 },
    },
    {
      segmentId: "s2",
      startMs: 400,
      endMs: 800,
      textStartChar: Array.from(firstDefault).length,
      textEndChar: Array.from(`${firstDefault}${secondDefault}`).length,
      text: secondDefault,
      candidates: [
        {
          candidateId: "s2-c1",
          rank: 1,
          text: secondDefault,
          score: -0.1,
          matchedTerms: [],
        },
        {
          candidateId: "s2-c2",
          rank: 2,
          text: secondAlternative,
          score: -0.2,
          matchedTerms: ["N-best"],
        },
      ],
      defaultCandidateId: "s2-c1",
      uncertainSpans: [
        {
          spanId: "span-granularity",
          startChar: Array.from("继续使用").length,
          endChar: Array.from("继续使用整句候选").length,
          alternatives: [
            {
              alternativeId: "span-granularity-1",
              candidateId: "s2-c1",
              text: "整句候选",
              score: -0.1,
            },
            {
              alternativeId: "span-granularity-2",
              candidateId: "s2-c2",
              text: "分段 N-best",
              score: -0.2,
            },
          ],
          defaultAlternativeId: "span-granularity-1",
        },
      ],
      boundary: { kind: "final", confidence: 1 },
    },
  ],
};

describe("Qwen3 speech review flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests the microphone in the click turn and never forwards PCM to the built-in mock", async () => {
    const order: string[] = [];
    const capture = {
      start: vi.fn(
        (
          onChunk: (chunk: {
            index: number;
            captureStartMs: number;
            durationMs: number;
            pcm: Uint8Array;
          }) => void,
          _onError: (error: unknown) => void,
          onWaveform: (waveform: { bars: number[]; rms: number }) => void,
        ) => {
          for (let index = 0; index < 3; index += 1) {
            onWaveform({ bars: Array.from({ length: 12 }, (_, bar) => bar / 12), rms: 0.03 });
          }
          onChunk({
            index: 0,
            captureStartMs: 0,
            durationMs: 100,
            pcm: new Uint8Array(3_200),
          });
        },
      ),
      stop: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    vi.mocked(MicrophoneCapture.prepare).mockImplementation(async () => {
      order.push("microphone");
      return capture as never;
    });

    const call = vi.fn(async (request: { type: string }) => {
      order.push(request.type);
      if (request.type === "speech.capabilities") {
        return {
          type: "speechCapabilities",
          data: {
            protocolVersion: 2,
            runtimeStatus: { state: "ready" },
            runtime: {
              id: "qwen3-asr",
              model: "Qwen3-ASR-1.7B",
              label: "Qwen3-ASR 1.7B",
              implementation: "mock",
            },
            audio: [{ encoding: "pcmS16Le", sampleRateHz: 16_000, channels: 1 }],
            languages: ["zh", "en"],
            maxLanguageHints: 4,
            maxDurationMs: 300_000,
            context: {
              maxBytes: 16_384,
              maxPromptChars: 4_000,
              maxPinnedTerms: 50,
              maxAutomaticTerms: 150,
            },
            nBest: { maxCandidates: 5, scoreKind: "mockRelative", calibrated: false },
            segmentation: {
              maxSegments: 32,
              partialResults: false,
              localNBest: true,
              uncertainSpans: true,
            },
          },
        };
      }
      if (request.type === "speech.context.preview") {
        return { type: "speechContext", data: context };
      }
      throw new Error(`unexpected ${request.type}`);
    });
    const commit = vi.fn();
    const client = { call } as unknown as Client;
    const { result } = renderHook(() =>
      useSpeechInput({
        target: { client, workspaceId: "workspace-1", onOpenSettings: vi.fn() },
        getDraft: () => ({ text: "", selectionStart: 0, selectionEnd: 0 }),
        commit,
      }),
    );

    await act(async () => result.current.start());
    expect(order[0]).toBe("microphone");
    expect(result.current.phase).toBe("recording");
    expect(result.current.localAudioOnly).toBe(true);
    expect(result.current.waveform.some((level) => level > 0)).toBe(true);
    expect(SpeechTranscription.open).not.toHaveBeenCalled();

    await act(async () => result.current.stop());
    expect(result.current.phase).toBe("review");
    expect(result.current.result?.segments).toHaveLength(3);
    expect(commit).toHaveBeenCalledWith(
      { text: "", selectionStart: 0, selectionEnd: 0 },
      expect.stringContaining("Qwen 三 ASR"),
    );
    expect(SpeechTranscription.open).not.toHaveBeenCalled();
  });

  it("keeps one draft while correcting segments and records scoped preference pairs", async () => {
    const capture = {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const transcription = {
      pushAudio: vi.fn(async () => {}),
      finish: vi.fn(async () => completed),
      cancel: vi.fn(async () => {}),
    };
    vi.mocked(MicrophoneCapture.prepare).mockResolvedValue(capture as never);
    let onPartial: ((partial: SpeechPartial) => void) | undefined;
    vi.mocked(SpeechTranscription.open).mockImplementation(
      async (_client, _start, _runtime, handlers) => {
        onPartial = handlers?.onPartial;
        return transcription as never;
      },
    );

    const call = vi.fn(async (request: { type: string }) => {
      if (request.type === "speech.capabilities") {
        return {
          type: "speechCapabilities",
          data: {
            protocolVersion: 2,
            runtimeStatus: { state: "ready" },
            runtime: {
              id: "qwen3-asr",
              model: "Qwen3-ASR-1.7B",
              label: "Qwen3-ASR 1.7B",
              implementation: "community",
            },
            audio: [{ encoding: "pcmS16Le", sampleRateHz: 16_000, channels: 1 }],
            languages: ["zh", "en"],
            maxLanguageHints: 4,
            maxDurationMs: 300_000,
            context: {
              maxBytes: 16_384,
              maxPromptChars: 4_000,
              maxPinnedTerms: 50,
              maxAutomaticTerms: 150,
            },
            nBest: { maxCandidates: 5, scoreKind: "mockRelative", calibrated: false },
            segmentation: {
              maxSegments: 32,
              partialResults: true,
              localNBest: true,
              uncertainSpans: true,
            },
          },
        };
      }
      if (request.type === "speech.context.preview") {
        return { type: "speechContext", data: context };
      }
      if (request.type === "speech.feedback.record") {
        return {
          type: "speechFeedbackReceipt",
          data: {
            stored: true,
            learnedTerms: ["GeneHub"],
            relativePath: ".genethub/speech/preferences.jsonl",
          },
        };
      }
      throw new Error(`unexpected ${request.type}`);
    });
    const client = { call } as unknown as Client;
    const commit = vi.fn();
    const snapshot = { text: "请处理：", selectionStart: 4, selectionEnd: 4 };
    const { result } = renderHook(() =>
      useSpeechInput({
        target: { client, workspaceId: "workspace-1", onOpenSettings: vi.fn() },
        getDraft: () => snapshot,
        commit,
      }),
    );

    await act(async () => result.current.start());
    expect(result.current.phase).toBe("recording");
    expect(SpeechTranscription.open).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ acceptPartial: true }),
      expect.objectContaining({ implementation: "community" }),
      expect.objectContaining({ onPartial: expect.any(Function) }),
    );

    act(() => {
      onPartial?.({
        requestId: "request-1",
        revision: 1,
        text: "GeneHub 正在流式识别",
        audioEndMs: 400,
        stablePrefixChars: 7,
      });
    });
    expect(result.current.draftPreview).toEqual({
      snapshot,
      text: "GeneHub 正在流式识别",
    });
    expect(commit).not.toHaveBeenCalled();

    await act(async () => result.current.stop());
    expect(result.current.phase).toBe("review");
    expect(result.current.result?.segments).toHaveLength(2);
    expect(commit).toHaveBeenLastCalledWith(snapshot, `${firstDefault}${secondDefault}`);
    expect(result.current.selectedSegmentCandidateIds).toEqual({
      s1: "s1-c1",
      s2: "s2-c1",
    });

    const firstSegment = completed.segments![0]!;
    const secondSegment = completed.segments![1]!;
    await act(async () =>
      result.current.selectSegmentCandidate(
        firstSegment,
        firstSegment.candidates[0]!,
        firstSegment.uncertainSpans[0],
      ),
    );
    expect(call.mock.calls.some(([request]) => request.type === "speech.feedback.record")).toBe(false);

    await act(async () =>
      result.current.selectSegmentCandidate(
        firstSegment,
        firstSegment.candidates[1]!,
        firstSegment.uncertainSpans[0],
      ),
    );
    expect(commit).toHaveBeenLastCalledWith(snapshot, `${firstAlternative}${secondDefault}`);
    expect(result.current.selectedCandidateId).toBeNull();
    expect(result.current.selectedSegmentCandidateIds).toEqual({
      s1: "s1-c2",
      s2: "s2-c1",
    });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "speech.feedback.record",
        payload: expect.objectContaining({
          workspaceId: "workspace-1",
          candidates: firstSegment.candidates,
          selectedCandidateId: "s1-c2",
          rejectedCandidateId: "s1-c1",
          scope: {
            level: "span",
            utteranceText: `${firstAlternative}${secondDefault}`,
            segmentId: "s1",
            segmentStartMs: 0,
            segmentEndMs: 400,
            precedingText: "",
            followingText: secondDefault,
            uncertainSpanId: "span-model",
            spanStartChar: 0,
            spanEndChar: Array.from("基因 Hub").length,
          },
        }),
      }),
    );
    expect(result.current.notice).toContain("preferences.jsonl");

    await act(async () =>
      result.current.selectSegmentCandidate(
        secondSegment,
        secondSegment.candidates[1]!,
        secondSegment.uncertainSpans[0],
      ),
    );
    expect(commit).toHaveBeenLastCalledWith(snapshot, `${firstAlternative}${secondAlternative}`);
    const feedbackCalls = call.mock.calls.filter(
      ([request]) => request.type === "speech.feedback.record",
    );
    expect(feedbackCalls).toHaveLength(2);
    expect(feedbackCalls[1]![0]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          selectedCandidateId: "s2-c2",
          rejectedCandidateId: "s2-c1",
          scope: expect.objectContaining({
            precedingText: firstAlternative,
            followingText: "",
          }),
        }),
      }),
    );

    await act(async () =>
      result.current.selectSegmentCandidate(
        secondSegment,
        secondSegment.candidates[1]!,
        secondSegment.uncertainSpans[0],
      ),
    );
    expect(call.mock.calls.filter(([request]) => request.type === "speech.feedback.record")).toHaveLength(2);
  });

  it("sends real PCM through the protocol Stub and never records its invented candidates", async () => {
    const capture = {
      start: vi.fn((onChunk: (chunk: {
        index: number;
        captureStartMs: number;
        durationMs: number;
        pcm: Uint8Array;
      }) => void) => {
        onChunk({
          index: 0,
          captureStartMs: 0,
          durationMs: 100,
          pcm: new Uint8Array(3_200),
        });
      }),
      stop: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const transcription = {
      pushAudio: vi.fn(async () => {}),
      finish: vi.fn(async () => completed),
      cancel: vi.fn(async () => {}),
    };
    vi.mocked(MicrophoneCapture.prepare).mockResolvedValue(capture as never);
    vi.mocked(SpeechTranscription.open).mockResolvedValue(transcription as never);

    const call = vi.fn(async (request: { type: string }) => {
      if (request.type === "speech.capabilities") {
        return {
          type: "speechCapabilities",
          data: {
            protocolVersion: 2,
            runtimeStatus: { state: "ready" },
            runtime: {
              id: "genehub-speech-stub",
              model: "no-model",
              label: "GeneHub 语音协议 Stub",
              implementation: "stub",
            },
            audio: [{ encoding: "pcmS16Le", sampleRateHz: 16_000, channels: 1 }],
            languages: ["zh", "en"],
            maxLanguageHints: 4,
            maxDurationMs: 300_000,
            context: {
              maxBytes: 16_384,
              maxPromptChars: 4_000,
              maxPinnedTerms: 50,
              maxAutomaticTerms: 150,
            },
            nBest: { maxCandidates: 5, scoreKind: "mockRelative", calibrated: false },
            segmentation: {
              maxSegments: 32,
              partialResults: true,
              localNBest: true,
              uncertainSpans: true,
            },
          },
        };
      }
      if (request.type === "speech.context.preview") {
        return { type: "speechContext", data: context };
      }
      throw new Error(`unexpected ${request.type}`);
    });
    const client = { call } as unknown as Client;
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useSpeechInput({
        target: { client, workspaceId: "workspace-1", onOpenSettings: vi.fn() },
        getDraft: () => ({ text: "", selectionStart: 0, selectionEnd: 0 }),
        commit,
      }),
    );

    await act(async () => result.current.start());
    expect(result.current.localAudioOnly).toBe(false);
    expect(SpeechTranscription.open).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ acceptPartial: true }),
      expect.objectContaining({ implementation: "stub" }),
      expect.any(Object),
    );
    expect(transcription.pushAudio).toHaveBeenCalledWith(
      0,
      0,
      100,
      expect.any(Uint8Array),
    );

    await act(async () => result.current.stop());
    await act(async () => result.current.selectCandidate(completed.candidates[1]!));
    expect(commit).toHaveBeenLastCalledWith(
      { text: "", selectionStart: 0, selectionEnd: 0 },
      completed.candidates[1]!.text,
    );
    expect(call.mock.calls.some(([request]) => request.type === "speech.feedback.record")).toBe(false);
    expect(result.current.notice).toContain("不会写入训练数据");
  });
});

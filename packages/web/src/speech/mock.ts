import type {
  SpeechCandidate,
  SpeechCompleted,
  SpeechContextPack,
  SpeechSegment,
  SpeechSpanAlternative,
} from "@genehub/proto";

/**
 * The browser-side mock is deliberately presentation-only. It makes the
 * composer exercise realistic 2 s audio chunks, a 200 ms paired-device hop
 * and a small first-token decode delay without sending microphone bytes or
 * pretending that the canned text came from inference.
 */
export const MOCK_STREAM_PROFILE = Object.freeze({
  audioChunkMs: 2_000,
  networkMs: 200,
  firstTokenMs: 350,
  firstVisibleMs: 2_550,
});

export function mockPartialTranscript(context: SpeechContextPack, elapsedMs: number): string {
  const term = projectTerm(context);
  const first = `我们需要把 ${term} 的`;
  const bursts = [
    first,
    `${first}语音输入改成边说边输出 Best-1。`,
    `${first}语音输入改成边说边输出 Best-1。接入 Qwen 三 ASR 后，`,
    `${first}语音输入改成边说边输出 Best-1。接入 Qwen 三 ASR 后，只给低置信片段加波浪线，`,
    mockDefaultTranscript(context),
  ];
  if (elapsedMs < MOCK_STREAM_PROFILE.firstVisibleMs) return "";
  const index = Math.min(
    bursts.length - 1,
    Math.floor((elapsedMs - MOCK_STREAM_PROFILE.firstVisibleMs) / MOCK_STREAM_PROFILE.audioChunkMs),
  );
  return bursts[index]!;
}

export function mockSpeechCompletion(
  context: SpeechContextPack,
  requestId: string,
  durationMs: number,
): SpeechCompleted {
  const term = projectTerm(context);
  const first = segment(
    "mock-segment-input",
    [
      `我们需要把 ${term} 的语音输入改成边说边输出 Best-1。`,
      `我们需要把 ${term} 的语音输入改成边说边输出 Best 1。`,
      `我们需要把 ${term} 的语音输入改成实时输出 best one。`,
    ],
    "Best-1",
    ["Best-1", "Best 1", "best one"],
    [[term], [term], [term]],
  );
  const second = segment(
    "mock-segment-model",
    [
      "接入 Qwen 三 ASR 后，只给低置信片段加波浪线，",
      "接入 Qwen3-ASR 后，只给低置信片段加波浪线，",
      "接入 Qwen3 ASR 后，只给低置信片段加波浪线，",
    ],
    "Qwen 三 ASR",
    ["Qwen 三 ASR", "Qwen3-ASR", "Qwen3 ASR"],
    [[], ["Qwen3-ASR"], ["Qwen3 ASR"]],
  );
  const third = segment(
    "mock-segment-feedback",
    [
      "并把人工选择沉淀成 DPO 正负样本。",
      "并把人工选择沉淀成 DPO 偏好样本。",
      "并把人工选择沉淀成偏好正负样本。",
    ],
    "DPO 正负样本",
    ["DPO 正负样本", "DPO 偏好样本", "偏好正负样本"],
    [[], ["DPO"], []],
  );
  const segments = [first, second, third];
  const safeDuration = Math.max(600, Math.min(durationMs, 5 * 60 * 1_000));
  const boundaries = [0, Math.round(safeDuration * 0.4), Math.round(safeDuration * 0.72), safeDuration];
  let textOffset = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const item = segments[index]!;
    item.startMs = boundaries[index]!;
    item.endMs = boundaries[index + 1]!;
    item.textStartChar = textOffset;
    textOffset += Array.from(item.text).length;
    item.textEndChar = textOffset;
    item.boundary = {
      kind: index === segments.length - 1 ? "final" : "decoderEndpoint",
      confidence: index === segments.length - 1 ? 1 : 0.86,
    };
  }

  const candidates = [0, 1, 2].map((index) => {
    const parts = segments.map((item) => item.candidates[index]!);
    return {
      candidateId: `mock-global-${index + 1}`,
      rank: index + 1,
      text: parts.map((item) => item.text).join(""),
      score: parts.reduce((sum, item) => sum + item.score, 0),
      matchedTerms: [...new Set(parts.flatMap((item) => item.matchedTerms))],
    } satisfies SpeechCandidate;
  });

  return {
    requestId,
    text: candidates[0]!.text,
    durationMs: safeDuration,
    contextSnapshotId: context.snapshotId,
    candidates,
    defaultCandidateId: candidates[0]!.candidateId,
    scoreKind: "mockRelative",
    scoresCalibrated: false,
    segments,
  };
}

function mockDefaultTranscript(context: SpeechContextPack): string {
  const term = projectTerm(context);
  return `我们需要把 ${term} 的语音输入改成边说边输出 Best-1。接入 Qwen 三 ASR 后，只给低置信片段加波浪线，并把人工选择沉淀成 DPO 正负样本。`;
}

function projectTerm(context: SpeechContextPack): string {
  return (
    context.terms
      .map((item) => item.text.trim())
      .find(
        (term) =>
          term &&
          !term.toLowerCase().includes("qwen") &&
          !term.toLowerCase().includes("best") &&
          !term.toLowerCase().includes("dpo"),
      ) ?? "GeneHub"
  );
}

function segment(
  segmentId: string,
  texts: [string, string, string],
  defaultSpan: string,
  alternatives: [string, string, string],
  matchedTerms: [string[], string[], string[]],
): SpeechSegment {
  const candidates = texts.map((text, index) => ({
    candidateId: `${segmentId}-candidate-${index + 1}`,
    rank: index + 1,
    text,
    score: [-0.14, -0.21, -0.36][index]!,
    matchedTerms: matchedTerms[index]!,
  })) satisfies SpeechCandidate[];
  const spanStart = charOffset(texts[0], defaultSpan);
  const spanAlternatives = alternatives.map((text, index) => ({
    alternativeId: `${segmentId}-alternative-${index + 1}`,
    candidateId: candidates[index]!.candidateId,
    text,
    score: candidates[index]!.score,
  })) satisfies SpeechSpanAlternative[];
  return {
    segmentId,
    startMs: 0,
    endMs: 0,
    textStartChar: 0,
    textEndChar: 0,
    text: texts[0],
    candidates,
    defaultCandidateId: candidates[0]!.candidateId,
    uncertainSpans: [
      {
        spanId: `${segmentId}-span`,
        startChar: spanStart,
        endChar: spanStart + Array.from(defaultSpan).length,
        alternatives: spanAlternatives,
        defaultAlternativeId: spanAlternatives[0]!.alternativeId,
      },
    ],
    boundary: { kind: "final", confidence: 1 },
  };
}

function charOffset(text: string, needle: string): number {
  const byteOffset = text.indexOf(needle);
  if (byteOffset < 0) throw new Error("mock uncertain span must occur in its segment");
  return Array.from(text.slice(0, byteOffset)).length;
}

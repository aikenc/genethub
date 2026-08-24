import type { SpeechCompleted } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { composeSegmentText, insertSpeechText } from "./useSpeechInput";

describe("speech transcript review insertion", () => {
  it("inserts at the captured cursor without sending anything", () => {
    expect(
      insertSpeechText(
        { text: "请检查。", selectionStart: 1, selectionEnd: 1 },
        "GeneHub 协议",
      ),
    ).toEqual({ text: "请GeneHub 协议检查。", cursor: 11 });
  });

  it("replaces a selection and separates adjacent ASCII words", () => {
    expect(
      insertSpeechText(
        { text: "use old parser", selectionStart: 4, selectionEnd: 7 },
        "new speech",
      ),
    ).toEqual({ text: "use new speech parser", cursor: 14 });
  });

  it("composes independently selected Unicode segments into one transcript", () => {
    const first = "🚀 Qwen 三，";
    const second = "保留整句候选。";
    const completed: SpeechCompleted = {
      requestId: "r1",
      text: `${first}${second}`,
      durationMs: 1_000,
      contextSnapshotId: "sc_1",
      candidates: [
        {
          candidateId: "global-1",
          rank: 1,
          text: `${first}${second}`,
          score: -0.1,
          matchedTerms: [],
        },
      ],
      defaultCandidateId: "global-1",
      scoreKind: "mockRelative",
      scoresCalibrated: false,
      segments: [
        {
          segmentId: "s1",
          startMs: 0,
          endMs: 500,
          textStartChar: 0,
          textEndChar: Array.from(first).length,
          text: first,
          candidates: [
            { candidateId: "s1-1", rank: 1, text: first, score: -0.1, matchedTerms: [] },
            {
              candidateId: "s1-2",
              rank: 2,
              text: "🚀 Qwen3-ASR，",
              score: -0.2,
              matchedTerms: ["Qwen3-ASR"],
            },
          ],
          defaultCandidateId: "s1-1",
          uncertainSpans: [],
          boundary: { kind: "decoderEndpoint", confidence: 0.8 },
        },
        {
          segmentId: "s2",
          startMs: 500,
          endMs: 1_000,
          textStartChar: Array.from(first).length,
          textEndChar: Array.from(`${first}${second}`).length,
          text: second,
          candidates: [
            { candidateId: "s2-1", rank: 1, text: second, score: -0.1, matchedTerms: [] },
            {
              candidateId: "s2-2",
              rank: 2,
              text: "保留分段 N-best。",
              score: -0.2,
              matchedTerms: ["N-best"],
            },
          ],
          defaultCandidateId: "s2-1",
          uncertainSpans: [],
          boundary: { kind: "final", confidence: 1 },
        },
      ],
    };

    expect(composeSegmentText(completed, { s1: "s1-2", s2: "s2-1" })).toBe(
      "🚀 Qwen3-ASR，保留整句候选。",
    );
    expect(composeSegmentText(completed, { s1: "s1-2", s2: "s2-2" })).toBe(
      "🚀 Qwen3-ASR，保留分段 N-best。",
    );
  });
});

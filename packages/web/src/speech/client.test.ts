import type { SpeechCompleted, SpeechStart } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { validateCompleted, validatePartial } from "./client";

function completed(): SpeechCompleted {
  const first = "GeneHub 使用 Qwen 三，";
  const second = "继续使用整句候选。";
  return {
    requestId: "request-1",
    text: `${first}${second}`,
    durationMs: 1_200,
    contextSnapshotId: "sc_1",
    candidates: [
      {
        candidateId: "c1",
        rank: 1,
        text: `${first}${second}`,
        score: -0.1,
        matchedTerms: ["GeneHub"],
      },
      {
        candidateId: "c2",
        rank: 2,
        text: "GeneHub 使用 Qwen3-ASR，并按分段提供 N-best。",
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
        endMs: 600,
        textStartChar: 0,
        textEndChar: Array.from(first).length,
        text: first,
        candidates: [
          {
            candidateId: "s1-c1",
            rank: 1,
            text: first,
            score: -0.1,
            matchedTerms: ["GeneHub"],
          },
          {
            candidateId: "s1-c2",
            rank: 2,
            text: "GeneHub 使用 Qwen3-ASR，",
            score: -0.2,
            matchedTerms: ["GeneHub", "Qwen3-ASR"],
          },
        ],
        defaultCandidateId: "s1-c1",
        uncertainSpans: [
          {
            spanId: "span-model",
            startChar: Array.from("GeneHub 使用 ").length,
            endChar: Array.from("GeneHub 使用 Qwen 三").length,
            alternatives: [
              {
                alternativeId: "a1",
                candidateId: "s1-c1",
                text: "Qwen 三",
                score: -0.1,
              },
              {
                alternativeId: "a2",
                candidateId: "s1-c2",
                text: "Qwen3-ASR",
                score: -0.2,
              },
            ],
            defaultAlternativeId: "a1",
          },
        ],
        boundary: { kind: "decoderEndpoint", confidence: 0.8 },
      },
      {
        segmentId: "s2",
        startMs: 600,
        endMs: 1_200,
        textStartChar: Array.from(first).length,
        textEndChar: Array.from(`${first}${second}`).length,
        text: second,
        candidates: [
          {
            candidateId: "s2-c1",
            rank: 1,
            text: second,
            score: -0.1,
            matchedTerms: [],
          },
          {
            candidateId: "s2-c2",
            rank: 2,
            text: "继续使用分段 N-best。",
            score: -0.2,
            matchedTerms: ["N-best"],
          },
        ],
        defaultCandidateId: "s2-c1",
        uncertainSpans: [],
        boundary: { kind: "final", confidence: 1 },
      },
    ],
  };
}

describe("Qwen3 N-best completion", () => {
  it("accepts whole-utterance and independently ranked segment candidates", () => {
    expect(() => validateCompleted(completed(), "request-1")).not.toThrow();
  });

  it("keeps whole-utterance-only runtimes wire compatible", () => {
    const legacy = completed();
    delete legacy.segments;
    expect(() => validateCompleted(legacy, "request-1")).not.toThrow();
  });

  it("rejects duplicate text and a mismatched default", () => {
    const duplicate = completed();
    duplicate.candidates[1]!.text = duplicate.candidates[0]!.text;
    expect(() => validateCompleted(duplicate, "request-1")).toThrow(/duplicate candidate/);

    const mismatch = completed();
    mismatch.defaultCandidateId = "missing";
    expect(() => validateCompleted(mismatch, "request-1")).toThrow(/default candidate/);
  });

  it("rejects malformed ranks, matched terms, and completion metadata", () => {
    const rank = completed();
    rank.candidates[1]!.rank = 6;
    expect(() => validateCompleted(rank, "request-1")).toThrow(/candidate/);

    const term = completed();
    term.candidates[0]!.matchedTerms = ["NotInTranscript"];
    expect(() => validateCompleted(term, "request-1")).toThrow(/candidate/);

    const metadata = completed();
    metadata.contextSnapshotId = "";
    expect(() => validateCompleted(metadata, "request-1")).toThrow(/identity/);
  });

  it("rejects overlapping ranges, invalid boundaries, and dangling span alternatives", () => {
    const overlap = completed();
    overlap.segments![1]!.textStartChar -= 1;
    expect(() => validateCompleted(overlap, "request-1")).toThrow(/segment range/);

    const boundary = completed();
    boundary.segments![0]!.boundary.kind = "final";
    expect(() => validateCompleted(boundary, "request-1")).toThrow(/boundary/);

    const dangling = completed();
    dangling.segments![0]!.uncertainSpans[0]!.alternatives[1]!.candidateId = "missing";
    expect(() => validateCompleted(dangling, "request-1")).toThrow(/alternative/);
  });

  it("rejects segment alternatives that could compose beyond the transcript budget", () => {
    const oversized = completed();
    oversized.segments![0]!.uncertainSpans = [];
    oversized.segments![0]!.candidates[1]!.text = "x".repeat(3_999);
    oversized.segments![0]!.candidates[1]!.matchedTerms = [];
    expect(() => validateCompleted(oversized, "request-1")).toThrow(/oversized transcript/);
  });
});

describe("revisioned speech partials", () => {
  const start = {
    requestId: "request-1",
    acceptPartial: true,
  } as SpeechStart;

  it("accepts a full replacement with a Unicode stable prefix", () => {
    expect(() =>
      validatePartial(
        {
          requestId: "request-1",
          revision: 2,
          text: "在 GeneHub 中",
          audioEndMs: 800,
          stablePrefixChars: 3,
        },
        start,
        1,
      ),
    ).not.toThrow();
  });

  it("rejects revision rollback and unnegotiated partials", () => {
    expect(() =>
      validatePartial(
        {
          requestId: "request-1",
          revision: 1,
          text: "旧结果",
          audioEndMs: 800,
          stablePrefixChars: 0,
        },
        start,
        1,
      ),
    ).toThrow(/partial/);
    expect(() =>
      validatePartial(
        {
          requestId: "request-1",
          revision: 2,
          text: "结果",
          audioEndMs: 800,
          stablePrefixChars: 0,
        },
        { ...start, acceptPartial: false },
        1,
      ),
    ).toThrow(/partial/);
  });
});

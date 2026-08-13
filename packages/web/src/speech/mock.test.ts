import type { SpeechContextPack } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { validateCompleted } from "./client";
import { MOCK_STREAM_PROFILE, mockPartialTranscript, mockSpeechCompletion } from "./mock";

const context: SpeechContextPack = {
  snapshotId: "sc_1",
  prompt: "项目术语：PipeSpace",
  terms: [{ text: "PipeSpace", source: "projectConfig", score: 1 }],
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

describe("browser-only Qwen3 UI mock", () => {
  it("does not reveal a character before the chunk, link and first-token budget", () => {
    expect(mockPartialTranscript(context, MOCK_STREAM_PROFILE.firstVisibleMs - 1)).toBe("");
    expect(mockPartialTranscript(context, MOCK_STREAM_PROFILE.firstVisibleMs)).toBe(
      "我们需要把 PipeSpace 的",
    );
    expect(
      mockPartialTranscript(
        context,
        MOCK_STREAM_PROFILE.firstVisibleMs + MOCK_STREAM_PROFILE.audioChunkMs,
      ),
    ).toContain("Best-1");
  });

  it("builds independently selectable local spans while retaining whole N-best", () => {
    const completed = mockSpeechCompletion(context, "request-1", 4_000);

    expect(completed.text).toContain("PipeSpace");
    expect(completed.candidates).toHaveLength(3);
    expect(completed.segments).toHaveLength(3);
    expect(completed.segments?.every((segment) => segment.candidates.length === 3)).toBe(true);
    expect(completed.segments?.flatMap((segment) => segment.uncertainSpans)).toHaveLength(3);
    expect(completed.segments?.at(-1)?.boundary.kind).toBe("final");
    expect(() => validateCompleted(completed, "request-1")).not.toThrow();
  });
});

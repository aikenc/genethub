import type { AgentInfo, SpeechCompleted } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechInput, type SpeechInputController } from "../speech/useSpeechInput";
import { SpeechStatusStrip } from "../speech/SpeechComposer";
import { Composer } from "./Composer";

vi.mock("../speech/useSpeechInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../speech/useSpeechInput")>()),
  useSpeechInput: vi.fn(),
}));

const first = "请使用 Qwen 三，";
const second = "保留整句候选。";
const completed: SpeechCompleted = {
  requestId: "r1",
  text: `${first}${second}`,
  durationMs: 1_000,
  contextSnapshotId: "sc_1",
  candidates: [
    {
      candidateId: "g1",
      rank: 1,
      text: `${first}${second}`,
      score: -0.1,
      matchedTerms: [],
    },
  ],
  defaultCandidateId: "g1",
  scoreKind: "mockRelative",
  scoresCalibrated: false,
  segments: [
    {
      segmentId: "s1",
      startMs: 0,
      endMs: 450,
      textStartChar: 0,
      textEndChar: Array.from(first).length,
      text: first,
      candidates: [
        { candidateId: "s1-1", rank: 1, text: first, score: -0.1, matchedTerms: [] },
        {
          candidateId: "s1-2",
          rank: 2,
          text: "请使用 Qwen3-ASR，",
          score: -0.2,
          matchedTerms: ["Qwen3-ASR"],
        },
      ],
      defaultCandidateId: "s1-1",
      uncertainSpans: [
        {
          spanId: "model",
          startChar: Array.from("请使用 ").length,
          endChar: Array.from("请使用 Qwen 三").length,
          alternatives: [
            {
              alternativeId: "model-1",
              candidateId: "s1-1",
              text: "Qwen 三",
              score: -0.1,
            },
            {
              alternativeId: "model-2",
              candidateId: "s1-2",
              text: "Qwen3-ASR",
              score: -0.2,
            },
          ],
          defaultAlternativeId: "model-1",
        },
      ],
      boundary: { kind: "decoderEndpoint", confidence: 0.9 },
    },
    {
      segmentId: "s2",
      startMs: 450,
      endMs: 1_000,
      textStartChar: Array.from(first).length,
      textEndChar: Array.from(`${first}${second}`).length,
      text: second,
      candidates: [
        { candidateId: "s2-1", rank: 1, text: second, score: -0.1, matchedTerms: [] },
      ],
      defaultCandidateId: "s2-1",
      uncertainSpans: [],
      boundary: { kind: "final", confidence: 1 },
    },
  ],
};

const agent: AgentInfo = {
  id: "genet",
  label: "GeneHub Agent",
  probe: { state: "ready" },
  builtin: true,
  platform: "linux",
  auth: "notApplicable",
  setup: { install: [] },
  capabilities: {
    interrupt: true,
    setModel: false,
    setMode: false,
    setEffort: false,
    permissions: false,
    resume: true,
    fork: false,
    attachments: false,
  },
  catalog: {
    models: [],
    modes: [],
    commands: [],
  },
};

describe("Composer segmented speech review", () => {
  const selectSegmentCandidate = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSpeechInput).mockReturnValue({
      phase: "review",
      busy: false,
      notice: "可逐段纠正后再发送",
      problem: null,
      context: null,
      draftPreview: null,
      waveform: Array.from({ length: 12 }, () => 0),
      elapsedMs: 1_000,
      localAudioOnly: true,
      result: completed,
      selectedCandidateId: "g1",
      selectedSegmentCandidateIds: { s1: "s1-1", s2: "s2-1" },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      selectCandidate: vi.fn(async () => {}),
      selectSegmentCandidate,
      dismissReview: vi.fn(),
    } satisfies SpeechInputController);
  });

  it("keeps Best-1 inline and opens candidates only for the uncertain span", async () => {
    render(
      <Composer
        phase="idle"
        agents={[agent]}
        agentId="genet"
        modelId={null}
        modeId={null}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onPickAgent={vi.fn()}
        onPickModel={vi.fn()}
        onPickMode={vi.fn()}
      />,
    );

    expect(await screen.findByText("点击带波浪线的文字")).toBeInTheDocument();
    expect(screen.queryByLabelText("Qwen3-ASR 识别候选")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Qwen 三，点击查看局部识别候选" }),
    );
    const choice = screen.getByRole("option", { name: /Qwen3-ASR/ });
    await userEvent.click(choice);
    expect(selectSegmentCandidate).toHaveBeenCalledWith(
      completed.segments![0],
      completed.segments![0]!.candidates[1],
      completed.segments![0]!.uncertainSpans[0],
    );
  });
});

describe("speech failure recovery", () => {
  it("offers daemon logs and a content-free problem report from the failed strip", async () => {
    const openLogs = vi.fn();
    const report = vi.fn();
    const problem = {
      requestId: "speech-1",
      stage: "runtime_open",
      errorCode: "runtimeUnavailable",
      userMessage: "本地显示，但不应由宿主自动附带",
      correlationId: "sp_123",
    };
    render(
      <SpeechStatusStrip
        phase="failed"
        notice="Qwen3-ASR 转写失败（错误编号 sp_123）"
        waveform={[]}
        elapsedMs={0}
        localAudioOnly={false}
        problem={problem}
        onOpenLogs={openLogs}
        onReportProblem={report}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "查看日志" }));
    await userEvent.click(screen.getByRole("button", { name: "反馈本次问题" }));
    expect(openLogs).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(problem);
  });
});

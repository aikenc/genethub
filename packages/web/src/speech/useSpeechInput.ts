import type {
  SpeechCancelReason,
  SpeechCandidate,
  SpeechCompleted,
  SpeechContextPack,
  SpeechSegment,
  SpeechStart,
  SpeechUncertainSpan,
} from "@genehub/proto";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Client } from "../protocol/client";
import {
  MicrophoneCapture,
  type CapturedPcmChunk,
  type CapturedWaveform,
} from "./capture";
import { SpeechTranscription, SpeechTranscriptionError } from "./client";
import { emitSpeechDiagnostic } from "./diagnostics";
import { MOCK_STREAM_PROFILE, mockPartialTranscript, mockSpeechCompletion } from "./mock";

const MAX_PENDING_AUDIO_WRITES = 10;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1_000;
const WAVEFORM_BARS = 12;
const VOICE_RMS_THRESHOLD = 0.012;
const VOICE_FRAMES_REQUIRED = 3;

export type SpeechInputPhase =
  | "idle"
  | "preparing"
  | "recording"
  | "finishing"
  | "review"
  | "failed";

export interface SpeechDraftSnapshot {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface SpeechInputTarget {
  client: Client;
  workspaceId: string;
  sessionId?: string;
  onOpenSettings(): void;
  onOpenLogs?(): void;
  onReportProblem?(problem: SpeechInputProblem): void;
}

export interface SpeechInputProblem {
  requestId: string;
  stage: string;
  errorCode: string;
  userMessage: string;
  correlationId?: string;
}

export interface SpeechDraftPreview {
  snapshot: SpeechDraftSnapshot;
  text: string;
}

interface ActiveOperation {
  target: SpeechInputTarget;
  snapshot: SpeechDraftSnapshot;
  canceled: boolean;
  requestId: string;
  context?: SpeechContextPack;
  capturePromise?: Promise<MicrophoneCapture>;
  capture?: MicrophoneCapture;
  transcription?: SpeechTranscription;
  pendingWrites: number;
  recording: boolean;
  localMock: boolean;
  testStub: boolean;
  startedAt?: number;
  voiceStartedAt?: number;
  voiceFrames: number;
  lastPreview: string;
  noticeStage: number;
  stage: string;
  partialReported: boolean;
  clock?: ReturnType<typeof setInterval>;
  timer?: ReturnType<typeof setTimeout>;
}

interface ReviewOperation {
  target: SpeechInputTarget;
  snapshot: SpeechDraftSnapshot;
  completed: SpeechCompleted;
  testStub: boolean;
  currentCandidateId: string;
  currentSegmentCandidateIds: Record<string, string>;
  selectionRevision: number;
}

export interface SpeechInputController {
  phase: SpeechInputPhase;
  busy: boolean;
  notice: string | null;
  problem: SpeechInputProblem | null;
  context: SpeechContextPack | null;
  draftPreview: SpeechDraftPreview | null;
  waveform: number[];
  elapsedMs: number;
  /** True only for the built-in UI mock; real runtime audio uses the protocol stream. */
  localAudioOnly: boolean;
  result: SpeechCompleted | null;
  selectedCandidateId: string | null;
  selectedSegmentCandidateIds: Record<string, string>;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(reason?: SpeechCancelReason): Promise<void>;
  selectCandidate(candidate: SpeechCandidate): Promise<void>;
  selectSegmentCandidate(
    segment: SpeechSegment,
    candidate: SpeechCandidate,
    uncertainSpan?: SpeechUncertainSpan,
  ): Promise<void>;
  dismissReview(): void;
}

export function useSpeechInput({
  target,
  getDraft,
  commit,
}: {
  target?: SpeechInputTarget;
  getDraft(): SpeechDraftSnapshot;
  commit(snapshot: SpeechDraftSnapshot, transcript: string): void;
}): SpeechInputController {
  const [phase, setPhase] = useState<SpeechInputPhase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<SpeechInputProblem | null>(null);
  const [context, setContext] = useState<SpeechContextPack | null>(null);
  const [draftPreview, setDraftPreview] = useState<SpeechDraftPreview | null>(null);
  const [waveform, setWaveform] = useState<number[]>(emptyWaveform);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [localAudioOnly, setLocalAudioOnly] = useState(false);
  const [result, setResult] = useState<SpeechCompleted | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedSegmentCandidateIds, setSelectedSegmentCandidateIds] = useState<
    Record<string, string>
  >({});
  const active = useRef<ActiveOperation | null>(null);
  const review = useRef<ReviewOperation | null>(null);
  const getDraftRef = useRef(getDraft);
  const commitRef = useRef(commit);
  getDraftRef.current = getDraft;
  commitRef.current = commit;

  const clearReview = useCallback(() => {
    review.current = null;
    setResult(null);
    setSelectedCandidateId(null);
    setSelectedSegmentCandidateIds({});
  }, []);

  const dismissReview = useCallback(() => {
    clearReview();
    setContext(null);
    setDraftPreview(null);
    setWaveform(emptyWaveform());
    setElapsedMs(0);
    setLocalAudioOnly(false);
    setNotice(null);
    setProblem(null);
    setPhase("idle");
  }, [clearReview]);

  const fail = useCallback(async (operation: ActiveOperation, error: unknown) => {
    if (operation.canceled) return;
    operation.canceled = true;
    stopOperationTimers(operation);
    if (active.current === operation) active.current = null;
    await disposeOperationCapture(operation);
    await operation.transcription?.cancel("clientBackpressure");
    clearReview();
    setContext(null);
    setDraftPreview(null);
    setWaveform(emptyWaveform());
    setLocalAudioOnly(false);
    const userMessage = speechErrorMessage(error);
    const failure = error instanceof SpeechTranscriptionError ? error.failure : null;
    const correlationId = failure?.correlationId ?? speechCorrelationId(error);
    const nextProblem: SpeechInputProblem = {
      requestId: operation.requestId,
      stage: operation.stage,
      errorCode: failure?.code ?? clientErrorCode(error),
      userMessage,
      ...(correlationId ? { correlationId } : {}),
    };
    setProblem(nextProblem);
    setNotice(
      nextProblem.correlationId && !userMessage.includes(nextProblem.correlationId)
        ? `${userMessage}（错误编号 ${nextProblem.correlationId}）`
        : userMessage,
    );
    emitSpeechDiagnostic({
      action: "failed",
      requestId: operation.requestId,
      stage: operation.stage,
      severity: "error",
      errorCode: nextProblem.errorCode,
      ...(nextProblem.correlationId ? { correlationId: nextProblem.correlationId } : {}),
      ...(operation.startedAt ? { elapsedMs: Date.now() - operation.startedAt } : {}),
    });
    setPhase("failed");
  }, [clearReview]);

  const cancel = useCallback(async (reason: SpeechCancelReason = "user") => {
    const operation = active.current;
    if (!operation) {
      dismissReview();
      return;
    }
    active.current = null;
    operation.canceled = true;
    stopOperationTimers(operation);
    await disposeOperationCapture(operation);
    await operation.transcription?.cancel(reason);
    clearReview();
    setContext(null);
    setDraftPreview(null);
    setWaveform(emptyWaveform());
    setElapsedMs(0);
    setLocalAudioOnly(false);
    setNotice(null);
    setProblem(null);
    setPhase("idle");
  }, [clearReview, dismissReview]);

  const writeChunk = useCallback(
    (operation: ActiveOperation, chunk: CapturedPcmChunk) => {
      // The built-in UI mock renders real local levels but never forwards the
      // microphone payload. A community runtime takes this exact branch off.
      if (operation.localMock) return;
      const transcription = operation.transcription;
      if (!transcription || operation.canceled) return;
      operation.pendingWrites += 1;
      if (operation.pendingWrites > MAX_PENDING_AUDIO_WRITES) {
        void fail(operation, new Error("音频上传速度跟不上录音，已取消本次转写"));
        return;
      }
      void transcription
        .pushAudio(chunk.index, chunk.captureStartMs, chunk.durationMs, chunk.pcm)
        .catch((error: unknown) => fail(operation, error))
        .finally(() => {
          operation.pendingWrites = Math.max(0, operation.pendingWrites - 1);
        });
    },
    [fail],
  );

  const stop = useCallback(async () => {
    const operation = active.current;
    if (!operation || !operation.recording) return;
    operation.recording = false;
    operation.stage = "finishing";
    setPhase("finishing");
    stopOperationTimers(operation);
    const recordedMs = operation.startedAt ? Date.now() - operation.startedAt : 0;
    setElapsedMs(recordedMs);
    setWaveform(emptyWaveform());
    try {
      await operation.capture?.stop((chunk) => writeChunk(operation, chunk));
      let completed: SpeechCompleted;
      if (operation.localMock) {
        if (!operation.voiceStartedAt) {
          throw new Error("没有检测到语音；麦克风已释放，请检查输入音量后重试");
        }
        if (!operation.context) throw new Error("Qwen3 Mock 缺少项目上下文");
        completed = mockSpeechCompletion(
          operation.context,
          operation.requestId,
          Math.max(recordedMs, 600),
        );
      } else {
        if (!operation.transcription) throw new Error("Qwen3-ASR 连接尚未建立");
        completed = await operation.transcription.finish();
      }
      if (operation.canceled || active.current !== operation) return;
      active.current = null;
      const selected = completed.candidates.find(
        (candidate) => candidate.candidateId === completed.defaultCandidateId,
      );
      if (!selected) throw new Error("Qwen3-ASR 没有返回默认候选");
      const segmentSelections = Object.fromEntries(
        (completed.segments ?? []).map((segment) => [segment.segmentId, segment.defaultCandidateId]),
      );
      review.current = {
        target: operation.target,
        snapshot: operation.snapshot,
        completed,
        testStub: operation.testStub,
        currentCandidateId: selected.candidateId,
        currentSegmentCandidateIds: segmentSelections,
        selectionRevision: 0,
      };
      const segmented = (completed.segments?.length ?? 0) > 0;
      commitRef.current(
        operation.snapshot,
        segmented ? composeSegmentText(completed, segmentSelections) : selected.text,
      );
      setDraftPreview(null);
      setResult(completed);
      setSelectedCandidateId(selected.candidateId);
      setSelectedSegmentCandidateIds(segmentSelections);
      setNotice(
        operation.testStub
          ? "协议 Stub 的固定测试结果已写入；可验证候选交互，但不会形成训练数据"
          : segmented
            ? `${completed.segments!.length} 个分段已写入；点击波浪线可局部纠正，不会自动发送`
            : `${completed.candidates.length} 个候选已返回；确认文字后再发送`,
      );
      emitSpeechDiagnostic({
        action: "completed",
        requestId: operation.requestId,
        stage: "completed",
        elapsedMs: operation.startedAt ? Date.now() - operation.startedAt : recordedMs,
        audioDurationMs: completed.durationMs,
        candidateCount: completed.candidates.length,
        segmentCount: completed.segments?.length ?? 0,
      });
      setProblem(null);
      setPhase("review");
    } catch (error) {
      await fail(operation, error);
    }
  }, [fail, writeChunk]);

  const selectCandidate = useCallback(async (candidate: SpeechCandidate) => {
    const operation = review.current;
    if (!operation) return;
    const known = operation.completed.candidates.find(
      (value) => value.candidateId === candidate.candidateId,
    );
    if (!known || operation.currentCandidateId === known.candidateId) return;
    operation.currentCandidateId = known.candidateId;
    operation.currentSegmentCandidateIds = {};
    operation.selectionRevision += 1;
    const selectionRevision = operation.selectionRevision;
    commitRef.current(operation.snapshot, known.text);
    setSelectedCandidateId(known.candidateId);
    setSelectedSegmentCandidateIds({});
    setNotice(`已采用候选 ${known.rank}，不会自动发送`);
    if (operation.testStub) {
      setNotice(`已采用 Stub 候选 ${known.rank}；仅验证交互，不会写入训练数据`);
      return;
    }
    try {
      const reply = await operation.target.client.call({
        type: "speech.feedback.record",
        payload: {
          workspaceId: operation.target.workspaceId,
          requestId: operation.completed.requestId,
          contextSnapshotId: operation.completed.contextSnapshotId,
          candidates: operation.completed.candidates,
          selectedCandidateId: known.candidateId,
          scoreKind: operation.completed.scoreKind,
        },
      });
      if (review.current !== operation || operation.selectionRevision !== selectionRevision) return;
      if (reply?.type !== "speechFeedbackReceipt") return;
      setNotice(
        reply.data.stored
          ? `已采用候选 ${known.rank}；偏好已保存到 ${reply.data.relativePath ?? ".genethub/speech"}`
          : `已采用候选 ${known.rank}；本地纠正收集未开启`,
      );
      emitSpeechDiagnostic({
        action: "feedback_recorded",
        requestId: operation.completed.requestId,
        stage: "review",
        stored: reply.data.stored,
        scope: "utterance",
        ...(reply.data.feedbackId ? { feedbackId: reply.data.feedbackId } : {}),
      });
    } catch (error) {
      if (review.current !== operation || operation.selectionRevision !== selectionRevision) return;
      setNotice(`已采用候选 ${known.rank}；偏好保存失败：${error instanceof Error ? error.message : "未知错误"}`);
      emitSpeechDiagnostic({
        action: "feedback_failed",
        requestId: operation.completed.requestId,
        stage: "review",
        severity: "error",
        errorCode: clientErrorCode(error),
        scope: "utterance",
      });
    }
  }, []);

  const selectSegmentCandidate = useCallback(async (
    segment: SpeechSegment,
    candidate: SpeechCandidate,
    uncertainSpan?: SpeechUncertainSpan,
  ) => {
    const operation = review.current;
    if (!operation) return;
    const knownSegment = operation.completed.segments?.find(
      (value) => value.segmentId === segment.segmentId,
    );
    const known = knownSegment?.candidates.find(
      (value) => value.candidateId === candidate.candidateId,
    );
    const rejectedCandidateId = knownSegment
      ? operation.currentSegmentCandidateIds[knownSegment.segmentId]
      : undefined;
    const knownSpan = uncertainSpan
      ? knownSegment?.uncertainSpans.find((value) => value.spanId === uncertainSpan.spanId)
      : undefined;
    if (
      !knownSegment ||
      !known ||
      rejectedCandidateId === known.candidateId ||
      (uncertainSpan && !knownSpan)
    ) {
      return;
    }

    const nextSelections = {
      ...operation.currentSegmentCandidateIds,
      [knownSegment.segmentId]: known.candidateId,
    };
    operation.currentSegmentCandidateIds = nextSelections;
    operation.selectionRevision += 1;
    const selectionRevision = operation.selectionRevision;
    const segmentIndex = operation.completed.segments!.findIndex(
      (value) => value.segmentId === knownSegment.segmentId,
    );
    const segmentTexts = selectedSegmentTexts(operation.completed, nextSelections);
    const transcript = segmentTexts.join("");
    commitRef.current(operation.snapshot, transcript);
    setSelectedCandidateId(null);
    setSelectedSegmentCandidateIds(nextSelections);
    setNotice(`已更新第 ${segmentIndex + 1} 段为候选 ${known.rank}，不会自动发送`);

    if (operation.testStub) {
      setNotice(`已更新第 ${segmentIndex + 1} 段的 Stub 候选；仅验证交互，不会写入训练数据`);
      return;
    }

    try {
      const reply = await operation.target.client.call({
        type: "speech.feedback.record",
        payload: {
          workspaceId: operation.target.workspaceId,
          requestId: operation.completed.requestId,
          contextSnapshotId: operation.completed.contextSnapshotId,
          candidates: knownSegment.candidates,
          selectedCandidateId: known.candidateId,
          ...(rejectedCandidateId ? { rejectedCandidateId } : {}),
          scope: {
            level: knownSpan ? "span" : "segment",
            utteranceText: transcript,
            segmentId: knownSegment.segmentId,
            segmentStartMs: knownSegment.startMs,
            segmentEndMs: knownSegment.endMs,
            precedingText: segmentTexts.slice(0, segmentIndex).join(""),
            followingText: segmentTexts.slice(segmentIndex + 1).join(""),
            ...(knownSpan
              ? {
                  uncertainSpanId: knownSpan.spanId,
                  spanStartChar: knownSpan.startChar,
                  spanEndChar: knownSpan.endChar,
                }
              : {}),
          },
          scoreKind: operation.completed.scoreKind,
        },
      });
      if (review.current !== operation || operation.selectionRevision !== selectionRevision) return;
      if (reply?.type !== "speechFeedbackReceipt") return;
      setNotice(
        reply.data.stored
          ? `已更新第 ${segmentIndex + 1} 段；分段偏好已保存到 ${reply.data.relativePath ?? ".genethub/speech"}`
          : `已更新第 ${segmentIndex + 1} 段；本地纠正收集未开启`,
      );
      emitSpeechDiagnostic({
        action: "feedback_recorded",
        requestId: operation.completed.requestId,
        stage: "review",
        stored: reply.data.stored,
        scope: knownSpan ? "span" : "segment",
        ...(reply.data.feedbackId ? { feedbackId: reply.data.feedbackId } : {}),
      });
    } catch (error) {
      if (review.current !== operation || operation.selectionRevision !== selectionRevision) return;
      setNotice(
        `已更新第 ${segmentIndex + 1} 段；偏好保存失败：${
          error instanceof Error ? error.message : "未知错误"
        }`,
      );
      emitSpeechDiagnostic({
        action: "feedback_failed",
        requestId: operation.completed.requestId,
        stage: "review",
        severity: "error",
        errorCode: clientErrorCode(error),
        scope: knownSpan ? "span" : "segment",
      });
    }
  }, []);

  const start = useCallback(async () => {
    if (!target || active.current) return;
    clearReview();
    const operation: ActiveOperation = {
      target,
      snapshot: getDraftRef.current(),
      canceled: false,
      requestId: makeRequestId(),
      pendingWrites: 0,
      recording: false,
      localMock: false,
      testStub: false,
      voiceFrames: 0,
      lastPreview: "",
      noticeStage: 0,
      stage: "preparing",
      partialReported: false,
    };
    active.current = operation;
    setPhase("preparing");
    setContext(null);
    setDraftPreview(null);
    setWaveform(emptyWaveform());
    setElapsedMs(0);
    setLocalAudioOnly(false);
    setProblem(null);
    setNotice("正在请求麦克风，并准备 Qwen3 项目上下文…");
    emitSpeechDiagnostic({
      action: "requested",
      requestId: operation.requestId,
      stage: operation.stage,
    });

    try {
      // Start the permission request in the original click activation. Waiting
      // for two daemon RPCs first loses the iOS/Safari prompt in embedded views.
      operation.capturePromise = MicrophoneCapture.prepare();
      // Mark a fast permission rejection handled while capability/context RPCs
      // are in flight; awaiting the original promise below still surfaces it.
      void operation.capturePromise.catch(() => {});
      operation.stage = "capabilities";
      const capabilities = await target.client.call({ type: "speech.capabilities" });
      if (capabilities?.type !== "speechCapabilities") {
        throw new Error("这台机器没有返回 Qwen3-ASR 能力信息");
      }
      if (capabilities.data.runtimeStatus.state !== "ready") {
        emitSpeechDiagnostic({
          action: "runtime_unavailable",
          requestId: operation.requestId,
          stage: operation.stage,
          severity: "error",
          errorCode: "runtimeUnavailable",
          runtimeId: capabilities.data.runtime.id,
          modelId: capabilities.data.runtime.model,
          implementation: capabilities.data.runtime.implementation,
        });
        operation.canceled = true;
        active.current = null;
        await disposeOperationCapture(operation);
        setProblem({
          requestId: operation.requestId,
          stage: operation.stage,
          errorCode: "runtimeUnavailable",
          userMessage: capabilities.data.runtimeStatus.message,
        });
        setPhase("failed");
        setNotice(capabilities.data.runtimeStatus.message);
        target.onOpenSettings();
        return;
      }
      emitSpeechDiagnostic({
        action: "capabilities",
        requestId: operation.requestId,
        stage: operation.stage,
        runtimeId: capabilities.data.runtime.id,
        modelId: capabilities.data.runtime.model,
        implementation: capabilities.data.runtime.implementation,
        candidateCount: capabilities.data.nBest.maxCandidates,
      });

      operation.stage = "context";
      const contextReply = await target.client.call({
        type: "speech.context.preview",
        payload: {
          workspaceId: target.workspaceId,
          sessionId: target.sessionId ?? null,
          draft: operation.snapshot.text || null,
        },
      });
      if (contextReply?.type !== "speechContext") {
        throw new Error("无法生成本次 Qwen3-ASR 上下文");
      }
      operation.context = contextReply.data;
      setContext(contextReply.data);
      emitSpeechDiagnostic({
        action: "context_ready",
        requestId: operation.requestId,
        stage: operation.stage,
        contextBytes: new TextEncoder().encode(JSON.stringify(contextReply.data)).byteLength,
        contextTerms: contextReply.data.terms.length,
      });

      operation.stage = "microphone";
      operation.capture = await operation.capturePromise;
      if (operation.canceled || active.current !== operation) {
        await operation.capture.dispose();
        return;
      }

      operation.testStub = ["stub", "mock"].includes(
        capabilities.data.runtime.implementation,
      );
      operation.localMock = capabilities.data.runtime.implementation === "mock";
      setLocalAudioOnly(operation.localMock);
      const startMessage: SpeechStart = {
        requestId: operation.requestId,
        workspaceId: target.workspaceId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        audio: { encoding: "pcmS16Le", sampleRateHz: 16_000, channels: 1 },
        languageHints: contextReply.data.languageHints,
        context: contextReply.data,
        contextRevision: 1,
        acceptPartial: capabilities.data.segmentation.partialResults,
      };
      if (!operation.localMock) {
        operation.stage = "runtime_open";
        operation.transcription = await SpeechTranscription.open(
          target.client,
          startMessage,
          capabilities.data.runtime,
          {
            onPartial(partial) {
              if (operation.canceled || active.current !== operation) return;
              operation.lastPreview = partial.text;
              setDraftPreview({ snapshot: operation.snapshot, text: partial.text });
              if (!operation.partialReported) {
                operation.partialReported = true;
                emitSpeechDiagnostic({
                  action: "first_partial",
                  requestId: operation.requestId,
                  stage: "recording",
                  ...(operation.startedAt
                    ? { elapsedMs: Date.now() - operation.startedAt }
                    : {}),
                  partialRevision: partial.revision,
                  audioEndMs: partial.audioEndMs,
                  partialCharacters: Array.from(partial.text).length,
                  stablePrefixCharacters: partial.stablePrefixChars,
                });
              }
            },
          },
        );
        if (operation.canceled || active.current !== operation) {
          await operation.transcription.cancel("targetChanged");
          await operation.capture.dispose();
          return;
        }
      }

      operation.recording = true;
      operation.stage = "recording";
      operation.startedAt = Date.now();
      operation.capture.start(
        (chunk) => writeChunk(operation, chunk),
        (error) => void fail(operation, error),
        (next) => onWaveform(operation, next),
      );
      setNotice(
        operation.localMock
          ? "麦克风已启用；真实波形仅在本机渲染，音频不上传"
          : operation.testStub
            ? "协议 Stub 正在接收真实分块音频；不会运行模型或保存音频"
            : "正在录音；音频通过已配对的 Qwen3 连接按块发送",
      );
      setPhase("recording");
      emitSpeechDiagnostic({
        action: "recording",
        requestId: operation.requestId,
        stage: operation.stage,
        runtimeId: capabilities.data.runtime.id,
        modelId: capabilities.data.runtime.model,
        implementation: capabilities.data.runtime.implementation,
      });
      operation.clock = setInterval(() => {
        if (active.current !== operation || !operation.recording || !operation.startedAt) return;
        const now = Date.now();
        setElapsedMs(now - operation.startedAt);
        if (!operation.localMock) return;
        if (!operation.voiceStartedAt) {
          if (now - operation.startedAt >= 1_500 && operation.noticeStage < 1) {
            operation.noticeStage = 1;
            setNotice("还没听到声音；请靠近麦克风或检查系统输入音量");
          }
          return;
        }
        const voiceElapsed = now - operation.voiceStartedAt;
        if (voiceElapsed >= MOCK_STREAM_PROFILE.audioChunkMs && operation.noticeStage < 2) {
          operation.noticeStage = 2;
          setNotice("首个 2 秒语音块已收集；仅模拟约 200ms 设备链路");
        }
        if (
          voiceElapsed >= MOCK_STREAM_PROFILE.audioChunkMs + MOCK_STREAM_PROFILE.networkMs &&
          operation.noticeStage < 3
        ) {
          operation.noticeStage = 3;
          setNotice("正在模拟 Qwen3 首批文字生成；未运行推理");
        }
        const partial = mockPartialTranscript(contextReply.data, voiceElapsed);
        if (partial && partial !== operation.lastPreview) {
          operation.lastPreview = partial;
          setDraftPreview({ snapshot: operation.snapshot, text: partial });
          setNotice("Best-1 已整批写入输入框；真实麦克风仍只用于本地波形");
        }
      }, 100);
      operation.timer = setTimeout(
        () => void stop(),
        Math.min(capabilities.data.maxDurationMs, DEFAULT_MAX_DURATION_MS),
      );
    } catch (error) {
      if (!operation.canceled) await fail(operation, error);
    }

    function onWaveform(current: ActiveOperation, next: CapturedWaveform) {
      if (active.current !== current || !current.recording) return;
      setWaveform(next.bars);
      if (current.voiceStartedAt) return;
      current.voiceFrames = next.rms >= VOICE_RMS_THRESHOLD
        ? current.voiceFrames + 1
        : Math.max(0, current.voiceFrames - 1);
      if (current.voiceFrames < VOICE_FRAMES_REQUIRED) return;
      current.voiceStartedAt = Date.now();
      current.noticeStage = 1;
      setNotice(
        current.localMock
          ? "检测到说话；正在收集首个 2 秒语音块（音频不上传）"
          : current.testStub
            ? "检测到说话；协议 Stub 正在验证正式音频与 Partial 链路"
            : "检测到说话；Qwen3 正在接收分块音频",
      );
    }
  }, [clearReview, fail, stop, target, writeChunk]);

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") void cancel("pageHidden");
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [cancel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !active.current) return;
      event.preventDefault();
      void cancel("user");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel]);

  useEffect(() => {
    const operation = active.current;
    if (
      operation &&
      (!target ||
        operation.target.client !== target.client ||
        operation.target.workspaceId !== target.workspaceId ||
        operation.target.sessionId !== target.sessionId)
    ) {
      void cancel("targetChanged");
      return;
    }
    const reviewed = review.current;
    if (
      reviewed &&
      (!target ||
        reviewed.target.client !== target.client ||
        reviewed.target.workspaceId !== target.workspaceId ||
        reviewed.target.sessionId !== target.sessionId)
    ) {
      dismissReview();
    }
  }, [cancel, dismissReview, target]);

  useEffect(() => () => {
    const operation = active.current;
    if (!operation) return;
    operation.canceled = true;
    stopOperationTimers(operation);
    void disposeOperationCapture(operation);
    void operation.transcription?.cancel("targetChanged");
  }, []);

  return {
    phase,
    busy: phase === "preparing" || phase === "recording" || phase === "finishing",
    notice,
    problem,
    context,
    draftPreview,
    waveform,
    elapsedMs,
    localAudioOnly,
    result,
    selectedCandidateId,
    selectedSegmentCandidateIds,
    start,
    stop,
    cancel,
    selectCandidate,
    selectSegmentCandidate,
    dismissReview,
  };
}

/** Compose one utterance from independently selected segment hypotheses. */
export function composeSegmentText(
  completed: SpeechCompleted,
  selectedCandidateIds: Record<string, string>,
): string {
  return selectedSegmentTexts(completed, selectedCandidateIds).join("");
}

function selectedSegmentTexts(
  completed: SpeechCompleted,
  selectedCandidateIds: Record<string, string>,
): string[] {
  if (!completed.segments?.length) return [completed.text];
  return completed.segments.map((segment) => {
    const candidateId = selectedCandidateIds[segment.segmentId] ?? segment.defaultCandidateId;
    return (
      segment.candidates.find((candidate) => candidate.candidateId === candidateId)?.text ??
      segment.text
    );
  });
}

/** Insert at the captured selection; the composer remains in review state. */
export function insertSpeechText(snapshot: SpeechDraftSnapshot, transcript: string): {
  text: string;
  cursor: number;
} {
  const inserted = speechInsertion(snapshot, transcript);
  return { text: inserted.text, cursor: inserted.cursor };
}

export function insertedSpeechRange(
  snapshot: SpeechDraftSnapshot,
  transcript: string,
): { start: number; end: number } {
  const inserted = speechInsertion(snapshot, transcript);
  return { start: inserted.start, end: inserted.end };
}

function speechInsertion(snapshot: SpeechDraftSnapshot, transcript: string): {
  text: string;
  cursor: number;
  start: number;
  end: number;
} {
  const start = Math.max(0, Math.min(snapshot.selectionStart, snapshot.text.length));
  const end = Math.max(start, Math.min(snapshot.selectionEnd, snapshot.text.length));
  const before = snapshot.text.slice(0, start);
  const after = snapshot.text.slice(end);
  const value = transcript.trim();
  const prefix = asciiWordBoundary(before, value) ? " " : "";
  const suffix = asciiWordBoundary(value, after) ? " " : "";
  const inserted = `${prefix}${value}${suffix}`;
  const transcriptStart = before.length + prefix.length;
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length,
    start: transcriptStart,
    end: transcriptStart + value.length,
  };
}

function asciiWordBoundary(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function makeRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `speech-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyWaveform(): number[] {
  return Array.from({ length: WAVEFORM_BARS }, () => 0);
}

function stopOperationTimers(operation: ActiveOperation): void {
  if (operation.timer) clearTimeout(operation.timer);
  if (operation.clock) clearInterval(operation.clock);
  operation.timer = undefined;
  operation.clock = undefined;
}

async function disposeOperationCapture(operation: ActiveOperation): Promise<void> {
  if (operation.capture) {
    await operation.capture.dispose();
    return;
  }
  // A permission prompt can still be open when a capability check fails or the
  // user navigates away. Do not strand a track if that promise resolves later.
  if (operation.capturePromise) {
    void operation.capturePromise
      .then((capture) => capture.dispose())
      .catch(() => {});
  }
}

function speechErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
  const message = error instanceof Error ? error.message : "未知错误";
  if (message.startsWith("没有检测到语音")) return message;
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "麦克风需要安全连接；请通过 HTTPS、localhost 或桌面 App 打开";
  }
  const policy = typeof document === "undefined"
    ? undefined
    : (document as Document & {
        permissionsPolicy?: { allowsFeature?(feature: string): boolean };
        featurePolicy?: { allowsFeature?(feature: string): boolean };
      }).permissionsPolicy ??
      (document as Document & {
        featurePolicy?: { allowsFeature?(feature: string): boolean };
      }).featurePolicy;
  try {
    if (policy?.allowsFeature?.("microphone") === false) {
      return "当前预览没有开放麦克风；请开启 Asset Preview 的“设备访问”后重试";
    }
  } catch {
    // Some WebViews expose the policy object but throw while querying it.
  }
  const microphoneErrors: Record<string, string> = {
    NotAllowedError: "没有麦克风权限；请在浏览器或系统设置中允许后重试",
    PermissionDeniedError: "没有麦克风权限；请在浏览器或系统设置中允许后重试",
    NotFoundError: "未检测到麦克风；请连接输入设备后重试",
    DevicesNotFoundError: "未检测到麦克风；请连接输入设备后重试",
    NotReadableError: "麦克风暂时不可用；可能正被其他应用占用",
    TrackStartError: "麦克风暂时不可用；可能正被其他应用占用",
    OverconstrainedError: "当前麦克风不兼容；请更换系统输入设备后重试",
    SecurityError: "当前页面无法访问麦克风；请检查安全连接和设备访问权限",
    NotSupportedError: "当前客户端不支持语音输入；请使用较新的 Safari、Chrome 或 Edge",
    AbortError: "麦克风启动被中断；请重新点击麦克风",
  };
  if (microphoneErrors[name]) {
    return microphoneErrors[name]!;
  }
  return `Qwen3-ASR 转写失败：${message}`;
}

/** Stable, content-free failure classification suitable for support bundles. */
function clientErrorCode(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
  const known = new Set([
    "NotAllowedError",
    "PermissionDeniedError",
    "NotFoundError",
    "DevicesNotFoundError",
    "NotReadableError",
    "TrackStartError",
    "OverconstrainedError",
    "SecurityError",
    "NotSupportedError",
    "AbortError",
  ]);
  return known.has(name) ? name : "clientError";
}

function speechCorrelationId(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.match(/\bsp_[a-f0-9]{20}\b/)?.[0];
}

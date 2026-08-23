import type {
  SpeechCancelReason,
  SpeechCandidate,
  SpeechCompleted,
  SpeechFailure,
  SpeechPartial,
  SpeechReady,
  SpeechRuntimeDescriptor,
  SpeechSegment,
  SpeechStart,
} from "@genehub/proto";

import { DataReset, type DataStream } from "../dataplane";
import type { Client } from "../protocol/client";
import {
  SpeechFrameDecoder,
  SpeechFrameKind,
  SpeechProtocolError,
  type SpeechFrame,
  decodeSpeechJson,
  encodeSpeechAudio,
  encodeSpeechFrame,
  encodeSpeechJson,
} from "./protocol";

const OPEN_TIMEOUT_MS = 20_000;
const FINAL_TIMEOUT_MS = 35_000;
const CANCEL_TIMEOUT_MS = 2_000;
const MAX_DURATION_MS = 5 * 60 * 1_000;
const MAX_CANDIDATES = 5;
const MAX_TRANSCRIPT_CHARACTERS = 4_000;
const MAX_SEGMENTS = 32;
const MAX_UNCERTAIN_SPANS = 12;
const MAX_SEGMENT_CANDIDATE_CHARS = 16_000;

export interface SpeechTranscriptionHandlers {
  onContextApplied?(revision: number): void;
  onPartial?(partial: SpeechPartial): void;
}

export class SpeechTranscriptionError extends Error {
  constructor(readonly failure: SpeechFailure) {
    super(failure.message);
    this.name = "SpeechTranscriptionError";
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** One offline Qwen3 transcription running over a GeneHub logical stream. */
export class SpeechTranscription {
  private readonly ready = deferred<SpeechReady>();
  private readonly terminal = deferred<SpeechCompleted>();
  private readonly decoder = new SpeechFrameDecoder();
  private writeTail: Promise<void> = Promise.resolve();
  private writeFailure: unknown;
  private terminalSettled = false;
  private partialRevision = 0;
  private state: "opening" | "recording" | "finishing" | "canceled" | "closed" = "opening";

  private constructor(
    private readonly stream: DataStream,
    private readonly start: SpeechStart,
    private readonly expectedRuntime: SpeechRuntimeDescriptor,
    private readonly handlers: SpeechTranscriptionHandlers,
  ) {
    void this.ready.promise.catch(() => {});
    void this.terminal.promise.catch(() => {});
  }

  static async open(
    client: Client,
    start: SpeechStart,
    expectedRuntime: SpeechRuntimeDescriptor,
    handlers: SpeechTranscriptionHandlers = {},
  ): Promise<SpeechTranscription> {
    const stream = client.openSpeechStream();
    const transcription = new SpeechTranscription(stream, start, expectedRuntime, handlers);
    try {
      const head = await within(
        (async () => {
          await stream.write(encodeSpeechJson(SpeechFrameKind.Start, start));
          return stream.responseHead;
        })(),
        OPEN_TIMEOUT_MS,
        "Qwen3-ASR runtime 没有及时接受请求",
      );
      const metadata = record(head.metadata);
      if (
        head.status !== 200 ||
        metadata.codec !== "genehub-speech-v2"
      ) {
        throw new SpeechProtocolError(head.error?.message ?? `speech stream was refused (${head.status})`);
      }
      transcription.readResponses();
      await within(transcription.ready.promise, OPEN_TIMEOUT_MS, "Qwen3-ASR runtime 准备超时");
      transcription.state = "recording";
      return transcription;
    } catch (error) {
      stream.reset(DataReset.Cancelled);
      throw error;
    }
  }

  pushAudio(index: number, captureStartMs: number, durationMs: number, pcm: Uint8Array): Promise<void> {
    if (this.state !== "recording") {
      return Promise.reject(new SpeechProtocolError("speech transcription is not recording"));
    }
    return this.enqueue(encodeSpeechAudio(index, captureStartMs, durationMs, pcm));
  }

  async finish(): Promise<SpeechCompleted> {
    if (this.state !== "recording") {
      throw new SpeechProtocolError("speech transcription cannot be finished from its current state");
    }
    this.state = "finishing";
    try {
      return await within(
        (async () => {
          await this.writeTail;
          if (this.writeFailure) throw this.writeFailure;
          await this.stream.write(encodeSpeechFrame(SpeechFrameKind.Finish));
          await this.stream.finish();
          return this.terminal.promise;
        })(),
        FINAL_TIMEOUT_MS,
        "停止录音后等待 Qwen3-ASR 候选超时",
      );
    } catch (error) {
      this.stream.reset(DataReset.Timeout);
      throw error;
    }
  }

  async cancel(reason: SpeechCancelReason = "user"): Promise<void> {
    if (this.state === "canceled" || this.state === "closed") return;
    this.state = "canceled";
    try {
      await within(
        (async () => {
          await this.writeTail;
          await this.stream.write(encodeSpeechJson(SpeechFrameKind.Cancel, { reason }));
          await this.stream.finish();
        })(),
        CANCEL_TIMEOUT_MS,
        "取消 Qwen3-ASR 转写超时",
      );
    } catch {
      this.stream.reset(DataReset.Cancelled);
    }
  }

  private enqueue(bytes: Uint8Array): Promise<void> {
    const current = this.writeTail.then(() => this.stream.write(bytes));
    this.writeTail = current;
    void current.catch((error: unknown) => {
      this.writeFailure = error;
      this.fail(error);
    });
    return current;
  }

  private readResponses(): void {
    void (async () => {
      for await (const chunk of this.stream.body()) {
        for (const frame of this.decoder.push(chunk)) this.onFrame(frame);
      }
      this.decoder.finish();
      if (!this.terminalSettled && this.state !== "canceled") {
        throw new SpeechProtocolError("语音流在 Qwen3-ASR 最终候选前结束");
      }
    })()
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        if (this.state !== "canceled") this.state = "closed";
        void this.stream.finish().catch(() => {});
      });
  }

  private onFrame(frame: SpeechFrame): void {
    switch (frame.kind) {
      case SpeechFrameKind.Ready: {
        const ready = decodeSpeechJson<SpeechReady>(frame);
        if (
          ready.requestId !== this.start.requestId ||
          ready.runtimeId !== this.expectedRuntime.id ||
          ready.modelId !== this.expectedRuntime.model ||
          ready.contextRevision !== this.start.contextRevision
        ) {
          throw new SpeechProtocolError("speech Ready does not match the requested Qwen3 session");
        }
        this.ready.resolve(ready);
        return;
      }
      case SpeechFrameKind.ContextApplied:
        this.handlers.onContextApplied?.(decodeSpeechJson<{ revision: number }>(frame).revision);
        return;
      case SpeechFrameKind.Partial: {
        const partial = decodeSpeechJson<SpeechPartial>(frame);
        validatePartial(partial, this.start, this.partialRevision);
        this.partialRevision = partial.revision;
        this.handlers.onPartial?.(partial);
        return;
      }
      case SpeechFrameKind.Completed: {
        const completed = decodeSpeechJson<SpeechCompleted>(frame);
        validateCompleted(completed, this.start.requestId);
        this.terminalSettled = true;
        this.terminal.resolve(completed);
        return;
      }
      case SpeechFrameKind.Failed: {
        const failure = decodeSpeechJson<SpeechFailure>(frame);
        const error = new SpeechTranscriptionError(failure);
        this.terminalSettled = true;
        this.ready.reject(error);
        this.terminal.reject(error);
        return;
      }
      default:
        throw new SpeechProtocolError(`unexpected daemon speech frame ${frame.kind}`);
    }
  }

  private fail(error: unknown): void {
    if (this.terminalSettled) return;
    this.terminalSettled = true;
    this.ready.reject(error);
    this.terminal.reject(error);
  }
}

export function validateCompleted(completed: SpeechCompleted, requestId: string): void {
  if (
    !completed ||
    completed.requestId !== requestId ||
    typeof completed.contextSnapshotId !== "string" ||
    completed.contextSnapshotId.length < 1 ||
    completed.contextSnapshotId.length > 128 ||
    !Number.isSafeInteger(completed.durationMs) ||
    completed.durationMs < 0 ||
    completed.durationMs > MAX_DURATION_MS ||
    !Array.isArray(completed.candidates) ||
    completed.candidates.length < 1 ||
    completed.candidates.length > MAX_CANDIDATES ||
    (completed.scoreKind !== "unavailable" &&
      completed.scoreKind !== "mockRelative" &&
      completed.scoreKind !== "lengthNormalizedLogProbability") ||
    typeof completed.scoresCalibrated !== "boolean" ||
    typeof completed.defaultCandidateId !== "string"
  ) {
    throw new SpeechProtocolError("Qwen3-ASR completion identity or candidate count is invalid");
  }
  validateCandidates(completed.candidates);
  const selected = completed.candidates.find(
    (candidate) => candidate.candidateId === completed.defaultCandidateId,
  );
  if (
    typeof completed.text !== "string" ||
    !selected ||
    selected.rank !== 1 ||
    selected.text !== completed.text
  ) {
    throw new SpeechProtocolError("Qwen3-ASR default candidate does not match its transcript");
  }
  if (completed.segments !== undefined) validateSegments(completed, completed.segments);
}

export function validatePartial(
  partial: SpeechPartial,
  start: SpeechStart,
  previousRevision: number,
): void {
  const characters = Array.from(partial?.text ?? "").length;
  if (
    !start.acceptPartial ||
    !partial ||
    partial.requestId !== start.requestId ||
    !Number.isSafeInteger(partial.revision) ||
    partial.revision <= previousRevision ||
    typeof partial.text !== "string" ||
    characters > MAX_TRANSCRIPT_CHARACTERS ||
    !Number.isSafeInteger(partial.audioEndMs) ||
    partial.audioEndMs < 0 ||
    partial.audioEndMs > MAX_DURATION_MS ||
    !Number.isSafeInteger(partial.stablePrefixChars) ||
    partial.stablePrefixChars < 0 ||
    partial.stablePrefixChars > characters
  ) {
    throw new SpeechProtocolError("Qwen3-ASR partial identity, revision or text is invalid");
  }
}

function validateCandidates(candidates: SpeechCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
    throw new SpeechProtocolError("Qwen3-ASR returned an invalid or duplicate candidate");
  }
  const ids = new Set<string>();
  const ranks = new Set<number>();
  const texts = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.candidateId !== "string" ||
      !candidate.candidateId ||
      candidate.candidateId.length > 128 ||
      hasControl(candidate.candidateId) ||
      !Number.isSafeInteger(candidate.rank) ||
      candidate.rank < 1 ||
      candidate.rank > MAX_CANDIDATES ||
      typeof candidate.text !== "string" ||
      !candidate.text.trim() ||
      Array.from(candidate.text).length > MAX_TRANSCRIPT_CHARACTERS ||
      !Number.isFinite(candidate.score) ||
      !Array.isArray(candidate.matchedTerms) ||
      candidate.matchedTerms.length > 20 ||
      candidate.matchedTerms.some(
        (term) =>
          typeof term !== "string" ||
          !term.trim() ||
          Array.from(term).length > 64 ||
          !candidate.text.includes(term),
      ) ||
      ids.has(candidate.candidateId) ||
      ranks.has(candidate.rank) ||
      texts.has(candidate.text.trim())
    ) {
      throw new SpeechProtocolError("Qwen3-ASR returned an invalid or duplicate candidate");
    }
    ids.add(candidate.candidateId);
    ranks.add(candidate.rank);
    texts.add(candidate.text.trim());
  }
  if (!candidates.every((_, index) => ranks.has(index + 1))) {
    throw new SpeechProtocolError("Qwen3-ASR candidate ranks are not contiguous");
  }
}

function validateSegments(completed: SpeechCompleted, segments: SpeechSegment[]): void {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_SEGMENTS) {
    throw new SpeechProtocolError("Qwen3-ASR returned an invalid segment count");
  }
  const utterance = Array.from(completed.text);
  const segmentIds = new Set<string>();
  const candidateIds = new Set<string>();
  const spanIds = new Set<string>();
  let previousTextEnd = 0;
  let previousAudioEnd = 0;
  let candidateCharacters = 0;
  let maximumComposedCharacters = 0;

  segments.forEach((segment, index) => {
    if (
      !segment ||
      typeof segment.segmentId !== "string" ||
      !segment.segmentId ||
      segment.segmentId.length > 128 ||
      hasControl(segment.segmentId) ||
      segmentIds.has(segment.segmentId) ||
      !Number.isSafeInteger(segment.startMs) ||
      !Number.isSafeInteger(segment.endMs) ||
      segment.startMs < previousAudioEnd ||
      segment.startMs > segment.endMs ||
      segment.endMs > completed.durationMs ||
      !Number.isSafeInteger(segment.textStartChar) ||
      !Number.isSafeInteger(segment.textEndChar) ||
      segment.textStartChar !== previousTextEnd ||
      segment.textStartChar >= segment.textEndChar ||
      segment.textEndChar > utterance.length ||
      utterance.slice(segment.textStartChar, segment.textEndChar).join("") !== segment.text ||
      !segment.boundary ||
      !["voiceActivity", "decoderEndpoint", "maxDuration", "final"].includes(
        segment.boundary.kind,
      ) ||
      !Number.isFinite(segment.boundary.confidence) ||
      segment.boundary.confidence < 0 ||
      segment.boundary.confidence > 1 ||
      (index === segments.length - 1) !== (segment.boundary.kind === "final")
    ) {
      throw new SpeechProtocolError("Qwen3-ASR returned an invalid segment range or boundary");
    }
    segmentIds.add(segment.segmentId);
    validateCandidates(segment.candidates);
    const defaultCandidate = segment.candidates.find(
      (candidate) => candidate.candidateId === segment.defaultCandidateId,
    );
    if (!defaultCandidate || defaultCandidate.rank !== 1 || defaultCandidate.text !== segment.text) {
      throw new SpeechProtocolError("Qwen3-ASR segment default candidate does not match its text");
    }
    for (const candidate of segment.candidates) {
      if (candidateIds.has(candidate.candidateId)) {
        throw new SpeechProtocolError("Qwen3-ASR segment candidate ids are not unique");
      }
      candidateIds.add(candidate.candidateId);
      candidateCharacters += Array.from(candidate.text).length;
    }
    maximumComposedCharacters += Math.max(
      ...segment.candidates.map((candidate) => Array.from(candidate.text).length),
    );
    if (candidateCharacters > MAX_SEGMENT_CANDIDATE_CHARS) {
      throw new SpeechProtocolError("Qwen3-ASR segment candidate text exceeds its budget");
    }
    validateUncertainSpans(segment, spanIds);
    previousTextEnd = segment.textEndChar;
    previousAudioEnd = segment.endMs;
  });

  if (previousTextEnd !== utterance.length) {
    throw new SpeechProtocolError("Qwen3-ASR segments do not cover the complete transcript");
  }
  if (maximumComposedCharacters > MAX_TRANSCRIPT_CHARACTERS) {
    throw new SpeechProtocolError("Qwen3-ASR segment alternatives compose an oversized transcript");
  }
}

function validateUncertainSpans(segment: SpeechSegment, globalSpanIds: Set<string>): void {
  if (!Array.isArray(segment.uncertainSpans) || segment.uncertainSpans.length > MAX_UNCERTAIN_SPANS) {
    throw new SpeechProtocolError("Qwen3-ASR returned too many uncertain spans");
  }
  const segmentCharacters = Array.from(segment.text);
  const candidates = new Map(segment.candidates.map((candidate) => [candidate.candidateId, candidate]));
  let previousEnd = 0;
  for (const span of segment.uncertainSpans) {
    if (
      !span ||
      typeof span.spanId !== "string" ||
      !span.spanId ||
      span.spanId.length > 128 ||
      hasControl(span.spanId) ||
      globalSpanIds.has(span.spanId) ||
      !Number.isSafeInteger(span.startChar) ||
      !Number.isSafeInteger(span.endChar) ||
      span.startChar < previousEnd ||
      span.startChar >= span.endChar ||
      span.endChar > segmentCharacters.length ||
      !Array.isArray(span.alternatives) ||
      span.alternatives.length < 2 ||
      span.alternatives.length > MAX_CANDIDATES
    ) {
      throw new SpeechProtocolError("Qwen3-ASR returned an invalid uncertain span");
    }
    globalSpanIds.add(span.spanId);
    const alternativeIds = new Set<string>();
    const alternativeCandidates = new Set<string>();
    for (const alternative of span.alternatives) {
      const candidate = candidates.get(alternative.candidateId);
      if (
        !alternative ||
        typeof alternative.alternativeId !== "string" ||
        !alternative.alternativeId ||
        alternative.alternativeId.length > 128 ||
        hasControl(alternative.alternativeId) ||
        alternativeIds.has(alternative.alternativeId) ||
        alternativeCandidates.has(alternative.candidateId) ||
        typeof alternative.text !== "string" ||
        !alternative.text.trim() ||
        Array.from(alternative.text).length > 256 ||
        !Number.isFinite(alternative.score) ||
        !candidate ||
        !candidate.text.includes(alternative.text)
      ) {
        throw new SpeechProtocolError("Qwen3-ASR returned an invalid uncertain-span alternative");
      }
      alternativeIds.add(alternative.alternativeId);
      alternativeCandidates.add(alternative.candidateId);
    }
    const defaultAlternative = span.alternatives.find(
      (alternative) => alternative.alternativeId === span.defaultAlternativeId,
    );
    if (
      !defaultAlternative ||
      defaultAlternative.candidateId !== segment.defaultCandidateId ||
      defaultAlternative.text !== segmentCharacters.slice(span.startChar, span.endChar).join("")
    ) {
      throw new SpeechProtocolError("Qwen3-ASR uncertain-span default does not match segment text");
    }
    previousEnd = span.endChar;
  }
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => /\p{Cc}/u.test(character));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SpeechProtocolError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

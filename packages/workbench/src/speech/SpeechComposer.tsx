import type { SpeechCompleted, SpeechSegment, SpeechUncertainSpan } from "@genehub/proto";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import type {
  SpeechInputController,
  SpeechInputPhase,
  SpeechInputProblem,
} from "./useSpeechInput";

export interface SpeechTextRange {
  start: number;
  end: number;
}

interface ActiveSpan {
  segment: SpeechSegment;
  span: SpeechUncertainSpan;
  anchor: DOMRect;
}

export function SpeechStatusStrip({
  phase,
  notice,
  waveform,
  elapsedMs,
  localAudioOnly,
  problem,
  onOpenLogs,
  onReportProblem,
}: {
  phase: SpeechInputPhase;
  notice: string | null;
  waveform: number[];
  elapsedMs: number;
  localAudioOnly: boolean;
  problem: SpeechInputProblem | null;
  onOpenLogs?(): void;
  onReportProblem?(problem: SpeechInputProblem): void;
}) {
  if (phase === "idle" && !notice) return null;
  const recording = phase === "recording";
  const failed = phase === "failed";
  const pending = phase === "preparing" || phase === "finishing";
  return (
    <div
      data-speech-strip={phase}
      role={failed ? "alert" : "status"}
      className="flex min-h-8 items-center gap-2 border-b border-line px-3 text-xs text-muted"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          recording
            ? "animate-pulse bg-danger"
            : failed
              ? "bg-danger"
              : pending
                ? "animate-pulse bg-amber-400"
                : "bg-accent-bright"
        }`}
      />
      <span className={`min-w-0 flex-1 truncate ${failed ? "text-danger" : ""}`}>
        {notice ?? speechPhaseLabel(phase)}
      </span>
      {failed && onOpenLogs ? (
        <button
          type="button"
          className="shrink-0 underline decoration-dotted hover:text-fg"
          onClick={onOpenLogs}
        >
          查看日志
        </button>
      ) : null}
      {failed && problem && onReportProblem ? (
        <button
          type="button"
          className="shrink-0 underline decoration-dotted hover:text-fg"
          onClick={() => onReportProblem(problem)}
        >
          反馈本次问题
        </button>
      ) : null}
      {localAudioOnly && (recording || phase === "finishing") ? (
        <span className="hidden shrink-0 text-faint sm:inline">音频仅本机</span>
      ) : null}
      {recording ? (
        <>
          <span className="shrink-0 font-mono text-faint">{formatDuration(elapsedMs)}</span>
          <span className="flex h-[18px] w-[50px] shrink-0 items-center justify-center gap-[2px]" aria-label="实时麦克风波形">
            {waveform.map((level, index) => (
              <i
                // Positional bars are intentionally stable across every frame.
                key={index}
                className="block w-0.5 rounded-full bg-accent-bright transition-[height] duration-75"
                style={{ height: `${Math.round(2 + Math.pow(level, 0.72) * 14)}px` }}
              />
            ))}
          </span>
        </>
      ) : null}
    </div>
  );
}

export function SpeechTranscriptOverlay({
  text,
  range,
  result,
  selectedSegmentCandidateIds,
  scrollTop,
  onOpenSpan,
}: {
  text: string;
  range: SpeechTextRange;
  result: SpeechCompleted | null;
  selectedSegmentCandidateIds: Record<string, string>;
  scrollTop: number;
  onOpenSpan(active: ActiveSpan): void;
}) {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const transcript = text.slice(range.start, range.end);
  const tokens = useMemo(
    () => reviewTokens(result, selectedSegmentCandidateIds, transcript),
    [result, selectedSegmentCandidateIds, transcript],
  );
  return (
    <div
      data-speech-transcript-overlay
      className="pointer-events-none absolute inset-0 z-[2] overflow-hidden px-3 py-1.5 text-base leading-9 text-fg md:py-1 md:text-sm md:leading-6"
    >
      <div
        className="whitespace-pre-wrap break-words"
        style={{ transform: `translateY(${-scrollTop}px)` }}
      >
        {before}
        {tokens.map((token, index) =>
          token.span && token.segment ? (
            <button
              key={`${token.span.spanId}-${index}`}
              type="button"
              data-diagnostic-text="speech-transcript"
              aria-label={`${token.text}，点击查看局部识别候选`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) =>
                onOpenSpan({
                  segment: token.segment!,
                  span: token.span!,
                  anchor: event.currentTarget.getBoundingClientRect(),
                })
              }
              className={`pointer-events-auto inline !min-h-0 !min-w-0 rounded-sm border-0 bg-transparent p-0 [font:inherit] text-inherit underline decoration-wavy decoration-[1.35px] underline-offset-4 hover:bg-raised/80 ${
                token.level === "attention"
                  ? "decoration-amber-400"
                  : "decoration-accent-bright"
              }`}
            >
              {token.text}
            </button>
          ) : (
            <span key={`text-${index}`}>{token.text}</span>
          ),
        )}
        {!result ? (
          <span
            aria-hidden
            className="ml-0.5 inline-block h-[1.08em] w-[1.5px] animate-pulse rounded-full bg-accent-bright align-[-0.16em]"
          />
        ) : null}
        {after}
      </div>
    </div>
  );
}

export function SpeechReviewLegend() {
  return (
    <div className="mx-3 mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-faint">
      <span className="inline-flex items-center gap-1">
        <i className="h-1.5 w-1.5 rounded-full bg-accent-bright" />有相近候选
      </span>
      <span className="inline-flex items-center gap-1">
        <i className="h-1.5 w-1.5 rounded-full bg-amber-400" />建议确认
      </span>
      <span>点击带波浪线的文字</span>
    </div>
  );
}

export function SpeechCandidatePopover({
  active,
  selectedCandidateId,
  controller,
  onClose,
}: {
  active: ActiveSpan | null;
  selectedCandidateId: string | null;
  controller: Pick<SpeechInputController, "selectSegmentCandidate">;
  onClose(): void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) return;
    first.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [active, onClose]);
  if (!active || typeof document === "undefined") return null;
  const { segment, span, anchor } = active;
  const selected = selectedCandidateId ?? segment.defaultCandidateId;
  const current = span.alternatives.find((item) => item.candidateId === selected)?.text ??
    span.alternatives.find((item) => item.alternativeId === span.defaultAlternativeId)?.text ??
    "这一处";
  const width = Math.min(334, Math.max(280, window.innerWidth - 20));
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left + anchor.width / 2 - width / 2));
  const estimatedHeight = Math.min(250, 58 + span.alternatives.length * 53);
  const above = anchor.top - estimatedHeight - 10 > 8;
  const top = above
    ? anchor.top - estimatedHeight - 10
    : Math.min(window.innerHeight - estimatedHeight - 8, anchor.bottom + 10);

  return createPortal(
    <>
      <button
        type="button"
        aria-label="关闭识别候选"
        onClick={onClose}
        className="fixed inset-0 z-30 !min-h-0 !min-w-0 cursor-default bg-black/10"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`“${current}”的局部识别候选`}
        className="fixed z-40 overflow-hidden rounded-2xl border border-line-strong bg-raised/95 shadow-[0_18px_54px_rgb(0_0_0_/0.5)] backdrop-blur max-md:!bottom-[calc(var(--keyboard,0px)+max(0.5rem,env(safe-area-inset-bottom)))] max-md:!left-2 max-md:!top-auto max-md:!w-[calc(100vw-1rem)]"
        style={{ left, top, width }}
      >
        <header className="flex items-start justify-between gap-2 border-b border-line px-3 py-2.5">
          <div className="min-w-0">
            <strong className="block text-sm font-medium text-fg">选择“{current}”</strong>
            <span className="mt-0.5 block truncate text-xs text-faint">只替换这一处分段，并记录选择偏好</span>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-8 w-8 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div role="listbox" aria-label="局部识别候选" className="max-h-[min(280px,55vh)] overflow-y-auto p-1.5">
          {span.alternatives.map((alternative, index) => {
            const candidate = segment.candidates.find(
              (item) => item.candidateId === alternative.candidateId,
            );
            if (!candidate) return null;
            const pressed = candidate.candidateId === selected;
            const contextual = candidate.matchedTerms.some(
              (term) => alternative.text.includes(term) || term.includes(alternative.text),
            );
            return (
              <button
                ref={index === 0 ? first : undefined}
                key={alternative.alternativeId}
                type="button"
                data-diagnostic-text="speech-candidate"
                role="option"
                aria-selected={pressed}
                onClick={() => {
                  onClose();
                  void controller.selectSegmentCandidate(segment, candidate, span);
                }}
                className="grid min-h-[50px] w-full grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-surface focus-visible:bg-surface"
              >
                <span className={`grid h-6 w-6 place-items-center rounded-md font-mono text-[10px] ${contextual ? "bg-accent/20 text-accent-bright" : "bg-surface text-faint"}`}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium text-fg">{alternative.text}</strong>
                  <span className="mt-0.5 block truncate text-xs text-faint">
                    {pressed ? "当前 Best-1" : contextual ? "工作区上下文候选" : "局部识别候选"}
                  </span>
                </span>
                {pressed ? (
                  <Check className="h-4 w-4 text-accent-bright" aria-hidden />
                ) : contextual ? (
                  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-bright">工作区优先</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>
    </>,
    document.body,
  );
}

export type { ActiveSpan };

interface ReviewToken {
  text: string;
  segment?: SpeechSegment;
  span?: SpeechUncertainSpan;
  level?: "nearby" | "attention";
}

function reviewTokens(
  result: SpeechCompleted | null,
  selections: Record<string, string>,
  fallback: string,
): ReviewToken[] {
  if (!result?.segments?.length) return [{ text: fallback }];
  const tokens: ReviewToken[] = [];
  for (const segment of result.segments) {
    const selectedId = selections[segment.segmentId] ?? segment.defaultCandidateId;
    const selected = segment.candidates.find((item) => item.candidateId === selectedId) ??
      segment.candidates[0];
    if (!selected) continue;
    let candidateCursor = 0;
    const located = segment.uncertainSpans
      .map((span) => {
        const alternative = span.alternatives.find((item) => item.candidateId === selected.candidateId) ??
          span.alternatives.find((item) => item.alternativeId === span.defaultAlternativeId);
        if (!alternative) return null;
        const start = selected.candidateId === segment.defaultCandidateId
          ? unicodeScalarToUtf16(selected.text, span.startChar)
          : selected.text.indexOf(alternative.text, candidateCursor);
        if (start < 0) return null;
        candidateCursor = start + alternative.text.length;
        const contextualAlternative = span.alternatives.some((candidateAlternative) => {
          const candidate = segment.candidates.find(
            (item) => item.candidateId === candidateAlternative.candidateId,
          );
          return candidate?.matchedTerms.some(
            (term) =>
              candidateAlternative.text.includes(term) ||
              term.includes(candidateAlternative.text),
          );
        });
        return {
          span,
          text: alternative.text,
          start,
          end: start + alternative.text.length,
          level: contextualAlternative && selected.candidateId === segment.defaultCandidateId
            ? "attention" as const
            : "nearby" as const,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => left.start - right.start);
    let cursor = 0;
    for (const item of located) {
      if (item.start < cursor) continue;
      if (item.start > cursor) tokens.push({ text: selected.text.slice(cursor, item.start) });
      tokens.push({
        text: item.text,
        segment,
        span: item.span,
        level: item.level,
      });
      cursor = item.end;
    }
    if (cursor < selected.text.length) tokens.push({ text: selected.text.slice(cursor) });
  }
  return tokens.length > 0 ? tokens : [{ text: fallback }];
}

function speechPhaseLabel(phase: SpeechInputPhase): string {
  switch (phase) {
    case "preparing": return "正在准备麦克风";
    case "recording": return "正在听写";
    case "finishing": return "正在完成文字";
    case "review": return "听写已写入输入框";
    case "failed": return "语音输入失败";
    default: return "";
  }
}

function unicodeScalarToUtf16(text: string, offset: number): number {
  return Array.from(text).slice(0, Math.max(0, offset)).join("").length;
}

function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1_000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

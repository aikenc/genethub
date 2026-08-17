import type { AgentInfo, Attachment, CommandInfo } from "@genehub/proto";
import { Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  composeSegmentText,
  insertedSpeechRange,
  insertSpeechText,
  useSpeechInput,
  type SpeechInputTarget,
} from "../speech/useSpeechInput";
import {
  SpeechCandidatePopover,
  SpeechReviewLegend,
  SpeechStatusStrip,
  SpeechTranscriptOverlay,
  type ActiveSpan,
  type SpeechTextRange,
} from "../speech/SpeechComposer";
import { attachmentPreviewUrl, AttachmentTooLarge, fileToAttachment, imageFilesFromClipboard } from "./attachments";
import { ComposerControls } from "./ComposerControls";
import type { ComposerDraftInsert } from "./store";

/**
 * What the composer is in the middle of.
 *
 * `sending` is the gap between pressing send and the daemon reporting a turn,
 * which is where an agent process gets started — seconds for a cold CLI. It is
 * deliberately its own state: there is no turn to interrupt yet, so offering
 * stop there would offer something that cannot work, and offering send again
 * only produces the daemon's refusal.
 */
export type ComposerPhase = "idle" | "sending" | "running";

/**
 * Floating input at the bottom of the chat pane.
 *
 * The card has one size. It used to shrink to a single 28px line whenever focus
 * left it and grow back on click, which meant every control under it — the
 * runtime summary, the send button — moved twice per message and was a
 * different size depending on whether the caret happened to be in the field.
 *
 * Enter sends, shift+enter breaks the line. The send control carries the phase:
 * an arrow to send, a spinner nobody can press while the message is on its way,
 * and stop once a turn is really running — one affordance, because the user's
 * intent is never ambiguous. Agent and runtime settings live in one quiet footer
 * summary; its responsive detail panel keeps the richer catalog out of the
 * conversation.
 *
 * Typing `/` opens the agent's own command list, when it has one. Running a
 * command needs nothing special — it goes out as ordinary text — so this is only
 * about discovery, which is the whole problem: a Claude Code install has dozens
 * of commands and skills that are invisible outside its own terminal.
 */
export function Composer({
  phase,
  disabled,
  disabledReason,
  agents,
  agentId,
  modelId,
  modeId,
  effortId,
  runtimeValues,
  agentLocked,
  attachmentsSupported,
  commands,
  restoreDraft,
  insertDraft,
  speech,
  onSend,
  onInterrupt,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
  onPickRuntimeAxis,
  onHeightChange,
  onRestoreDraft,
  onInsertDraft,
  minimized,
  onExpand,
}: {
  phase: ComposerPhase;
  disabled?: boolean;
  /** Why this transcript cannot accept a new turn, when the state is durable. */
  disabledReason?: string;
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId?: string | null;
  runtimeValues?: Record<string, string> | null;
  agentLocked?: boolean;
  /** Whether the current agent forwards attachments anywhere (claude, codex,
   * acp and opencode do today; genet does not — see `docs/roadmap.md`).
   * Pasting an image when this is false is left as a normal, inert text paste
   * rather than silently producing an attachment the agent will never see. */
  attachmentsSupported?: boolean;
  /** The current agent's slash commands, if it named any. */
  commands?: CommandInfo[];
  /** A message coming back for editing after it failed to send. */
  restoreDraft?: { text: string; attachments: Attachment[] } | null;
  /** One line produced outside Chat that should be appended, never sent. */
  insertDraft?: ComposerDraftInsert | null;
  /** Available only when the connected daemon advertises Speech Protocol v2. */
  speech?: SpeechInputTarget;
  onSend(text: string, attachments: Attachment[]): void;
  onInterrupt(): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort?(id: string): void;
  onPickRuntimeAxis?(axisId: string, valueId: string): void;
  /** Reports the complete overlay height in unzoomed layout pixels. */
  onHeightChange?(height: number): void;
  /** Acknowledges that `restoreDraft` has been taken into the field. */
  onRestoreDraft?(): void;
  /** Acknowledges that `insertDraft` has been appended to the field. */
  onInsertDraft?(id: string): void;
  /** Fast-scroll compact bar. The full card comes back on `onExpand`. */
  minimized?: boolean;
  onExpand?(): void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [speechTextRange, setSpeechTextRange] = useState<SpeechTextRange | null>(null);
  const [activeSpeechSpan, setActiveSpeechSpan] = useState<ActiveSpan | null>(null);
  const [composerScrollTop, setComposerScrollTop] = useState(0);
  const commandMenuId = `composer-commands-${useId()}`;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const speechInput = useSpeechInput({
    target: speech,
    getDraft: () => ({
      text: draft,
      selectionStart: textarea.current?.selectionStart ?? draft.length,
      selectionEnd: textarea.current?.selectionEnd ?? draft.length,
    }),
    commit: (snapshot, transcript) => {
      const inserted = insertSpeechText(snapshot, transcript);
      setSpeechTextRange(insertedSpeechRange(snapshot, transcript));
      setDraft(inserted.text);
      queueMicrotask(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    },
  });
  const speechPresentation = useMemo(() => {
    if (speechInput.draftPreview) {
      const inserted = insertSpeechText(
        speechInput.draftPreview.snapshot,
        speechInput.draftPreview.text,
      );
      return {
        text: inserted.text,
        range: insertedSpeechRange(
          speechInput.draftPreview.snapshot,
          speechInput.draftPreview.text,
        ),
        result: null,
      };
    }
    if (speechInput.result && speechTextRange) {
      return { text: draft, range: speechTextRange, result: speechInput.result };
    }
    return null;
  }, [draft, speechInput.draftPreview, speechInput.result, speechTextRange]);
  const visibleDraft = speechPresentation?.text ?? draft;

  // A review normally arrives through `commit`, which sets both together. The
  // fallback also makes a restored/remounted composer recover the final Best-1
  // from the protocol result instead of falling back to the old review panel.
  useEffect(() => {
    if (!speechInput.result || speechTextRange || speechInput.draftPreview) return;
    const transcript = composeSegmentText(
      speechInput.result,
      speechInput.selectedSegmentCandidateIds,
    );
    const snapshot = {
      text: draft,
      selectionStart: textarea.current?.selectionStart ?? draft.length,
      selectionEnd: textarea.current?.selectionEnd ?? draft.length,
    };
    const inserted = insertSpeechText(snapshot, transcript);
    setDraft(inserted.text);
    setSpeechTextRange(insertedSpeechRange(snapshot, transcript));
  }, [draft, speechInput.draftPreview, speechInput.result, speechInput.selectedSegmentCandidateIds, speechTextRange]);

  // Only while the draft *is* one slash token: a command has to lead the message
  // for the agent to treat it as one, so offering the menu mid-sentence would be
  // offering something that does not work.
  const typing = /^\/(\S*)$/.exec(draft)?.[1];
  const matches = useMemo(() => {
    if (typing === undefined || dismissed) return [];
    const needle = typing.toLowerCase();
    return (commands ?? [])
      .filter((command) => command.name.toLowerCase().includes(needle))
      // Names that start with what was typed first: with dozens of commands, a
      // substring match on some description is not what someone typing `/co` means.
      .sort((left, right) => {
        const rank = (name: string) => (name.toLowerCase().startsWith(needle) ? 0 : 1);
        return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name);
      })
      .slice(0, 8);
  }, [commands, typing, dismissed]);
  const open = focused && matches.length > 0 && !settingsOpen;
  const chosen = matches[Math.min(highlighted, matches.length - 1)];

  const complete = (command: CommandInfo) => {
    // A trailing space, so an argument can be typed straight away — and so the
    // menu closes, the draft no longer being a bare slash token.
    setDraft(`/${command.name} `);
    setHighlighted(0);
  };

  const send = () => {
    // The button is gone outside `idle`, but the textarea's Enter is not: it
    // used to reach the daemon mid-turn and come back as "a turn is already
    // running in this session", which describes our own key handler rather than
    // anything the reader did wrong.
    if (phase !== "idle" || disabled || speechInput.busy) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    speechInput.dismissReview();
    setSpeechTextRange(null);
    setActiveSpeechSpan(null);
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    onSend(text, attachments);
  };

  // A message that failed comes back whole, text and attachments together, so
  // it can be edited rather than retyped.
  useEffect(() => {
    if (!restoreDraft) return;
    setSpeechTextRange(null);
    setActiveSpeechSpan(null);
    setDraft(restoreDraft.text);
    setAttachments(restoreDraft.attachments);
    onRestoreDraft?.();
    textarea.current?.focus();
  }, [restoreDraft, onRestoreDraft]);

  useEffect(() => {
    if (!insertDraft) return;
    setDraft((current) => appendDraftLine(current, insertDraft.text));
    onInsertDraft?.(insertDraft.id);
  }, [insertDraft, onInsertDraft]);

  useEffect(() => {
    if (!speechInput.result) setActiveSpeechSpan(null);
  }, [speechInput.result]);

  const addFiles = async (files: File[]) => {
    if (!attachmentsSupported) {
      setPasteNotice("当前 Agent 还不支持附件");
      return;
    }
    try {
      const added = await Promise.all(files.map(fileToAttachment));
      setAttachments((current) => [...current, ...added]);
      setPasteNotice(null);
    } catch (error) {
      setPasteNotice(error instanceof AttachmentTooLarge ? error.message : "读取文件失败");
    }
  };

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    resizeComposerTextarea(element);
    if (speechPresentation) {
      element.scrollTop = element.scrollHeight;
      setComposerScrollTop(element.scrollTop);
    }
    // `minimized` is in here because the field is unmounted while tucked away:
    // it comes back at its one-line default, and the draft it comes back with
    // has not changed, so nothing else would ask it to grow again.
  }, [speechPresentation, visibleDraft, minimized]);

  useEffect(() => {
    if (!minimized) return;
    if (focused || speechInput.phase === "recording") onExpand?.();
  }, [minimized, focused, speechInput.phase, onExpand]);

  useLayoutEffect(() => {
    const update = () => {
      if (textarea.current) resizeComposerTextarea(textarea.current);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useLayoutEffect(() => {
    const element = shell.current;
    if (!element || !onHeightChange) return;
    // `offsetHeight` and the padding that consumes this value are both layout
    // pixels. A visual `getBoundingClientRect()` height already contains the
    // document's UI `zoom`, so feeding it back into a declaration inside that
    // same zoomed document scales it twice.
    const update = () => onHeightChange(element.offsetHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [minimized, onHeightChange]);

  return (
    <div
      ref={shell}
      data-composer-shell=""
      // The transparent shell overlays the full-height transcript. Only its
      // interactive children catch taps; TimelineView reserves this measured
      // height at the end of its scroll *content*, not from its viewport.
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pt-2 md:px-4"
      style={{
        // Sit on the window edge. Lift only for the on-screen keyboard
        // (`shell/viewport.ts`: the shell is covered, not shrunk) and a real
        // home-indicator inset. A minimum 0.75rem here left a half-line gap
        // on every screen that has no safe area.
        paddingBottom:
          "calc(var(--keyboard, 0px) + env(safe-area-inset-bottom, 0px))",
      }}
    >
      {minimized ? (
        <button
          type="button"
          aria-expanded={false}
          aria-label="展开输入框"
          data-composer-minimized=""
          className="pointer-events-auto mx-auto flex w-full max-w-chat items-center gap-2 rounded-2xl border border-line-strong bg-surface/95 px-4 py-2.5 text-left shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur"
          onClick={() => onExpand?.()}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-muted">
            {draft.trim() || "描述任务…"}
          </span>
          <span className="shrink-0 text-faint" aria-hidden>
            ▴
          </span>
        </button>
      ) : null}
      {!minimized && open ? (
        <div className="pointer-events-auto mx-auto mb-2 max-w-chat overflow-hidden rounded-xl border border-line-strong bg-surface/95 shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur">
          <ul id={commandMenuId} role="listbox" aria-label="命令">
            {matches.map((command, index) => (
              <li key={command.name}>
                <button
                  id={`${commandMenuId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={command === chosen}
                  onMouseEnter={() => setHighlighted(index)}
                  // The textarea keeps focus: losing it here would close the
                  // menu before the click ever landed.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => complete(command)}
                  className={`flex min-h-11 w-full items-baseline gap-2 px-3 py-2.5 text-left text-sm md:min-h-0 md:py-2 md:text-xs ${
                    command === chosen ? "bg-raised" : ""
                  }`}
                >
                  <span className="shrink-0 font-mono text-fg">/{command.name}</span>
                  {command.argumentHint ? (
                    <span className="shrink-0 font-mono text-faint">{command.argumentHint}</span>
                  ) : null}
                  {command.description ? (
                    <span className="truncate text-muted">{command.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!minimized && disabledReason ? (
        <p className="pointer-events-auto mx-auto mb-2 max-w-chat rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs text-muted shadow backdrop-blur">
          {disabledReason}
        </p>
      ) : null}
      {!minimized ? (
      <div
        data-composer-card=""
        className={`pointer-events-auto mx-auto max-w-chat rounded-2xl border bg-surface/95 shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur transition-colors ${
          focused ? "border-muted/50" : "border-line-strong"
        }`}
      >
        {attachments.length > 0 ? (
          <div
            className="flex flex-nowrap gap-2 overflow-x-auto px-4 pt-3"
            aria-label="待发送的文件"
          >
            {attachments.map((attachment, index) => (
              <div key={index} className="group relative h-14 w-14 shrink-0">
                <img
                  src={attachmentPreviewUrl(attachment)}
                  alt={attachment.name}
                  className="h-full w-full rounded-lg border border-line object-cover"
                />
                <button
                  type="button"
                  aria-label={`移除 ${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-sm text-muted shadow group-hover:text-fg md:-right-1.5 md:-top-1.5 md:h-5 md:w-5 md:text-xs"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <SpeechStatusStrip
          phase={speechInput.phase}
          notice={speechInput.notice}
          waveform={speechInput.waveform}
          elapsedMs={speechInput.elapsedMs}
          localAudioOnly={speechInput.localAudioOnly}
          problem={speechInput.problem}
          onOpenLogs={speech?.onOpenLogs}
          onReportProblem={speech?.onReportProblem}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-1 px-1.5 py-1 md:py-0.5">
          <div
            data-composer-slot="input"
            className="relative col-span-2 col-start-1 row-start-1 min-w-0"
          >
            <div className="relative">
              <textarea
                ref={textarea}
                className={`relative z-[1] block w-full resize-none overflow-y-hidden bg-transparent px-3 py-1.5 text-base leading-9 outline-none placeholder:text-faint focus-visible:outline-transparent md:py-1 md:text-sm md:leading-6 ${
                  speechPresentation ? "text-transparent caret-accent-bright" : "text-fg"
                }`}
                placeholder="描述任务…"
                aria-label="任务描述"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={open ? commandMenuId : undefined}
                aria-activedescendant={
                  open
                    ? `${commandMenuId}-${Math.min(highlighted, matches.length - 1)}`
                    : undefined
                }
                value={visibleDraft}
                disabled={disabled || speechInput.busy}
                rows={1}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(event) => {
                  if (speechInput.phase === "review") {
                    speechInput.dismissReview();
                    setSpeechTextRange(null);
                    setActiveSpeechSpan(null);
                  }
                  setDraft(event.target.value);
                  setHighlighted(0);
                  setDismissed(false);
                }}
                onScroll={(event) => setComposerScrollTop(event.currentTarget.scrollTop)}
                onPaste={(event) => {
                  const files = imageFilesFromClipboard(event.clipboardData);
                  if (files.length === 0) return;
                  // Pasting an image alongside plain text is possible in principle,
                  // but the composer is a single textarea: no cursor position to
                  // insert a thumbnail at. Only the image is kept, same as most
                  // chat apps' composers when a screenshot lands in an empty draft.
                  event.preventDefault();
                  void addFiles(files);
                }}
                onKeyDown={(event) => {
                  if (open) {
                    // While the menu is up it owns these keys. Enter in particular:
                    // sending `/co` because the menu was showing `/code-review` would
                    // be the one outcome nobody wanted.
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
                      setHighlighted((current) => (current + step) % matches.length);
                      return;
                    }
                    if ((event.key === "Enter" || event.key === "Tab") && chosen) {
                      event.preventDefault();
                      complete(chosen);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDismissed(true);
                      return;
                    }
                  }
                  if (event.key === "Escape" && speechInput.busy) {
                    event.preventDefault();
                    void speechInput.cancel();
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              {speechPresentation ? (
                <SpeechTranscriptOverlay
                  text={speechPresentation.text}
                  range={speechPresentation.range}
                  result={speechPresentation.result}
                  selectedSegmentCandidateIds={speechInput.selectedSegmentCandidateIds}
                  scrollTop={composerScrollTop}
                  onOpenSpan={setActiveSpeechSpan}
                />
              ) : null}
            </div>
            {pasteNotice ? (
              <p
                data-composer-slot="notice"
                className="px-3 py-1 text-xs text-muted"
                role="alert"
              >
                {pasteNotice}
              </p>
            ) : null}
            {speechInput.context ? (
              <details className="mx-3 mb-1 text-xs text-faint">
                <summary className="cursor-pointer select-none hover:text-muted">
                  本次 Qwen3 上下文：{speechInput.context.terms.length} 个术语 · {speechInput.context.prompt.length} 字 prompt
                </summary>
                <div className="mt-1 max-h-32 overflow-y-auto rounded border border-line bg-bg/80 p-2">
                  {speechInput.context.languageHints.length > 0 ? (
                    <p>语言：{speechInput.context.languageHints.join("、")}</p>
                  ) : (
                    <p>语言：自动识别</p>
                  )}
                  {speechInput.context.terms.length > 0 ? (
                    <p className="mt-1 break-words">
                      术语：{speechInput.context.terms.map((term) => term.text).join("、")}
                    </p>
                  ) : null}
                  {speechInput.context.prompt ? (
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-faint">
                      {speechInput.context.prompt}
                    </pre>
                  ) : null}
                  {speechInput.context.omitted.pinnedTerms > 0 ||
                  speechInput.context.omitted.automaticTerms > 0 ||
                  speechInput.context.omitted.messages > 0 ? (
                    <p className="mt-1 text-muted">
                      因预算省略：固定词 {speechInput.context.omitted.pinnedTerms}、自动词 {speechInput.context.omitted.automaticTerms}、消息 {speechInput.context.omitted.messages}
                    </p>
                  ) : null}
                </div>
              </details>
            ) : null}
            {speechInput.result?.segments?.length ? <SpeechReviewLegend /> : null}
            {speechInput.result && !speechInput.result.segments?.length ? (
              <details className="mx-3 mb-1 text-xs text-faint">
                <summary className="cursor-pointer select-none hover:text-muted">
                  查看整句 N-best（{speechInput.result.candidates.length} 个）
                </summary>
                <div className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto rounded border border-line bg-bg/80 p-1.5">
                  {[...speechInput.result.candidates]
                    .sort((left, right) => left.rank - right.rank)
                    .map((candidate) => {
                      const selected = speechInput.selectedCandidateId === candidate.candidateId;
                      return (
                        <button
                          key={candidate.candidateId}
                          type="button"
                          data-diagnostic-text="speech-candidate"
                          aria-pressed={selected}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void speechInput.selectCandidate(candidate)}
                          className={`rounded-lg px-2 py-1.5 text-left ${selected ? "bg-raised text-fg" : "text-muted hover:bg-raised/60"}`}
                        >
                          #{candidate.rank} {candidate.text}
                        </button>
                      );
                    })}
                </div>
              </details>
            ) : null}
          </div>
          <div
            data-composer-slot="runtime"
            className="col-start-1 row-start-2 flex h-9 min-w-0 items-center md:h-6"
          >
            <ComposerControls
              agents={agents}
              agentId={agentId}
              modelId={modelId}
              modeId={modeId}
              effortId={effortId ?? null}
              runtimeValues={runtimeValues}
              disabled={disabled || phase !== "idle"}
              agentLocked={agentLocked}
              onOpenChange={setSettingsOpen}
              onPickAgent={onPickAgent}
              onPickModel={onPickModel}
              onPickMode={onPickMode}
              onPickEffort={onPickEffort ?? (() => {})}
              onPickRuntimeAxis={onPickRuntimeAxis ?? (() => {})}
            />
          </div>
          <div
            data-composer-slot="actions"
            className="col-start-2 row-start-2 flex h-9 flex-nowrap items-center gap-1 self-center md:h-6"
          >
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              tabIndex={-1}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length > 0) void addFiles(files);
              }}
            />
            {speech ? (
              speechInput.phase === "recording" ? (
                <button
                  type="button"
                  aria-label="停止听写"
                  title="停止并转成文字"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void speechInput.stop()}
                  className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full bg-danger text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 md:h-6 md:w-6"
                >
                  <Square className="h-5 w-5 fill-current md:h-3 md:w-3" aria-hidden />
                </button>
              ) : speechInput.phase === "preparing" || speechInput.phase === "finishing" ? (
                <button
                  type="button"
                  aria-label={speechInput.phase === "preparing" ? "正在准备听写" : "正在生成文字"}
                  aria-busy="true"
                  aria-disabled="true"
                  onMouseDown={(event) => event.preventDefault()}
                  className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 cursor-default items-center justify-center rounded-full bg-accent/40 text-white md:h-6 md:w-6"
                >
                  <Loader2 className="h-5 w-5 animate-spin md:h-3 md:w-3" aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="语音输入"
                  title="语音转文字"
                  disabled={disabled || phase !== "idle"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setDismissed(true);
                    void speechInput.start();
                  }}
                  className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 md:h-6 md:w-6"
                >
                  <Mic className="h-6 w-6 md:h-4 md:w-4" aria-hidden />
                </button>
              )
            ) : null}
            {speech && speechInput.busy ? (
              <button
                type="button"
                aria-label="取消听写"
                title="取消并保留原草稿"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void speechInput.cancel()}
                className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-danger focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 md:h-6 md:w-6"
              >
                <X className="h-5 w-5 md:h-3.5 md:w-3.5" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={
                attachmentsSupported
                  ? "添加文件（当前仅支持图片）"
                  : "添加文件（当前 Agent 不支持附件）"
              }
              title={attachmentsSupported ? "添加文件（当前仅支持图片）" : "当前 Agent 不支持附件"}
              disabled={disabled || phase !== "idle" || speechInput.busy || !attachmentsSupported}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDismissed(true);
                picker.current?.click();
              }}
              className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 md:h-6 md:w-6"
            >
              <Paperclip className="h-6 w-6 md:h-4 md:w-4" aria-hidden />
            </button>
            {phase === "sending" ? (
              // Still a button, and still focusable: `disabled` would throw the
              // focus of whoever just clicked it back to the document. It is
              // `aria-disabled` with nothing behind the click instead, so the
              // wait is unmistakably not interactive without moving anyone's
              // place in the page.
              <button
                type="button"
                aria-label="发送中"
                aria-disabled="true"
                aria-busy="true"
                onMouseDown={(event) => event.preventDefault()}
                className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 cursor-default items-center justify-center rounded-full bg-accent/40 text-white md:h-6 md:w-6"
              >
                <Loader2 className="h-6 w-6 animate-spin md:h-4 md:w-4" aria-hidden />
              </button>
            ) : phase === "running" ? (
              <button
                type="button"
                aria-label="停止"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onInterrupt}
                className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full border border-line text-muted hover:border-danger hover:text-danger focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 md:h-6 md:w-6"
              >
                <span className="h-[18px] w-[18px] rounded-[3px] bg-current md:h-3 md:w-3 md:rounded-[2px]" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => send()}
                disabled={disabled || speechInput.busy || (draft.trim().length === 0 && attachments.length === 0)}
                className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full bg-accent text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 md:h-6 md:w-6"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-6 w-6 md:h-4 md:w-4"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M8 3.2 3.6 7.6l1.1 1.1L7.2 6.2V13h1.6V6.2l2.5 2.5 1.1-1.1L8 3.2Z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      ) : null}
      {!minimized ? (
      <SpeechCandidatePopover
        active={activeSpeechSpan}
        selectedCandidateId={
          activeSpeechSpan
            ? speechInput.selectedSegmentCandidateIds[activeSpeechSpan.segment.segmentId] ??
              activeSpeechSpan.segment.defaultCandidateId
            : null
        }
        controller={speechInput}
        onClose={() => setActiveSpeechSpan(null)}
      />
      ) : null}
    </div>
  );
}

/** One line of text plus half of the next, so the field reads as "more room is
 * here" without reserving three empty lines of the transcript before anyone has
 * typed anything. Phone lines are 36px and desktop lines 24px; the padding
 * (`py-1.5` / `md:py-1`) is inside these numbers because `scrollHeight` is. */
export const COMPOSER_TEXTAREA_PHONE_MIN_HEIGHT = 66;
export const COMPOSER_TEXTAREA_PHONE_MAX_HEIGHT = 192;
export const COMPOSER_TEXTAREA_DESKTOP_MIN_HEIGHT = 44;
export const COMPOSER_TEXTAREA_DESKTOP_MAX_HEIGHT = 176;
export const COMPOSER_DESKTOP_BREAKPOINT = 768;

export function appendDraftLine(current: string, line: string): string {
  if (!current) return line;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${line}`;
}

/** Grows with the draft from one and a half lines up to roughly five phone
 * lines or seven desktop lines, then scrolls internally. There is no smaller
 * size to fall back to: the card does not collapse. */
export function resizeComposerTextarea(
  element: HTMLTextAreaElement,
  desktop = isDesktopComposerViewport(),
): number {
  const minHeight = desktop
    ? COMPOSER_TEXTAREA_DESKTOP_MIN_HEIGHT
    : COMPOSER_TEXTAREA_PHONE_MIN_HEIGHT;
  const maxHeight = desktop
    ? COMPOSER_TEXTAREA_DESKTOP_MAX_HEIGHT
    : COMPOSER_TEXTAREA_PHONE_MAX_HEIGHT;
  element.style.height = "auto";
  const contentHeight = element.scrollHeight || minHeight;
  const height = Math.min(maxHeight, Math.max(minHeight, contentHeight));
  element.style.height = `${height}px`;
  element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  return height;
}

function isDesktopComposerViewport(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(`(min-width: ${COMPOSER_DESKTOP_BREAKPOINT}px)`).matches;
  }
  return window.innerWidth >= COMPOSER_DESKTOP_BREAKPOINT;
}

import type { AgentInfo, Attachment, CommandInfo, SessionDraft, SessionStatus } from "@genehub/proto";
import { BookmarkPlus, Check, Loader2, Mic, Paperclip, Square, X } from "lucide-react";
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
import { attachmentPreviewUrl, fileToAttachment, imageFilesFromClipboard } from "./attachments";
import { readLocalDraft, saveLocalDraft } from "./localConversation";
import { ComposerControls } from "./ComposerControls";
import type { ComposerDraftInsert, ForwardDraft } from "./store";

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

function sessionBusy(status: SessionStatus | null | undefined): boolean {
  return status === "running" || status === "waiting";
}

/**
 * The send control's phase from timeline plus the session list.
 *
 * The echo of our own message clears `pending` (so the bubble is not drawn
 * twice) before `turnStarted` lands. Using only `pending` then puts Send back
 * on a turn that has already left the composer. The session row already knows
 * the durable status, so a tab switch onto a running/waiting chat can show
 * Stop before the snapshot arrives.
 */
/**
 * How long a running turn has been quiet, once that is worth saying.
 *
 * Below the threshold this is nothing: agents pause to think, and a counter
 * that starts at one second would make every ordinary turn look troubled. Past
 * it, the number is the whole point — "又卡住了" was filed against a turn that
 * had been running for six minutes and forty-nine seconds and was fine.
 */
export function quietFor(lastActivityAtMs: number | null | undefined, nowMs: number): string | null {
  if (!lastActivityAtMs) return null;
  const seconds = Math.floor((nowMs - lastActivityAtMs) / 1000);
  if (seconds < QUIET_AFTER_SECONDS) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `已静默 ${seconds} 秒`;
  const rest = seconds % 60;
  return rest === 0 ? `已静默 ${minutes} 分` : `已静默 ${minutes} 分 ${rest} 秒`;
}

/** Long enough that an ordinary pause to think never reaches it. */
const QUIET_AFTER_SECONDS = 60;

export function resolveComposerPhase({
  pending,
  timelineStatus,
  activeTurn,
  sessionStatus,
}: {
  pending: { error: string | null } | null | undefined;
  timelineStatus: SessionStatus;
  activeTurn: string | null;
  sessionStatus?: SessionStatus | null;
}): ComposerPhase {
  const busy = sessionBusy(timelineStatus) || sessionBusy(sessionStatus);
  if (pending && !pending.error && !activeTurn && !busy) return "sending";
  if (busy) return "running";
  return "idle";
}

/** Phone: the card reaches the window edge. Safe-area padding is inside that
 * opaque surface so a transcript row cannot show through underneath. */
const COMPOSER_PHONE_DOCK =
  "max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:bg-surface max-md:pb-[env(safe-area-inset-bottom,0px)] max-md:shadow-[0_-6px_20px_rgb(0_0_0_/0.28)] max-md:backdrop-blur-none";

/**
 * Floating input at the bottom of the chat pane.
 *
 * On a phone it docks: the card's own background reaches the window edge and
 * the home-indicator inset is padding *inside* that surface, so a transcript
 * row cannot show through underneath. Desktop keeps the floating rounded card.
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
  layout = "overlay",
  persistenceKey,
  phase,
  durableInput = false,
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
  inputModalities,
  commands,
  restoreDraft,
  insertDraft,
  forwardDraft,
  drafts,
  speech,
  lastActivityAtMs,
  onSend,
  onSaveDraft,
  onReplaceDrafts,
  onUpdateDraft,
  onInterrupt,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
  onPickRuntimeAxis,
  onRefreshAgents,
  onHeightChange,
  onRestoreDraft,
  onInsertDraft,
  onClearForwardDraft,
  minimized,
  onExpand,
}: {
  /** Overview reserves space; existing timelines retain their overlay contract. */
  layout?: "overlay" | "inline";
  persistenceKey?: string;
  phase: ComposerPhase;
  durableInput?: boolean;
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
  /** Whether the current agent accepts attachments at all. */
  attachmentsSupported?: boolean;
  /** Exact model media inputs; absent for external Agents with image support. */
  inputModalities?: string[];
  /** The current agent's slash commands, if it named any. */
  commands?: CommandInfo[];
  /** A message coming back for editing after it failed to send. */
  restoreDraft?: { text: string; attachments: Attachment[]; videoFiles?: File[] } | null;
  /** One line produced outside Chat that should be appended, never sent. */
  insertDraft?: ComposerDraftInsert | null;
  /** A forward capsule parked here, sent ahead of the user's own text. */
  forwardDraft?: ForwardDraft | null;
  drafts?: SessionDraft[];
  /** Available only when the connected daemon advertises Speech Protocol v2. */
  speech?: SpeechInputTarget;
  /**
   * When the running turn last produced anything, if a turn is running.
   *
   * A quiet turn is not a dead turn, and nothing here treats it as one. It is
   * shown because the person waiting is the only one who can tell whether this
   * much silence is normal for what they asked — and every "又卡住了" report we
   * have is someone who had no way to tell.
   */
  lastActivityAtMs?: number | null;
  onSend(text: string, attachments: Attachment[], videoFiles?: File[]): void | Promise<void>;
  onSaveDraft?(text: string, attachments: Attachment[], videoFiles?: File[]): Promise<boolean>;
  onReplaceDrafts?(drafts: SessionDraft[]): Promise<boolean>;
  onUpdateDraft?(draft: SessionDraft, videoFiles?: File[]): Promise<boolean>;
  onInterrupt(): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort?(id: string): void;
  onPickRuntimeAxis?(axisId: string, valueId: string): void;
  onRefreshAgents?(): void;
  /** Reports the complete overlay height in unzoomed layout pixels. */
  onHeightChange?(height: number): void;
  /** Acknowledges that `restoreDraft` has been taken into the field. */
  onRestoreDraft?(): void;
  /** Acknowledges that `insertDraft` has been appended to the field. */
  onInsertDraft?(id: string): void;
  /** Removes the parked forward capsule without sending it. */
  onClearForwardDraft?(): void;
  /** Fast-scroll compact bar. The full card comes back on `onExpand`. */
  minimized?: boolean;
  onExpand?(): void;
}) {
  const [saved] = useState(() => persistenceKey ? readLocalDraft(persistenceKey) : { text: "", attachments: [], missingAttachments: 0 });
  const [draft, setDraft] = useState(saved.text);
  const [missingAttachments, setMissingAttachments] = useState(saved.missingAttachments);
  // Only while a turn is running, and only every few seconds: the number this
  // feeds is read in minutes, and a per-second timer on the composer would cost
  // more than the precision is worth.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const watchingQuiet = phase === "running" && Boolean(lastActivityAtMs);
  useEffect(() => {
    if (!watchingQuiet) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [watchingQuiet]);
  const quiet = watchingQuiet ? quietFor(lastActivityAtMs, nowMs) : null;
  const [attachments, setAttachments] = useState<Attachment[]>(saved.attachments);
  const [videoFiles, setVideoFiles] = useState<File[]>([]);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(() => new Set());
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const draftPicker = useRef<HTMLInputElement>(null);
  const activeDraftFile = useRef<string | null>(null);
  const imageAllowed = Boolean(attachmentsSupported && (inputModalities?.includes("image") ?? true));
  const videoAllowed = Boolean(attachmentsSupported && inputModalities?.includes("video"));
  const fileActionLabel = !attachmentsSupported
    ? "添加文件（当前 Agent 不支持附件）"
    : imageAllowed && videoAllowed
      ? "添加图片或视频"
      : imageAllowed
        ? "添加文件（当前仅支持图片）"
        : videoAllowed
          ? "添加视频"
          : "添加文件（当前模型不支持媒体输入）";
  useEffect(() => {
    if (persistenceKey) saveLocalDraft(persistenceKey, { text: draft, attachments, missingAttachments });
  }, [persistenceKey, draft, attachments, missingAttachments]);
  const [pasteNotice, setPasteNotice] = useState<string | null>(saved.missingAttachments ? `${saved.missingAttachments} 个附件未能恢复，请重新选择后发送。` : ("recoveryNotice" in saved ? saved.recoveryNotice ?? null : null));
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

  const send = async () => {
    // The button is gone outside `idle`, but the textarea's Enter is not: it
    // used to reach the daemon mid-turn and come back as "a turn is already
    // running in this session", which describes our own key handler rather than
    // anything the reader did wrong.
    if (phase === "sending" || (!durableInput && phase !== "idle") || disabled || speechInput.busy) return;
    const text = draft.trim();
    const selectedDrafts = (drafts ?? []).filter((item) => selectedDraftIds.has(item.id));
    if (!text && attachments.length === 0 && videoFiles.length === 0 && !forwardDraft && selectedDrafts.length === 0) return;
    // The parked capsule travels ahead of the user's own words, inside the
    // same message, so the receiver sees history first and the ask second.
    const currentPayload = forwardDraft
      ? text
        ? `${forwardDraft.capsule}\n\n${text}`
        : forwardDraft.capsule
      : text;
    const payload = [...selectedDrafts.map((item) => item.text), currentPayload].filter(Boolean).join("\n\n");
    const outgoing = [...selectedDrafts.flatMap((item) => item.attachments), ...(forwardDraft?.attachments ?? []), ...attachments];
    speechInput.dismissReview();
    setSpeechTextRange(null);
    setActiveSpeechSpan(null);
    setDraft("");
    setAttachments([]);
    setVideoFiles([]);
    setMissingAttachments(0);
    if (persistenceKey) saveLocalDraft(persistenceKey, { text: "", attachments: [], missingAttachments: 0 });
    setDismissed(false);
    try {
      if (videoFiles.length > 0) await onSend(payload, outgoing, videoFiles);
      else await onSend(payload, outgoing);
    } catch {
      // The owning store has already restored/reporting the live input. Saved
      // draft cards stay intact until admission is confirmed.
      return;
    }
    if (selectedDrafts.length > 0) {
      await onReplaceDrafts?.((drafts ?? []).filter((item) => !selectedDraftIds.has(item.id)));
      setSelectedDraftIds(new Set());
    }
    if (forwardDraft) onClearForwardDraft?.();
  };

  const saveDraft = async () => {
    if (!onSaveDraft) return;
    const saved = await onSaveDraft(draft.trim(), attachments, videoFiles);
    if (!saved) return;
    setDraft("");
    setAttachments([]);
    setVideoFiles([]);
    setMissingAttachments(0);
    if (persistenceKey) saveLocalDraft(persistenceKey, { text: "", attachments: [], missingAttachments: 0 });
  };

  // A message that failed comes back whole, text and attachments together, so
  // it can be edited rather than retyped.
  useEffect(() => {
    if (!restoreDraft) return;
    setSpeechTextRange(null);
    setActiveSpeechSpan(null);
    setDraft(restoreDraft.text);
    setAttachments(restoreDraft.attachments);
    setVideoFiles(restoreDraft.videoFiles ?? []);
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
      const images = files.filter((file) => file.type.startsWith("image/"));
      const videos = files.filter((file) => file.type.startsWith("video/"));
      if (images.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))) {
        throw new Error("图片仅支持 PNG、JPEG、WebP 或 GIF");
      }
      if (videos.some((file) => !["video/mp4", "video/webm", "video/quicktime", "video/mpeg", "video/x-msvideo"].includes(file.type))) {
        throw new Error("视频格式当前不支持");
      }
      if (images.length > 0 && !imageAllowed) throw new Error("当前模型不支持图片输入");
      if (videos.length > 0 && !videoAllowed) throw new Error("当前模型不支持视频输入");
      if (images.length + videos.length !== files.length) throw new Error("只支持图片和视频文件");
      if (videos.some((file) => file.size > 64 * 1024 * 1024)) throw new Error("视频超过 64MB");
      const added = await Promise.all(images.map(fileToAttachment));
      setAttachments((current) => [...current, ...added]);
      setVideoFiles((current) => [...current, ...videos]);
      setPasteNotice(null);
    } catch (error) {
      setPasteNotice(error instanceof Error ? error.message : "读取文件失败");
    }
  };

  const addDraftFiles = async (draftId: string, files: File[]) => {
    const item = (drafts ?? []).find((candidate) => candidate.id === draftId);
    if (!item || !onUpdateDraft) return;
    try {
      const images = files.filter((file) => file.type.startsWith("image/"));
      const videos = files.filter((file) => file.type.startsWith("video/"));
      if (images.length + videos.length !== files.length) throw new Error("只支持图片和视频文件");
      if (images.length > 0 && !imageAllowed) throw new Error("当前模型不支持图片输入");
      if (videos.length > 0 && !videoAllowed) throw new Error("当前模型不支持视频输入");
      const added = await Promise.all(images.map(fileToAttachment));
      await onUpdateDraft({ ...item, attachments: [...item.attachments, ...added] }, videos);
      setPasteNotice(null);
    } catch (error) {
      setPasteNotice(error instanceof Error ? error.message : "读取文件失败");
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
      className={`pointer-events-none ${layout === "inline" ? "relative shrink-0" : "absolute inset-x-0 bottom-0"} z-10 px-3 pt-2 md:px-4 max-md:px-0`}
      style={{
        // Lift only for the on-screen keyboard (`shell/viewport.ts`: the
        // remaining overlap after any viewport resize). The home-indicator inset lives
        // *inside* the card so the opaque surface reaches the window edge
        // on a phone; putting it on this transparent shell left a strip of
        // transcript showing under the rounded card.
        paddingBottom: "var(--keyboard, 0px)",
      }}
    >
      {minimized ? (
        <button
          type="button"
          aria-expanded={false}
          aria-label="展开输入框"
          data-composer-minimized=""
          className={`pointer-events-auto mx-auto flex w-full max-w-chat items-center gap-2 rounded-2xl border border-line-strong bg-surface/95 px-4 py-2.5 text-left shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur ${COMPOSER_PHONE_DOCK}`}
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
        className={`pointer-events-auto mx-auto max-w-chat rounded-2xl border bg-surface/95 shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur transition-colors ${COMPOSER_PHONE_DOCK} ${
          focused ? "border-muted/50" : "border-line-strong"
        }`}
      >
        {(drafts?.length ?? 0) > 0 ? (
          <div className="space-y-1 px-4 pt-3" data-testid="session-drafts">
            {drafts!.map((item) => {
              const expanded = expandedDraftId === item.id;
              const firstLine = item.text.split(/\r?\n/, 1)[0]?.trim() || item.attachments[0]?.name || "附件";
              return (
                <div key={item.id} className="rounded-xl border border-line bg-raised/40">
                  <div className="flex min-h-9 items-center gap-2 px-2.5">
                    <input
                      type="checkbox"
                      aria-label={`选择草稿 ${firstLine}`}
                      checked={selectedDraftIds.has(item.id)}
                      onChange={() => setSelectedDraftIds((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                        return next;
                      })}
                      className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                    />
                    <button
                      type="button"
                      aria-expanded={expanded}
                      className="min-w-0 flex-1 truncate py-2 text-left text-xs text-muted hover:text-fg"
                      onClick={() => setExpandedDraftId(expanded ? null : item.id)}
                    >
                      {item.forward ? <span aria-hidden className="mr-1.5">↪</span> : null}
                      {firstLine}
                      {item.attachments.length > 0 ? <span className="ml-1.5 text-faint">· {item.attachments.length} 个附件</span> : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`移除草稿 ${firstLine}`}
                      className="shrink-0 px-1.5 py-1 text-xs text-muted hover:text-fg"
                      onClick={() => void onReplaceDrafts?.(drafts!.filter((candidate) => candidate.id !== item.id))}
                    >移除</button>
                  </div>
                  {expanded ? (
                    <div className="border-t border-line px-2.5 pb-2 pt-2">
                      <textarea
                        aria-label={`编辑草稿 ${firstLine}`}
                        defaultValue={item.text}
                        rows={3}
                        className="w-full resize-none bg-transparent text-sm text-fg outline-none"
                        onBlur={(event) => {
                          const text = event.currentTarget.value.trim();
                          if (text && text !== item.text) void onUpdateDraft?.({ ...item, text });
                        }}
                      />
                      <div className="flex items-center gap-2">
                        {item.attachments.map((attachment, index) => (
                          <span key={`${attachment.name}-${index}`} className="inline-flex max-w-32 items-center gap-1 rounded-md bg-surface px-2 py-1 text-[10px] text-muted">
                            <span className="truncate">{attachment.name}</span>
                            <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => void onUpdateDraft?.({ ...item, attachments: item.attachments.filter((_, i) => i !== index) })}>×</button>
                          </span>
                        ))}
                        <button
                          type="button"
                          aria-label="给草稿添加图片或视频"
                          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg"
                          onClick={() => { activeDraftFile.current = item.id; draftPicker.current?.click(); }}
                        ><Paperclip className="h-4 w-4" aria-hidden /></button>
                        <button type="button" aria-label="完成编辑草稿" className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg" onClick={() => setExpandedDraftId(null)}><Check className="h-4 w-4" aria-hidden /></button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {forwardDraft ? (
          <div className="px-4 pt-3" data-testid="forward-draft">
            <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/50 px-3 py-2">
              <span aria-hidden className="text-muted">
                ↪
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                转发自 {forwardDraft.sourceTitle ?? forwardDraft.sourceSessionId} ·{" "}
                {forwardDraft.itemCount} 条 · 约{" "}
                {forwardDraft.estimatedTokens >= 1000
                  ? `${(forwardDraft.estimatedTokens / 1000).toFixed(1)}k`
                  : forwardDraft.estimatedTokens}{" "}
                tokens
                {forwardDraft.attachments && forwardDraft.attachments.length > 0
                  ? ` · ${forwardDraft.attachments.length} 张图`
                  : ""}
              </span>
              <button
                type="button"
                aria-label="移除转发的会话历史"
                className="shrink-0 rounded-full px-2 py-0.5 text-xs text-muted hover:bg-surface hover:text-fg"
                onClick={() => onClearForwardDraft?.()}
              >
                移除
              </button>
            </div>
          </div>
        ) : null}
        {attachments.length > 0 || videoFiles.length > 0 ? (
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
            {videoFiles.map((file, index) => (
              <div key={`video-${index}`} className="group relative flex h-14 max-w-40 shrink-0 items-center rounded-lg border border-line px-2 text-xs">
                <span className="truncate" title={file.name}>视频 · {file.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => setVideoFiles((current) => current.filter((_, i) => i !== index))}
                  className="ml-2 text-muted hover:text-fg"
                >×</button>
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
              onRefreshAgents={onRefreshAgents}
            />
          </div>
          <div
            data-composer-slot="actions"
            className="col-start-2 row-start-2 flex h-9 flex-nowrap items-center gap-1 self-center md:h-6"
          >
            <input
              ref={picker}
              type="file"
              accept={videoAllowed ? (imageAllowed ? "image/*,video/mp4,video/webm,video/quicktime,video/mpeg,video/x-msvideo" : "video/mp4,video/webm,video/quicktime,video/mpeg,video/x-msvideo") : "image/*"}
              multiple
              tabIndex={-1}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length > 0) void addFiles(files);
              }}
            />
            <input
              ref={draftPicker}
              type="file"
              accept={videoAllowed ? (imageAllowed ? "image/*,video/mp4,video/webm,video/quicktime,video/mpeg,video/x-msvideo" : "video/mp4,video/webm,video/quicktime,video/mpeg,video/x-msvideo") : "image/*"}
              multiple
              tabIndex={-1}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                const draftId = activeDraftFile.current;
                event.currentTarget.value = "";
                if (draftId && files.length > 0) void addDraftFiles(draftId, files);
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
                  disabled={disabled || (!durableInput && phase !== "idle")}
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
              aria-label={fileActionLabel}
              title={fileActionLabel}
              disabled={disabled || (!durableInput && phase !== "idle") || speechInput.busy || (!imageAllowed && !videoAllowed)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDismissed(true);
                picker.current?.click();
              }}
              className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 md:h-6 md:w-6"
            >
              <Paperclip className="h-6 w-6 md:h-4 md:w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="存为草稿"
              title="存为草稿"
              disabled={
                disabled ||
                speechInput.busy ||
                (drafts?.length ?? 0) >= 5 ||
                (draft.trim().length === 0 && attachments.length === 0 && videoFiles.length === 0 && !forwardDraft)
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void saveDraft()}
              className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 md:h-6 md:w-6"
            >
              <BookmarkPlus className="h-6 w-6 md:h-4 md:w-4" aria-hidden />
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
              <div className="flex shrink-0 items-center gap-1.5">
                {durableInput && (draft.trim() || attachments.length || forwardDraft || selectedDraftIds.size > 0) ? <button
                  type="button" aria-label="发送补充消息" title="发送提问或新要求，由当前 Agent 接续处理"
                  disabled={disabled || speechInput.busy} onMouseDown={event => event.preventDefault()}
                  onClick={() => send()} className="min-h-9 rounded-full px-3 text-xs text-accent disabled:opacity-30">发送补充</button> : null}
                {quiet ? (
                  // Next to Stop, because that is the decision it informs.
                  <span className="whitespace-nowrap text-[10px] leading-none text-muted" title="智能体已接受这一轮，但有一段时间没有新内容了。这不代表它出了问题——长任务本来就会安静很久。">
                    {quiet}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label="停止"
                  title="停止当前 Agent 本轮回复"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onInterrupt}
                  className="flex h-9 w-9 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full border border-line text-muted hover:border-danger hover:text-danger focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 md:h-6 md:w-6"
                >
                  <span className="h-[18px] w-[18px] rounded-[3px] bg-current md:h-3 md:w-3 md:rounded-[2px]" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="发送"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => send()}
                disabled={
                  disabled ||
                  speechInput.busy ||
                  (draft.trim().length === 0 && attachments.length === 0 && videoFiles.length === 0 && !forwardDraft && selectedDraftIds.size === 0)
                }
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

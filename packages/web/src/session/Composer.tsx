import type { AgentInfo, Attachment, CommandInfo } from "@genehub/proto";
import { Loader2, Paperclip } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { attachmentPreviewUrl, AttachmentTooLarge, fileToAttachment, imageFilesFromClipboard } from "./attachments";
import { ComposerControls } from "./ComposerControls";

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
  agents,
  agentId,
  modelId,
  modeId,
  effortId,
  agentLocked,
  attachmentsSupported,
  commands,
  restoreDraft,
  onSend,
  onInterrupt,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
  onHeightChange,
  onRestoreDraft,
}: {
  phase: ComposerPhase;
  disabled?: boolean;
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId?: string | null;
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
  onSend(text: string, attachments: Attachment[]): void;
  onInterrupt(): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort?(id: string): void;
  /** The card grows with text and attachments while floating over the
   * timeline. Its owner uses this to keep the last message and permission
   * prompt above the real card instead of a guessed fixed offset. */
  onHeightChange?(height: number): void;
  /** Acknowledges that `restoreDraft` has been taken into the field. */
  onRestoreDraft?(): void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const commandMenuId = `composer-commands-${useId()}`;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);

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
  const active = focused || settingsOpen;
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
    if (phase !== "idle" || disabled) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    onSend(text, attachments);
  };

  // A message that failed comes back whole, text and attachments together, so
  // it can be edited rather than retyped.
  useEffect(() => {
    if (!restoreDraft) return;
    setDraft(restoreDraft.text);
    setAttachments(restoreDraft.attachments);
    onRestoreDraft?.();
    textarea.current?.focus();
  }, [restoreDraft, onRestoreDraft]);

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
    if (textarea.current) resizeComposerTextarea(textarea.current, active);
  }, [active, draft]);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element || !onHeightChange) return;
    const update = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);

  useLayoutEffect(() => {
    const update = () => {
      if (textarea.current) resizeComposerTextarea(textarea.current, active);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [active]);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pt-8 md:px-4"
      style={{
        // Above the on-screen keyboard, and clear of the home indicator when
        // there is none. The shell is a fixed box that the keyboard covers
        // rather than shrinks (`shell/viewport.ts`), so without this the field
        // being typed into would be behind it.
        paddingBottom:
          "calc(var(--keyboard, 0px) + max(0.75rem, env(safe-area-inset-bottom)))",
      }}
    >
      {open ? (
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
      <div
        ref={card}
        data-composer-state={active ? "active" : "idle"}
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
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-1 px-1.5 py-1 md:py-0.5">
          <div
            data-composer-slot="input"
            className={`min-w-0 ${
              active
                ? "col-span-2 col-start-1 row-start-1"
                : "col-start-1 row-start-1"
            }`}
          >
            <textarea
              ref={textarea}
              data-expanded={active}
              className={`block w-full resize-none overflow-y-hidden bg-transparent px-3 text-base leading-9 text-fg outline-none placeholder:text-faint focus-visible:outline-transparent md:text-sm md:leading-6 ${
                active ? "py-1.5 md:py-1" : "py-[3px] md:py-0.5"
              }`}
              placeholder="描述任务…"
              aria-label="任务描述"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? commandMenuId : undefined}
              aria-activedescendant={
                open ? `${commandMenuId}-${Math.min(highlighted, matches.length - 1)}` : undefined
              }
              value={draft}
              disabled={disabled}
              rows={1}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setDraft(event.target.value);
                setHighlighted(0);
                setDismissed(false);
              }}
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
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            {pasteNotice ? (
              <p
                data-composer-slot="notice"
                className="px-3 py-1 text-xs text-muted"
                role="alert"
              >
                {pasteNotice}
              </p>
            ) : null}
          </div>
          <div
            data-composer-slot="runtime"
            data-row-units={active ? "1" : "0.5"}
            className={`col-start-1 row-start-2 flex min-w-0 items-center ${
              active ? "h-9 md:h-6" : "h-[18px] md:h-3"
            }`}
          >
            <ComposerControls
              agents={agents}
              agentId={agentId}
              modelId={modelId}
              modeId={modeId}
              effortId={effortId ?? null}
              compact={!active}
              disabled={disabled || phase !== "idle"}
              agentLocked={agentLocked}
              onOpenChange={setSettingsOpen}
              onPickAgent={onPickAgent}
              onPickModel={onPickModel}
              onPickMode={onPickMode}
              onPickEffort={onPickEffort ?? (() => {})}
            />
          </div>
          <div
            data-composer-slot="actions"
            data-row-units={active ? "1" : "1.25"}
            className={`col-start-2 flex flex-nowrap items-center gap-1 self-center ${
              active ? "row-start-2 h-9 md:h-6" : "row-span-2 row-start-1 h-[45px] md:h-8"
            }`}
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
            <button
              type="button"
              aria-label={
                attachmentsSupported
                  ? "添加文件（当前仅支持图片）"
                  : "添加文件（当前 Agent 不支持附件）"
              }
              title={attachmentsSupported ? "添加文件（当前仅支持图片）" : "当前 Agent 不支持附件"}
              disabled={disabled || phase !== "idle" || !attachmentsSupported}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDismissed(true);
                picker.current?.click();
              }}
              className={`flex !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 ${
                active ? "h-9 w-9 md:h-6 md:w-6" : "h-[45px] w-[45px] md:h-[30px] md:w-[30px]"
              }`}
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
                className={`flex !min-h-0 !min-w-0 shrink-0 cursor-default items-center justify-center rounded-full bg-accent/40 text-white ${
                  active ? "h-9 w-9 md:h-6 md:w-6" : "h-[45px] w-[45px] md:h-[30px] md:w-[30px]"
                }`}
              >
                <Loader2 className="h-6 w-6 animate-spin md:h-4 md:w-4" aria-hidden />
              </button>
            ) : phase === "running" ? (
              <button
                type="button"
                aria-label="停止"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onInterrupt}
                className={`flex !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full border border-line text-muted hover:border-danger hover:text-danger focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 ${
                  active ? "h-9 w-9 md:h-6 md:w-6" : "h-[45px] w-[45px] md:h-[30px] md:w-[30px]"
                }`}
              >
                <span className="h-[18px] w-[18px] rounded-[3px] bg-current md:h-3 md:w-3 md:rounded-[2px]" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  send();
                  textarea.current?.blur();
                }}
                disabled={disabled || (draft.trim().length === 0 && attachments.length === 0)}
                className={`flex !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-full bg-accent text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 disabled:opacity-30 ${
                  active ? "h-9 w-9 md:h-6 md:w-6" : "h-[45px] w-[45px] md:h-[30px] md:w-[30px]"
                }`}
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
    </div>
  );
}

export const COMPOSER_TEXTAREA_COLLAPSED_HEIGHT = 28;
export const COMPOSER_TEXTAREA_PHONE_COLLAPSED_HEIGHT = 42;
export const COMPOSER_TEXTAREA_PHONE_MIN_HEIGHT = 120;
export const COMPOSER_TEXTAREA_PHONE_MAX_HEIGHT = 192;
export const COMPOSER_TEXTAREA_DESKTOP_MIN_HEIGHT = 104;
export const COMPOSER_TEXTAREA_DESKTOP_MAX_HEIGHT = 176;
export const COMPOSER_DESKTOP_BREAKPOINT = 768;

/** Idle is one line: 36px on a phone and 24px on a wider screen. Focus expands
 * to roughly three-to-five phone lines or four-to-seven desktop lines, then
 * scrolls internally. */
export function resizeComposerTextarea(
  element: HTMLTextAreaElement,
  active: boolean,
  desktop = isDesktopComposerViewport(),
): number {
  if (!active) {
    const height = desktop
      ? COMPOSER_TEXTAREA_COLLAPSED_HEIGHT
      : COMPOSER_TEXTAREA_PHONE_COLLAPSED_HEIGHT;
    element.style.height = `${height}px`;
    element.style.overflowY = "hidden";
    return height;
  }

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

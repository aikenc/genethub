import type { AgentInfo, Attachment, CommandInfo } from "@genehub/proto";
import { Paperclip } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { attachmentPreviewUrl, AttachmentTooLarge, fileToAttachment, imageFilesFromClipboard } from "./attachments";
import { ComposerControls } from "./ComposerControls";

/**
 * Floating input at the bottom of the chat pane.
 *
 * Enter sends, shift+enter breaks the line. While a turn is running the send
 * control becomes stop — one affordance, because the user's intent is never
 * ambiguous. Agent and runtime settings live in one quiet footer summary; its
 * responsive detail panel keeps the richer catalog out of the conversation.
 *
 * Typing `/` opens the agent's own command list, when it has one. Running a
 * command needs nothing special — it goes out as ordinary text — so this is only
 * about discovery, which is the whole problem: a Claude Code install has dozens
 * of commands and skills that are invisible outside its own terminal.
 */
export function Composer({
  running,
  disabled,
  agents,
  agentId,
  modelId,
  modeId,
  effortId,
  agentLocked,
  attachmentsSupported,
  commands,
  onSend,
  onInterrupt,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
  onHeightChange,
}: {
  running: boolean;
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
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const open = matches.length > 0 && !settingsOpen;
  const chosen = matches[Math.min(highlighted, matches.length - 1)];

  const complete = (command: CommandInfo) => {
    // A trailing space, so an argument can be typed straight away — and so the
    // menu closes, the draft no longer being a bare slash token.
    setDraft(`/${command.name} `);
    setHighlighted(0);
  };

  const send = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    onSend(text, attachments);
  };

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
    if (textarea.current) resizeComposerTextarea(textarea.current);
  }, [draft]);

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
      if (textarea.current) resizeComposerTextarea(textarea.current);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

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
          <ul role="listbox" aria-label="命令">
            {matches.map((command, index) => (
              <li key={command.name}>
                <button
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
        className="pointer-events-auto mx-auto max-w-chat rounded-2xl border border-line-strong bg-surface/95 shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur"
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
        <textarea
          ref={textarea}
          className="h-[72px] min-h-[72px] max-h-[120px] w-full resize-none overflow-y-hidden bg-transparent px-4 py-3 text-base leading-6 text-fg outline-none placeholder:text-faint md:text-sm"
          placeholder="描述任务，或直接说你想改什么"
          aria-label="任务描述"
          value={draft}
          disabled={disabled}
          rows={2}
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
          <p className="px-4 pt-1 text-xs text-muted" role="alert">
            {pasteNotice}
          </p>
        ) : null}
        <div className="flex flex-nowrap items-center gap-1 px-2 pb-2 pt-0.5">
          <ComposerControls
            agents={agents}
            agentId={agentId}
            modelId={modelId}
            modeId={modeId}
            effortId={effortId ?? null}
            disabled={disabled || running}
            agentLocked={agentLocked}
            onOpenChange={setSettingsOpen}
            onPickAgent={onPickAgent}
            onPickModel={onPickModel}
            onPickMode={onPickMode}
            onPickEffort={onPickEffort ?? (() => {})}
          />
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
              attachmentsSupported ? "添加文件" : "添加文件（当前 Agent 不支持附件）"
            }
            title={attachmentsSupported ? "添加文件（当前支持图片）" : "当前 Agent 不支持附件"}
            disabled={disabled || running || !attachmentsSupported}
            onClick={() => {
              setDismissed(true);
              picker.current?.click();
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg disabled:opacity-30 md:h-8 md:w-8"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
          </button>
          {running ? (
            <button
              type="button"
              aria-label="停止"
              onClick={onInterrupt}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-muted hover:border-danger hover:text-danger md:h-8 md:w-8"
            >
              <span className="h-3 w-3 rounded-[2px] bg-current md:h-2.5 md:w-2.5" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="发送"
              onClick={send}
              disabled={disabled || (draft.trim().length === 0 && attachments.length === 0)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30 md:h-8 md:w-8"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-4 w-4 md:h-3.5 md:w-3.5"
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
  );
}

export const COMPOSER_TEXTAREA_MIN_HEIGHT = 72;
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 120;

/** Fit two to four 24px lines plus vertical padding. Kept as a small exported
 * function so the clamp can be tested without asking jsdom to perform layout. */
export function resizeComposerTextarea(element: HTMLTextAreaElement): number {
  element.style.height = "auto";
  const contentHeight = element.scrollHeight || COMPOSER_TEXTAREA_MIN_HEIGHT;
  const height = Math.min(
    COMPOSER_TEXTAREA_MAX_HEIGHT,
    Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, contentHeight),
  );
  element.style.height = `${height}px`;
  element.style.overflowY = contentHeight > COMPOSER_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  return height;
}

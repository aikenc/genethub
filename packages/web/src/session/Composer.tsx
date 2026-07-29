import type { AgentInfo, Attachment } from "@genehub/proto";
import { useState } from "react";

import { attachmentPreviewUrl, AttachmentTooLarge, fileToAttachment, imageFilesFromClipboard } from "./attachments";
import { ComposerControls } from "./ComposerControls";

/**
 * Floating input at the bottom of the chat pane.
 *
 * Enter sends, shift+enter breaks the line. While a turn is running the send
 * control becomes stop — one affordance, because the user's intent is never
 * ambiguous. Model and mode live here too, as chips under the text.
 */
export function Composer({
  running,
  disabled,
  agents,
  agentId,
  modelId,
  modeId,
  agentLocked,
  attachmentsSupported,
  onSend,
  onInterrupt,
  onPickAgent,
  onPickModel,
  onPickMode,
}: {
  running: boolean;
  disabled?: boolean;
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  agentLocked?: boolean;
  /** Whether the current agent forwards attachments anywhere (only claude,
   * acp and opencode do today — see `docs/roadmap.md`). Pasting an image
   * when this is false is left as a normal, inert text paste rather than
   * silently producing an attachment the agent will never see. */
  attachmentsSupported?: boolean;
  onSend(text: string, attachments: Attachment[]): void;
  onInterrupt(): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const send = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDraft("");
    setAttachments([]);
    onSend(text, attachments);
  };

  const addPastedImages = async (files: File[]) => {
    if (!attachmentsSupported) {
      setPasteNotice("当前 agent 还不支持贴图");
      return;
    }
    try {
      const added = await Promise.all(files.map(fileToAttachment));
      setAttachments((current) => [...current, ...added]);
      setPasteNotice(null);
    } catch (error) {
      setPasteNotice(error instanceof AttachmentTooLarge ? error.message : "读取图片失败");
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4 pt-8">
      <div className="pointer-events-auto mx-auto max-w-chat rounded-2xl border border-line-strong bg-surface/95 shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur">
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-4 pt-3" aria-label="待发送的图片">
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
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-xs text-muted shadow group-hover:text-fg"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          className="max-h-40 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3 text-sm text-fg outline-none placeholder:text-faint"
          placeholder="描述任务，或直接说你想改什么"
          aria-label="任务描述"
          value={draft}
          disabled={disabled}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = imageFilesFromClipboard(event.clipboardData);
            if (files.length === 0) return;
            // Pasting an image alongside plain text is possible in principle,
            // but the composer is a single textarea: no cursor position to
            // insert a thumbnail at. Only the image is kept, same as most
            // chat apps' composers when a screenshot lands in an empty draft.
            event.preventDefault();
            void addPastedImages(files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        {pasteNotice ? <p className="px-4 pt-1 text-xs text-muted">{pasteNotice}</p> : null}
        <div className="flex items-center gap-2 px-2 pb-2">
          <ComposerControls
            agents={agents}
            agentId={agentId}
            modelId={modelId}
            modeId={modeId}
            disabled={disabled || running}
            agentLocked={agentLocked}
            onPickAgent={onPickAgent}
            onPickModel={onPickModel}
            onPickMode={onPickMode}
          />
          {running ? (
            <button
              type="button"
              aria-label="停止"
              onClick={onInterrupt}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-muted hover:border-danger hover:text-danger"
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="发送"
              onClick={send}
              disabled={disabled || (draft.trim().length === 0 && attachments.length === 0)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                <path d="M8 3.2 3.6 7.6l1.1 1.1L7.2 6.2V13h1.6V6.2l2.5 2.5 1.1-1.1L8 3.2Z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

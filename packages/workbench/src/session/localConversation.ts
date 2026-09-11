import type { Attachment, SessionReplyCursor, SessionSummary } from "@genehub/proto";
import { useEffect, useReducer } from "react";

/** Local UI state only. Neither navigation nor persistence sends a message. */
export interface LocalDraft { text: string; attachments: Attachment[]; missingAttachments: number; recoveryNotice?: string }
const memory = new Map<string, LocalDraft>();
const prefix = "genehub.conversation.v1:";
export function readLocalDraft(key: string): LocalDraft {
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const saved = JSON.parse(localStorage.getItem(prefix + key) ?? "null");
    if (saved && typeof saved.text === "string") return { text: saved.text, attachments: [], missingAttachments: Number(saved.attachmentCount) || 0 };
  } catch { /* Private browsing or damaged local data must not block chatting. */ }
  const pending = localValue<{text:string; attachmentCount:number}>(`outbox:${key}`);
  if (pending && typeof pending.text === "string") return {text:pending.text, attachments:[], missingAttachments:pending.attachmentCount || 0, recoveryNotice:"上次发送结果未确认，请先检查会话记录，避免重复发送。"};
  return { text: "", attachments: [], missingAttachments: 0 };
}
export function saveLocalDraft(key: string, draft: LocalDraft): void {
  memory.delete(key); memory.set(key, draft);
  if (memory.size > 20) memory.delete(memory.keys().next().value!);
  window.dispatchEvent(new Event("genehub-conversation-local"));
  // Never persist binary/base64 attachments. Their loss is explicitly presented.
  try {
    if (!draft.text && !draft.attachments.length && !draft.missingAttachments) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, JSON.stringify({ text: draft.text, attachmentCount: draft.attachments.length + draft.missingAttachments }));
  } catch { /* In-memory editing remains usable when storage is unavailable. */ }
}

export interface ReadingPosition { anchor: string; offset: number; bottom: boolean }
export function localValue<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(prefix + key) ?? "null"); } catch { return null; } }
export function saveLocalValue(key: string, value: unknown): void { try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* optional local preferences */ } }
export function markContentRead(machine: string, session: string, cursor: SessionReplyCursor): void {
 const key = `reply-read:${machine}:${session}`;
 const previous = localValue<SessionReplyCursor>(key);
 if (previous?.itemId === cursor.itemId || (previous?.atMs ?? 0) > cursor.atMs) return;
 saveLocalValue(key, cursor);
 window.dispatchEvent(new Event("genehub-conversation-local"));
}

/** One migration for the complete machine list, never one baseline per visit.
 * New sessions/replies after migration remain unread until actually seen. */
export function initializeReplyReads(machine: string, sessions: readonly SessionSummary[]): void {
  if (!machine || localValue(`reply-baseline:${machine}`)) return;
  if (sessions.length && !sessions.some(session => session.interactionSummary)) return;
  for (const session of sessions) {
    if (session.latestReply && !localValue(`reply-read:${machine}:${session.id}`)) {
      saveLocalValue(`reply-read:${machine}:${session.id}`, session.latestReply);
    }
  }
  saveLocalValue(`reply-baseline:${machine}`, true);
}

export function hasUnreadReply(machine: string, session: SessionSummary): boolean {
  const reply = session.latestReply;
  if (!machine || !reply || !localValue(`reply-baseline:${machine}`)) return false;
  const read = localValue<SessionReplyCursor>(`reply-read:${machine}:${session.id}`);
  return read?.itemId !== reply.itemId && (read?.atMs ?? 0) <= reply.atMs;
}

/** Same-browser tabs observe the same local read and draft facts. */
export function useConversationLocalChanges(): void {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const storage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(prefix)) refresh(); };
    window.addEventListener("genehub-conversation-local", refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("genehub-conversation-local", refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);
}

export interface DraftIdentity { localId: string; workspaceId: string; agentId: string | null; title: string; modelId?: string | null; modeId?: string | null; effortId?: string | null; runtimeValues?: Record<string,string> }
export function draftIdentities(machine: string): DraftIdentity[] { const value = localValue<DraftIdentity[]>(`drafts:${machine}`); return Array.isArray(value) ? value.filter(item => item && typeof item.localId === "string" && typeof item.workspaceId === "string") : []; }
export function rememberDraftIdentity(machine: string, draft: DraftIdentity): void {
 saveLocalValue(`drafts:${machine}`, [...draftIdentities(machine).filter(item => item.localId !== draft.localId && Boolean(readLocalDraft(`${machine}:${item.localId}`).text || readLocalDraft(`${machine}:${item.localId}`).attachments.length || readLocalDraft(`${machine}:${item.localId}`).missingAttachments)), draft]);
}
export function forgetDraftIdentity(machine: string, id: string): void { saveLocalValue(`drafts:${machine}`, draftIdentities(machine).filter(item => item.localId !== id)); }

/** Each receipt has its own key, so simultaneous tabs never replace each other. */
export function savedInputReceipts(machine: string, session: string): import("./timeline").PendingMessage[] {
  const scope = `${prefix}input:${machine}:${session}:`;
  try {
    return Object.keys(localStorage).filter(key => key.startsWith(scope)).slice(0, 32).flatMap(key => {
      const value = JSON.parse(localStorage.getItem(key) ?? "null");
      return value && typeof value.messageId === "string" && typeof value.text === "string" ? [{ ...value, attachments: [], error: "上次接收结果待核对；重试会使用原消息 ID。" }] : [];
    });
  } catch { return []; }
}
export function saveInputReceipt(machine: string, session: string, input: import("./timeline").PendingMessage, remove = false): void {
  const key = `${prefix}input:${machine}:${session}:${input.messageId}`;
  try {
    if (remove) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ ...input, attachments: [], missingAttachments: input.attachments.length || input.missingAttachments || 0 }));
  } catch { /* Server acceptance remains durable; unsent data stays in this tab. */ }
}

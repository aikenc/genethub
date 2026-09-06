import type { Attachment } from "@genehub/proto";

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
export function markContentRead(machine: string, session: string, cursor: string): void {
 const key = `read:${machine}:${session}`;
 if (localValue(key) === cursor) return;
 saveLocalValue(key, cursor);
 window.dispatchEvent(new Event("genehub-conversation-local"));
}

export interface DraftIdentity { localId: string; workspaceId: string; agentId: string | null; title: string; modelId?: string | null; modeId?: string | null; effortId?: string | null; runtimeValues?: Record<string,string> }
export function draftIdentities(machine: string): DraftIdentity[] { const value = localValue<DraftIdentity[]>(`drafts:${machine}`); return Array.isArray(value) ? value.filter(item => item && typeof item.localId === "string" && typeof item.workspaceId === "string") : []; }
export function rememberDraftIdentity(machine: string, draft: DraftIdentity): void {
 saveLocalValue(`drafts:${machine}`, [...draftIdentities(machine).filter(item => item.localId !== draft.localId && Boolean(readLocalDraft(`${machine}:${item.localId}`).text || readLocalDraft(`${machine}:${item.localId}`).attachments.length || readLocalDraft(`${machine}:${item.localId}`).missingAttachments)), draft]);
}
export function forgetDraftIdentity(machine: string, id: string): void { saveLocalValue(`drafts:${machine}`, draftIdentities(machine).filter(item => item.localId !== id)); }

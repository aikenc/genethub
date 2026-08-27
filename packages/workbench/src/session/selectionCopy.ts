import type { SelectableMessage } from "./selection";

/**
 * Copy formatting for a selection (proposal §4): plain Markdown, timeline
 * order, role and round-boundary time on every message, attachments listed by
 * name/mime only. Nothing here touches the network.
 */

/** Past this many characters the action bar asks for a confirmation first. */
export const COPY_SOFT_LIMIT_CHARS = 200_000;

export interface CopySource {
  sessionId: string;
  agentLabel: string | null;
  /** Session-level time span, when known (epoch ms). */
  spanMs: { start: number; end: number } | null;
}

export interface CopyMessage extends SelectableMessage {
  /** Owning round's boundary time, the honest approximation we have (§5.5). */
  atMs: number | null;
}

export interface BuiltCopy {
  text: string;
  exceedsSoftLimit: boolean;
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildSelectionCopy(
  source: CopySource,
  messages: readonly CopyMessage[],
): BuiltCopy {
  const lines: string[] = ["# 转发自 GeneHub 会话", ""];
  const span = source.spanMs
    ? `${formatClock(source.spanMs.start)} – ${formatClock(source.spanMs.end)}`
    : "时间未知";
  lines.push(
    `源会话：${source.sessionId} · ${source.agentLabel ?? "未知 Agent"} · ${span}`,
    `共 ${messages.length} 条，导出时间 ${formatClock(Date.now())}`,
  );
  for (const message of messages) {
    lines.push("");
    const when = message.atMs === null ? "时间未知" : formatClock(message.atMs);
    lines.push(`## ${message.role === "user" ? "用户" : "助手"} · ${when}`);
    if (message.text) lines.push(message.text);
    for (const attachment of message.attachments) {
      lines.push(`[附件：${attachment.name}（${attachment.mime}）]`);
    }
  }
  const text = `${lines.join("\n")}\n`;
  return { text, exceedsSoftLimit: text.length > COPY_SOFT_LIMIT_CHARS };
}

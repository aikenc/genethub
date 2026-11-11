import { useState } from "react";
import { Inbox, Users } from "lucide-react";
import type { SessionSummary } from "@genehub/proto";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";

type Coordination = NonNullable<SessionSummary["coordination"]>;

function coordinationFacts(session: SessionSummary): Coordination | null {
  const c = session.coordination;
  if (!c || !(c.active || c.pending || c.ready || c.unknown || c.stale)) return null;
  return c;
}

/** The detail view, shared by the full-width bar and the compact entry-strip pill. */
function CoordinationDialog({ session, coordination, onClose }: {
  session: SessionSummary;
  coordination: Coordination;
  onClose(): void;
}) {
  const unknown = coordination.stale || coordination.unknown > 0;
  return (
    <WorkspaceDetailsDialog title="协作进度" onClose={onClose}>
      <p className="text-sm">{unknown ? "状态尚待确认。" : "正在协作。"}等待 {coordination.pending} 项，结果就绪 {coordination.ready} 项，状态未知 {coordination.unknown} 项。</p>
      <p className="mt-2 text-xs text-muted">上次更新：{new Date(coordination.updatedAtMs).toLocaleString()}。补充目标或要求，请继续在当前会话中发送；具体工作与产物以 Agent 的回复为准。</p>
      <p className="mt-2 text-xs text-faint">{session.title || "当前会话"}</p>
    </WorkspaceDetailsDialog>
  );
}

/**
 * Compact coordination summary for the project entry strip.
 *
 * The full-width bar is only kept for sessions without entries; when an entry
 * strip exists, this pill carries the same facts in the same 40px row instead
 * of adding a second bar.
 */
export function SessionCoordinationPill({ session }: { session?: SessionSummary }) {
  const [detail, setDetail] = useState(false);
  const coordination = session ? coordinationFacts(session) : null;
  if (!session || !coordination) return null;
  const unknown = coordination.stale || coordination.unknown > 0;
  return <>
    <button
      type="button"
      aria-label="会话协作进度"
      title="查看协作进度"
      className="sticky right-0 ml-auto flex h-7 shrink-0 items-center gap-1 rounded-lg border border-accent/30 bg-surface px-2 text-[10px] text-muted hover:border-accent/60 hover:text-fg"
      onClick={() => setDetail(true)}
    >
      <Users size={13} aria-hidden />
      <span className="hidden md:inline">{unknown ? "协作待核对" : "协作进行中"}</span>
      {coordination.pending > 0 && <span>{coordination.pending} 等待</span>}
      {coordination.ready > 0 && <span>{coordination.ready} 结果</span>}
    </button>
    {detail && <CoordinationDialog session={session} coordination={coordination} onClose={() => setDetail(false)} />}
  </>;
}

/** Render the session's actual coordination facts, independent of list pagination. */
export function SessionCoordination({session}: {session: SessionSummary}) {
  const [detail, setDetail] = useState(false);
  const coordination = coordinationFacts(session);
  if (!coordination) return null;
  const unknown = coordination.stale || coordination.unknown > 0;
  return <>
    <div aria-label="会话协作进度" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-accent/5 px-4 py-2 text-xs text-muted">
      <span className="inline-flex items-center gap-1"><Users size={16}/>{unknown ? "协作状态待核对" : "协作进行中"}</span>
      {coordination.pending > 0 && <span>等待 {coordination.pending} 项</span>}
      {coordination.ready > 0 && <span className="inline-flex items-center gap-1"><Inbox size={16}/>{coordination.ready} 项结果待处理</span>}
      <button className="ml-auto min-h-8 text-accent" onClick={() => setDetail(true)}>查看</button>
    </div>
    {detail && <CoordinationDialog session={session} coordination={coordination} onClose={() => setDetail(false)} />}
  </>;
}

import { useState } from "react";
import { Inbox, Users } from "lucide-react";
import type { SessionSummary } from "@genehub/proto";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";

/** Render the session's actual coordination facts, independent of list pagination. */
export function SessionCoordination({session}: {session: SessionSummary}) {
  const [detail, setDetail] = useState(false);
  const c = session.coordination;
  if (!c || !(c.active || c.pending || c.ready || c.unknown || c.stale)) return null;
  const unknown = c.stale || c.unknown > 0;
  return <>
    <div aria-label="会话协作进度" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-accent/5 px-4 py-2 text-xs text-muted">
      <span className="inline-flex items-center gap-1"><Users size={16}/>{unknown ? "协作状态待核对" : "协作进行中"}</span>
      {c.pending > 0 && <span>等待 {c.pending} 项</span>}
      {c.ready > 0 && <span className="inline-flex items-center gap-1"><Inbox size={16}/>{c.ready} 项结果待处理</span>}
      <button className="ml-auto min-h-8 text-accent" onClick={() => setDetail(true)}>查看</button>
    </div>
    {detail && <WorkspaceDetailsDialog title="协作进度" onClose={() => setDetail(false)}>
      <p className="text-sm">{unknown ? "状态尚待确认。" : "正在协作。"}等待 {c.pending} 项，结果就绪 {c.ready} 项，状态未知 {c.unknown} 项。</p>
      <p className="mt-2 text-xs text-muted">上次更新：{new Date(c.updatedAtMs).toLocaleString()}。补充目标或要求，请继续在当前会话中发送；具体工作与产物以 Agent 的回复为准。</p>
    </WorkspaceDetailsDialog>}
  </>;
}

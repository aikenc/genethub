import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { useWorkbench } from "./store";
import { markContentRead } from "./localConversation";
import { sessionPinned, setSessionPinned, useSessionPreferences } from "./session-preferences";
import { SessionProcessesDialog } from "../processes/SessionProcessesDialog";
import { LabelEditor } from "../shell/ConversationRows";
import { SessionStatusIcon } from "../shell/SessionStatusIcon";
import { sessionAttention } from "./attention";
import { buildAgentSpaceTree } from "../workspace/agent-space-tree";

export function SessionHeading({ session, workspace, onOpenExpert, onReportSession, machineName }: {
  session: SessionSummary; workspace?: WorkspaceInfo; onOpenExpert(id: string): void; onReportSession?(id: string): void; machineName?: string;
}) {
  const workspaces = useWorkbench((s) => s.workspaces);
  const machine = useWorkbench(s => s.client?.identity?.machineId ?? "");
  useSessionPreferences();
  const pinned = sessionPinned(machine, session.id);
  const summaries = useWorkbench(s => s.sessions), agents = useWorkbench(s => s.agents);
  const [labels, setLabels] = useState(false), [processes, setProcesses] = useState(false), [deleting, setDeleting] = useState(false);
  const readOnly = Boolean(session.historyOnly || session.unsupported);
  const sessionAgent = agents.find(a => a.id === session.agentId);
  const action = async (operation: () => Promise<boolean>) => {
    setBusy(true); setError("");
    try { if (!await operation()) setError(useWorkbench.getState().notice ?? "操作未完成，请核对后重试。"); else { setMenuOpen(false); setDeleting(false); } }
    catch (e) { setError(e instanceof Error ? e.message : "操作未完成"); }
    finally { setBusy(false); }
  };
  const breadcrumb = workspace ? buildAgentSpaceTree(workspaces).breadcrumbById[workspace.id] ?? workspace.name : "";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  return <>
    <div className="gh-session-heading min-w-0 flex-1 px-2 py-1.5">
      <h1 aria-label={session.title || "未命名会话"} className="gh-session-title truncate font-medium"><button type="button" aria-label="修改会话标题"
        title="点击修改会话标题" className="block min-w-0 max-w-full truncate rounded text-left hover:text-accent focus-visible:outline-accent"
        disabled={readOnly} onClick={() => { setTitle(session.title ?? ""); setError(""); setEditing(true); }}>{session.title || "未命名会话"}</button></h1>
      {workspace ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"><button type="button" aria-label="当前项目" title={`进入项目：${breadcrumb}`}
        className="gh-session-expert flex min-w-0 max-w-full items-center gap-1 rounded text-muted hover:bg-raised hover:text-accent focus-visible:outline-accent"
        onClick={() => onOpenExpert(workspace.id)}>
        <AgentAvatar id={workspace.id} name={workspace.name} size="small" />
        <span className="truncate">{breadcrumb}</span><ChevronRight size={12} className="shrink-0" />
      </button>{session.labels?.filter(label => label !== "系统发起").map((label) => <span key={label} className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-normal text-accent">{label}</span>)}</div> : <p className="gh-session-expert text-muted">会话</p>}
    </div>
    <SessionStatusIcon session={session} sessions={summaries} />
    <div ref={menu} className="relative shrink-0">
      <button ref={menuButton} type="button" aria-label="会话菜单" aria-expanded={menuOpen}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-raised"
        onClick={() => { setError(""); setMenuOpen(open => !open); }}><MoreHorizontal size={20} /></button>
      {menuOpen && <div role="menu" aria-label="会话菜单" className="absolute right-0 top-full z-50 max-h-[70dvh] w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
        <p className="border-b border-line px-3 py-2 text-xs leading-5 text-muted">{breadcrumb} · {machineName}<br />{sessionAgent?.label ?? session.agentId} · {session.modelId ?? "默认模型"}<br />{sessionAttention(session, summaries).label || "空闲"}</p>
        <button role="menuitem" className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => { setSessionPinned(machine, session.id, !pinned); setMenuOpen(false); }}>{pinned ? "取消置顶" : "置顶会话"}</button>
        {!readOnly && <>
          <button role="menuitem" disabled={busy} className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => { setMenuOpen(false); setTitle(session.title ?? ""); setEditing(true); }}>重命名</button>
          <button role="menuitem" disabled={busy} className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => { setMenuOpen(false); setLabels(true); }}>标签</button>
        </>}
        {session.latestReply && <button role="menuitem" className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => { markContentRead(useWorkbench.getState().client?.identity?.machineId ?? "",session.id,session.latestReply!); setMenuOpen(false); }}>标为已读</button>}
        <button role="menuitem" className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => { setMenuOpen(false); setProcesses(true); }}>后台进程</button>
        {!readOnly && <>
          <button role="menuitem" disabled={busy} className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => void action(() => useWorkbench.getState().archiveSession(session.id,!session.archived))}>{session.archived ? "恢复会话" : "归档会话"}</button>
          <button role="menuitem" disabled={busy} className="min-h-11 w-full rounded px-3 text-left text-sm text-danger hover:bg-raised" onClick={() => { setMenuOpen(false); setDeleting(true); }}>删除…</button>
        </>}
        {onReportSession && <button role="menuitem" className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised" onClick={() => { setMenuOpen(false); onReportSession(session.id); }}>反馈问题</button>}
        {error && <p role="alert" className="p-3 text-xs text-danger">{error}</p>}
      </div>}
    </div>
    {labels && <WorkspaceDetailsDialog title="会话标签" onClose={() => setLabels(false)}><LabelEditor labels={(session.labels ?? []).filter(label => label !== "系统发起")} onChange={change => useWorkbench.getState().labelSession(session.id,change)} onDone={() => setLabels(false)} /></WorkspaceDetailsDialog>}
    {processes && <SessionProcessesDialog sessionId={session.id} onClose={() => setProcesses(false)} />}
    {deleting && <WorkspaceDetailsDialog title="删除会话" onClose={() => { if (!busy) setDeleting(false); }}><p className="text-sm">删除「{session.title}」及其历史？此操作无法恢复，执行中的任务也会停止。</p>{error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}<button disabled={busy} className="mt-4 min-h-11 w-full rounded-lg bg-danger text-sm text-white" onClick={() => void action(() => useWorkbench.getState().deleteSession(session.id))}>确认删除</button></WorkspaceDetailsDialog>}
    {editing && <WorkspaceDetailsDialog title="修改会话标题" onClose={() => { if (!busy) setEditing(false); }}>
      <form onSubmit={async event => {
        event.preventDefault();
        if (busy || !title.trim()) return;
        setBusy(true); setError("");
        try {
          const saved = await useWorkbench.getState().renameSession(session.id, title);
          if (saved) setEditing(false);
          else setError(useWorkbench.getState().notice ?? "标题保存失败，请重试。");
        } catch (failure) { setError(failure instanceof Error ? failure.message : "标题保存失败，请重试。"); }
        finally { setBusy(false); }
      }}>
        <label className="block text-sm">会话标题<input autoFocus aria-label="会话标题" value={title}
          disabled={busy} onChange={event => setTitle(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-lg border border-line bg-raised px-3" /></label>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy || !title.trim()} className="mt-4 min-h-11 w-full rounded-lg bg-accent text-sm text-white disabled:opacity-40">{busy ? "保存中…" : "保存标题"}</button>
      </form>
    </WorkspaceDetailsDialog>}
  </>;
}

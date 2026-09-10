import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { useWorkbench } from "./store";

export function SessionHeading({ session, workspace, onOpenExpert, onReportSession }: {
  session: SessionSummary; workspace?: WorkspaceInfo; onOpenExpert(id: string): void; onReportSession?(id: string): void;
}) {
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
    <div className="min-w-0 flex-1 px-2 py-1.5">
      <h1 aria-label={session.title || "未命名会话"} className="truncate text-sm font-medium leading-5"><button type="button" aria-label="修改会话标题"
        title="点击修改会话标题" className="block min-h-6 min-w-0 max-w-full truncate rounded text-left hover:text-accent focus-visible:outline-accent"
        onClick={() => { setTitle(session.title ?? ""); setError(""); setEditing(true); }}>{session.title || "未命名会话"}</button></h1>
      {workspace ? <button type="button" aria-label="当前专家" title={`进入专家：${workspace.name}`}
        className="mt-0.5 flex min-h-6 min-w-0 max-w-full items-center gap-1 rounded text-xs leading-5 text-muted hover:bg-raised hover:text-accent focus-visible:outline-accent"
        onClick={() => onOpenExpert(workspace.id)}>
        <AgentAvatar id={workspace.id} name={workspace.name} size="small" />
        <span className="truncate">{workspace.name}</span><ChevronRight size={12} className="shrink-0" />
      </button> : <p className="text-xs leading-5 text-muted">会话</p>}
    </div>
    {onReportSession && <div ref={menu} className="relative shrink-0">
      <button ref={menuButton} type="button" aria-label="会话菜单" aria-expanded={menuOpen}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-raised"
        onClick={() => setMenuOpen(open => !open)}><MoreHorizontal size={20} /></button>
      {menuOpen && <div className="absolute right-0 top-full z-50 min-w-36 rounded-lg border border-line bg-surface p-1 shadow-lg">
        <button type="button" className="min-h-11 w-full rounded px-3 text-left text-sm hover:bg-raised"
          onClick={() => { setMenuOpen(false); onReportSession(session.id); }}>反馈问题</button>
      </div>}
    </div>}
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

import { useState } from "react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { useWorkbench } from "./store";

export function SessionHeading({ session, workspace, onOpenExpert }: {
  session: SessionSummary; workspace?: WorkspaceInfo; onOpenExpert(id: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <>
    {workspace && <button type="button" aria-label="当前专家" title={`进入专家：${workspace.name}`}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-raised"
      onClick={() => onOpenExpert(workspace.id)}><AgentAvatar id={workspace.id} name={workspace.name} /></button>}
    <div className="min-w-0 flex-1 px-2 py-2">
      <h1 aria-label={session.title || "未命名会话"} className="truncate text-lg font-semibold"><button type="button" aria-label="修改会话标题"
        title="点击修改会话标题" className="min-h-11 max-w-full truncate text-left hover:text-accent"
        onClick={() => { setTitle(session.title ?? ""); setError(""); setEditing(true); }}>{session.title || "未命名会话"}</button></h1>
      <p className="truncate text-xs text-muted">{workspace?.name ?? "会话"}</p>
    </div>
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

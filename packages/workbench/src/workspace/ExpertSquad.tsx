import { useState } from "react";
import type { WorkspaceInfo } from "@genehub/proto";
import { useWorkbench } from "../session/store";
import { ExpertPickerDialog } from "./ExpertPicker";
import { AgentList } from "./AgentList";
import { AgentAdvancedSettings } from "./AgentAdvancedSettings";
import { isDescendant } from "./agent-space-tree";

export function ExpertSquad({ workspace, onOpen }: { workspace: WorkspaceInfo; onOpen(id: string): void }) {
  const { workspaces, sessions, configureAgentSpace } = useWorkbench();
  const children = workspaces.filter(w => w.agentSpace?.parentWorkspaceId === workspace.id);
  const candidates = workspaces.filter(w => w.agentSpace && w.id !== workspace.id && !w.agentSpace.parentWorkspaceId && !isDescendant(workspaces, workspace.id, w.id));
  const [selected, setSelected] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const move = async (child: WorkspaceInfo, parentWorkspaceId: string | null) => {
    setBusy(true); setError("");
    try { await configureAgentSpace(child.id, child.agentSpace!.revision, { kind: "setParent", parentWorkspaceId }); setSelected(""); }
    catch(e) { setError(e instanceof Error ? e.message : "关系更新失败"); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <p className="text-xs text-muted">此处管理当前专家的直属成员；工作流与调度权限仍由项目配置决定。</p>
    {children.length ? <><AgentList workspaces={workspaces} sessions={sessions} rootIds={children.map(w => w.id)} density="comfortable" actions={false} onPick={onOpen} />
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm">调整成员归属</summary>{children.map(w => <div key={w.id} className="flex items-center gap-2 border-b border-line py-2"><span className="min-w-0 flex-1 truncate text-sm">{w.name}</span><button type="button" disabled={busy} className="min-h-11 px-3 text-sm text-muted disabled:opacity-40" onClick={() => void move(w, null)}>移出小队</button></div>)}</details></> : <p className="py-4 text-sm text-muted">还没有直属成员。</p>}
    <div className="flex gap-2"><button type="button" aria-label="添加已有专家到小队" disabled={busy} className="min-h-11 min-w-0 flex-1 truncate rounded-lg border border-line px-3 text-left text-sm" onClick={() => setChoosing(true)}>{candidates.find(w => w.id === selected)?.name ?? "选择已有专家"}</button><button type="button" disabled={busy || !candidates.some(w => w.id === selected)} className="min-h-11 rounded-lg bg-accent px-3 text-sm text-white disabled:opacity-40" onClick={() => { const child = candidates.find(w => w.id === selected); if(child) void move(child, workspace.id); }}>加入</button></div>
    {choosing && <ExpertPickerDialog title="选择小队成员" selectedId={selected} allowedIds={candidates.map(w => w.id)} onClose={() => setChoosing(false)} onPick={id => { setSelected(id); setChoosing(false); }} />}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <AgentAdvancedSettings key={workspace.id} workspace={workspace} section="relations" inline />
  </div>;
}

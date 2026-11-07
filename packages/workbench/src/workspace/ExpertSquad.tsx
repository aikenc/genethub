import { AgentAvatar } from "./AgentAvatar";
import { SessionActivityIcons } from "../shell/SessionStatusIcon";
import { machineReady } from "../protocol/summary-directory";
import { workspaceMembers } from "./members";
import type { MachineSummary } from "../protocol/summary-directory";
import type { Target } from "../host";
import { useState } from "react";
import type { WorkspaceInfo } from "@genehub/proto";
import { useWorkbench } from "../session/store";
import { ExpertPickerDialog } from "./ExpertPicker";
import { AgentList } from "./AgentList";
import { AgentAdvancedSettings } from "./AgentAdvancedSettings";
import { isDescendant } from "./agent-space-tree";

export function ExpertSquad({ workspace, onOpen, sources = [], onOpenRemote }: { workspace: WorkspaceInfo; onOpen(id: string): void; sources?: MachineSummary[]; onOpenRemote?(machine: Target,id: string): void }) {
  const { workspaces, sessions, configureAgentSpace, client } = useWorkbench();
  const source = sources.find(row => row.target.deviceHandle === client?.identity?.machineId);
  const remote = source ? workspaceMembers(sources,{...source,workspaces},workspace,false).filter(member => member.row?.target.deviceHandle !== client?.identity?.machineId || !member.row) : [];
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
    <p className="text-xs text-muted">此处管理当前项目的本机和远程成员；任务分工通过团队 Skill 和会话协作完成。</p>
    {children.length ? <><AgentList workspaces={workspaces} sessions={sessions} rootIds={children.map(w => w.id)} density="comfortable" actions={false} deviceName={source?.target.label ?? client?.identity?.machineName ?? "本机"} onPick={onOpen} />
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm">调整成员归属</summary>{children.map(w => <div key={w.id} className="flex items-center gap-2 border-b border-line py-2"><span className="min-w-0 flex-1 truncate text-sm">{w.name}</span><button type="button" disabled={busy} className="min-h-11 px-3 text-sm text-muted disabled:opacity-40" onClick={() => void move(w, null)}>移出小队</button></div>)}</details></> : <p className="py-4 text-sm text-muted">还没有直属成员。</p>}
    {remote.map(member => <div key={member.key}>
      {member.row && member.workspace ? <button type="button" aria-label={member.workspace.name} aria-description={member.machine} className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-raised" onClick={() => onOpenRemote?.(member.row!.target,member.workspaceId)}>
        <AgentAvatar id={member.workspaceId} name={member.workspace.name} />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{member.workspace.name}</span><span className="block truncate text-xs text-muted">{member.machine}</span></span>
        <SessionActivityIcons sessions={(member.row.activeSessions ?? member.row.sessions).filter(s => s.workspaceId === member.workspaceId)} partial={!member.row.activityComplete} stale={!machineReady(member.row)} />
      </button>
      : <p className="py-3 text-sm text-muted">{member.name} · {member.machine} · 尚未读取</p>}
    </div>)}
    {remote.length > 0 && <p className="text-xs text-muted">远程归属由定义源配置，变更后通过原 build 更新。</p>}
    <div className="flex gap-2"><button type="button" aria-label="添加已有项目到小队" disabled={busy} className="min-h-11 min-w-0 flex-1 truncate rounded-lg border border-line px-3 text-left text-sm" onClick={() => setChoosing(true)}>{candidates.find(w => w.id === selected)?.name ?? "选择已有项目"}</button><button type="button" disabled={busy || !candidates.some(w => w.id === selected)} className="min-h-11 rounded-lg bg-accent px-3 text-sm text-white disabled:opacity-40" onClick={() => { const child = candidates.find(w => w.id === selected); if(child) void move(child, workspace.id); }}>加入</button></div>
    {choosing && <ExpertPickerDialog title="选择小队成员" selectedId={selected} allowedIds={candidates.map(w => w.id)} onClose={() => setChoosing(false)} onPick={id => { setSelected(id); setChoosing(false); }} />}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <AgentAdvancedSettings key={workspace.id} workspace={workspace} section="relations" inline />
  </div>;
}

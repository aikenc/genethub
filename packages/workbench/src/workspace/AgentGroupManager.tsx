import { useState } from "react";
import type { WorkspaceInfo } from "@genehub/proto";
import type { AgentGroup } from "./agentGroups";
import { AgentGroupEditor } from "./AgentGroupEditor";
import { WorkspaceDetailsDialog } from "./WorkspaceDetailsDialog";

/** All membership edits live on the Agent surface; conversations only filter. */
export function AgentGroupManager({ groups, workspaces, error, update, onClose }: {
  groups: AgentGroup[];
  workspaces: WorkspaceInfo[];
  error: string;
  update(mutate: (current: AgentGroup[]) => AgentGroup[]): boolean;
  onClose(): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) return <AgentGroupEditor key={editing} group={groups.find((g) => g.id === editing)} groups={groups} workspaces={workspaces} error={error}
    onSave={(saved) => update((current) => current.some((g) => g.id === saved.id) ? current.map((g) => g.id === saved.id ? saved : g) : [...current, saved])}
    onDelete={(id) => { if (update((current) => current.filter((g) => g.id !== id))) setEditing(null); }}
    onClose={() => setEditing(null)} />;
  return <WorkspaceDetailsDialog title="Agent 分组" onClose={onClose}>
    <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted">管理常驻 Agent，会话自动跟随分组。</p><button className="min-h-11 shrink-0 rounded-lg bg-accent px-3 text-sm text-white" onClick={() => setEditing("new")}>新建分组</button></div>
    <ul className="mt-3 divide-y divide-line">
      {groups.map((group) => <li key={group.id} className="flex min-w-0 items-center gap-3 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{group.name}</p><p className="text-xs text-muted">{group.workspaceIds.length} 个 Agent</p></div><button aria-label={`编辑 ${group.name}`} className="min-h-11 rounded-lg px-3 text-sm text-accent hover:bg-raised" onClick={() => setEditing(group.id)}>编辑</button></li>)}
    </ul>
    {!groups.length && <p className="py-8 text-center text-sm text-muted">还没有 Agent 分组，先创建一个并勾选成员。</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <p className="mt-3 text-xs text-muted">分组保存在当前浏览器，按机器分别保存。</p>
  </WorkspaceDetailsDialog>;
}

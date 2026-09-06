import { useState } from "react";
import type { WorkspaceInfo } from "@genehub/proto";
import type { AgentGroup } from "./agentGroups";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";

export function AgentGroupEditor({ group, groups, workspaces, error, onSave, onDelete, onClose }: {
  group?: AgentGroup;
  groups: AgentGroup[];
  workspaces: WorkspaceInfo[];
  error: string;
  onSave(group: AgentGroup): boolean;
  onDelete(id: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [agents, setAgents] = useState(group?.workspaceIds ?? []);
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const duplicate = groups.some((g) => g.id !== group?.id && g.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const valid = Boolean(name.trim()) && !duplicate;
  return <WorkspaceDetailsDialog title={group ? "编辑分组" : "新建分组"} onClose={onClose}>
    <label className="block font-medium">分组名称
      <input aria-label="分组名称" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：前端体验、本周跟进" className="mt-2 min-h-11 w-full rounded-lg border border-line bg-raised px-3" />
    </label>
    {duplicate && <p role="alert" className="mt-2 text-danger">已有同名分组，请换一个名称。</p>}
    <p className="mb-2 mt-5 font-medium">选择组内 Agent</p>
    <p className="mb-3 text-xs leading-5 text-muted">可多选，一个 Agent 可以属于多个分组。会话按所属 Agent 自动进入分组，子 Agent 需单独选择。</p>
    <input aria-label="搜索分组 Agent" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Agent" className="mb-2 min-h-11 w-full rounded-lg bg-raised px-3" />
    <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
      {workspaces.filter((w) => w.name.toLowerCase().includes(query.toLowerCase())).map((w) => <label key={w.id} className="flex min-h-11 items-center gap-3 border-b border-line px-3 last:border-0 hover:bg-raised">
        <input type="checkbox" checked={agents.includes(w.id)} onChange={(e) => setAgents((old) => e.target.checked ? [...old, w.id] : old.filter((id) => id !== w.id))} />
        <span className="min-w-0 truncate">{w.name}</span>
        {w.agentSpace?.parentWorkspaceId && <span className="ml-auto shrink-0 text-xs text-muted">子 Agent</span>}
      </label>)}
      {!workspaces.length && <p className="p-3 text-muted">暂无 Agent，可先创建空分组。</p>}
    </div>
    {agents.some((id) => !workspaces.some((w) => w.id === id)) && <p className="mt-2 text-xs text-muted">保留了暂不可用 Agent 的分组关系。</p>}
    <p className="mt-4 text-xs leading-5 text-muted">分组仅保存在当前浏览器，按设备分别保存。归档和删除会话不属于分组设置。</p>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    <div className="mt-5 flex items-center justify-end gap-2">
      {group && <button className="mr-auto min-h-11 px-3 text-danger" onClick={() => setConfirmDelete(true)}>删除分组</button>}
      <button className="min-h-11 rounded-lg px-4 hover:bg-raised" onClick={onClose}>取消</button>
      <button disabled={!valid} className="min-h-11 rounded-lg bg-accent px-4 text-white disabled:opacity-40" onClick={() => {
        if (onSave({ id: group?.id ?? crypto.randomUUID(), name: name.trim(), workspaceIds: agents })) onClose();
      }}>保存分组</button>
    </div>
    {confirmDelete && <div className="mt-3 rounded-lg border border-line p-3">
      <p>删除「{group?.name}」？Agent、会话和历史都会保留。</p>
      <div className="mt-2 flex justify-end gap-3"><button className="min-h-11 px-3" onClick={() => setConfirmDelete(false)}>保留分组</button><button className="min-h-11 px-3 text-danger" onClick={() => group && onDelete(group.id)}>确认删除分组</button></div>
    </div>}
  </WorkspaceDetailsDialog>;
}

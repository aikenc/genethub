import { EntityAvatar, EntityText } from "../ui/EntityIdentity";
import { ListSearch, listPrimaryAction } from "../ui/ListLayout";
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
    <p className="mb-2 mt-5 font-medium">选择组内专家</p>
    <p className="mb-3 text-xs leading-5 text-muted">可多选，一个专家可以属于多个分组。会话按所属专家自动进入分组，子专家需单独选择。</p>
    <ListSearch label="搜索分组专家" value={query} onChange={setQuery}/>
    <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-line">
      {workspaces.filter((w) => w.name.toLowerCase().includes(query.toLowerCase())).map((w) => <label key={w.id} className="entity-main flex items-center gap-3 border-b border-line px-3 last:border-0 hover:bg-raised">
        <input type="checkbox" checked={agents.includes(w.id)} onChange={(e) => setAgents((old) => e.target.checked ? [...old, w.id] : old.filter((id) => id !== w.id))} />
        <EntityAvatar id={w.id} name={w.name}/>
        <EntityText title={w.name} hint={w.root}><span className="truncate">{w.root}</span></EntityText>
      </label>)}
      {!workspaces.length && <p className="p-3 text-muted">暂无专家，可先创建空分组。</p>}
    </div>
    {agents.some((id) => !workspaces.some((w) => w.id === id)) && <p className="mt-2 text-xs text-muted">保留了暂不可用专家的分组关系。</p>}
    <p className="mt-4 text-xs leading-5 text-muted">分组仅保存在当前浏览器，按设备分别保存。归档和删除会话不属于分组设置。</p>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    <div className="mt-5 flex items-center justify-end gap-2">
      {group && <button className="mr-auto min-h-11 px-3 text-danger" onClick={() => setConfirmDelete(true)}>删除分组</button>}
      <button className="min-h-11 rounded-lg px-4 hover:bg-raised" onClick={onClose}>取消</button>
      <button disabled={!valid} className={listPrimaryAction} onClick={() => {
        if (onSave({ id: group?.id ?? crypto.randomUUID(), name: name.trim(), workspaceIds: agents })) onClose();
      }}>保存分组</button>
    </div>
    {confirmDelete && <div className="mt-3 rounded-lg border border-line p-3">
      <p>删除「{group?.name}」？专家、会话和历史都会保留。</p>
      <div className="mt-2 flex justify-end gap-3"><button className="min-h-11 px-3" onClick={() => setConfirmDelete(false)}>保留分组</button><button className="min-h-11 px-3 text-danger" onClick={() => group && onDelete(group.id)}>确认删除分组</button></div>
    </div>}
  </WorkspaceDetailsDialog>;
}

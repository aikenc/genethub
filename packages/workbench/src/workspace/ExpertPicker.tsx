import { ListGroupSelect, ListSearch } from "../ui/ListLayout";
import { useState } from "react";
import { useWorkbench } from "../session/store";
import { AgentList } from "./AgentList";
import { WorkspaceDetailsDialog } from "./WorkspaceDetailsDialog";
import { useAgentGroups } from "./agentGroups";

/** Shared expert selection: directory rows, personal group filters, no management actions. */
export function ExpertPicker({ selectedId, onPick, onClose, allowedIds, allowNone = false, noneLabel = "不限专家" }: {
  selectedId?: string; onPick(id: string): void; onClose?(): void; allowedIds?: string[]; allowNone?: boolean; noneLabel?: string;
}) {
  const { workspaces, sessions, client } = useWorkbench();
  const { groups, error } = useAgentGroups(client?.identity?.machineId ?? "");
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState("");
  const group = groups.find(g => g.id === groupId);
  return <section aria-label="选择专家" className="flex min-h-0 flex-col rounded-xl border border-line p-2">
    <ListSearch label="搜索专家" value={query} onChange={setQuery}/>
    <div className="my-2 flex"><ListGroupSelect label="专家分组筛选" allLabel="全部专家" value={group?.id ?? ""} groups={groups} onChange={setGroupId}/>{onClose && <button type="button" className="min-h-11 px-3 text-sm" onClick={onClose}>取消</button>}</div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {allowNone && <button type="button" className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => onPick("")}>{noneLabel}</button>}
    <div className="max-h-64 min-h-0 overflow-y-auto"><AgentList workspaces={workspaces} sessions={sessions} memberIds={(group?.workspaceIds ?? workspaces.map(w => w.id)).filter(id => !allowedIds || allowedIds.includes(id))} selectedId={selectedId} density="comfortable" actions={false} query={query} onPick={onPick} /></div>
  </section>;
}

/** Every expert choice uses the same modal, row presentation and group semantics. */
export function ExpertPickerDialog({ onClose, title = "选择专家", ...props }: {
  selectedId?: string; onPick(id: string): void; onClose(): void;
  allowedIds?: string[]; allowNone?: boolean; noneLabel?: string; title?: string;
}) {
  return <WorkspaceDetailsDialog title={title} onClose={onClose}><ExpertPicker {...props} /></WorkspaceDetailsDialog>;
}

import { useState } from "react";
import { useWorkbench } from "../session/store";
import { AgentList } from "./AgentList";
import { useAgentGroups } from "./agentGroups";

/** Shared expert selection: directory rows, personal group filters, no management actions. */
export function ExpertPicker({ selectedId, onPick, onClose }: {
  selectedId?: string; onPick(id: string): void; onClose?(): void;
}) {
  const { workspaces, sessions, client } = useWorkbench();
  const { groups, error } = useAgentGroups(client?.identity?.machineId ?? "");
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState("");
  const group = groups.find(g => g.id === groupId);
  return <section aria-label="选择专家" className="flex min-h-0 flex-col rounded-xl border border-line p-2">
    <div className="flex items-center gap-2">
      <input autoFocus type="search" aria-label="搜索专家" placeholder="搜索专家" value={query} onChange={e => setQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3 text-sm" />
      {onClose && <button type="button" className="min-h-11 px-3 text-sm" onClick={onClose}>取消</button>}
    </div>
    <select aria-label="专家分组筛选" value={group?.id ?? ""} onChange={e => setGroupId(e.target.value)} className="my-2 min-h-11 w-full rounded-lg bg-raised px-3 text-sm">
      <option value="">全部专家</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="max-h-64 min-h-0 overflow-y-auto"><AgentList workspaces={workspaces} sessions={sessions} memberIds={group?.workspaceIds ?? workspaces.map(w => w.id)} selectedId={selectedId} density="comfortable" actions={false} query={query} onPick={onPick} /></div>
  </section>;
}

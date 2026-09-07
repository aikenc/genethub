import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { Host, Endpoint } from "../host";
import type { ExtraTab } from "../shell/tabs";
import { useWorkbench } from "../session/store";
import { localValue, saveLocalValue } from "../session/localConversation";
import { useAgentGroups, type AgentGroup } from "./agentGroups";
import { AgentGroupManager } from "./AgentGroupManager";
import { AgentList } from "./AgentList";
import { OpenProject } from "./OpenProject";

export function WorkspaceBrowser({host, endpoint, deviceName, onNewSession, onDepthChange}: {
  host: Host; endpoint: Endpoint; deviceName: string; navigationKey: number; initialWorkspaceId?: string | null;
  extraTabs: ExtraTab[]; onSession(id: string): void; onNewSession(id: string | null, localId?: string): void;
  onExtra(tab: ExtraTab, workspaceId: string): void; onDepthChange?(detail: boolean): void;
}) {
  const {workspaces, sessions, client} = useWorkbench();
  const machine = client?.identity?.machineId ?? deviceName;
  const {groups, error: groupError, update: updateGroups} = useAgentGroups(machine);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [groupId, setGroupId] = useState(() => localValue<string>(`agent-directory-group:${machine}`) ?? "");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const group = groups.find(g => g.id === groupId);
  useEffect(() => { onDepthChange?.(false); }, [onDepthChange]);
  useEffect(() => { saveLocalValue(`agent-directory-group:${machine}`, groupId); }, [machine, groupId]);
  return <section className="flex h-full min-h-0 flex-col" aria-label="专家目录">
    <header className="shrink-0 border-b border-line p-4"><div className="mx-auto max-w-3xl"><AgentDirectoryToolbar host={host} endpoint={endpoint} query={query} onQuery={setQuery} searchOpen={searchOpen} onSearch={() => { setSearchOpen(v => !v); if (searchOpen) setQuery(""); }} groups={groups} groupId={group?.id ?? ""} onGroup={setGroupId} onManage={() => setGroupsOpen(true)} /></div></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="mx-auto max-w-3xl"><AgentList workspaces={workspaces} sessions={sessions} onPick={onNewSession} query={query} memberIds={group?.workspaceIds} deviceName={deviceName} /></div></div>
    {groupsOpen && <AgentGroupManager groups={groups} workspaces={workspaces} error={groupError} update={updateGroups} onClose={() => setGroupsOpen(false)} />}
  </section>;
}

function AgentDirectoryToolbar({ host, endpoint, query, onQuery, groups, groupId, onGroup, onManage, searchOpen, onSearch }: {
  searchOpen: boolean; onSearch(): void;
  host: Host; endpoint: Endpoint; query: string; onQuery(value: string): void;
  groups: AgentGroup[]; groupId: string; onGroup(value: string): void; onManage(): void;
}) {
  return <div aria-label="专家目录工具栏" className="space-y-2">
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" aria-label="搜索专家" aria-expanded={searchOpen} className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={onSearch}><Search size={18} /></button>
      <select aria-label="专家分组筛选" value={groupId} onChange={(e) => onGroup(e.target.value)} className="min-h-11 min-w-0 flex-1 truncate rounded-lg bg-transparent text-sm font-medium"><option value="">全部专家</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
      <button type="button" aria-label="管理专家分组" className="min-h-11 shrink-0 rounded-lg px-2 text-sm text-muted hover:bg-raised" onClick={onManage}>分组</button>
      <OpenProject host={host} endpoint={endpoint} />
    </div>
    {searchOpen && <label className="flex min-w-0 items-center gap-2 rounded-lg bg-raised px-3 text-muted"><Search size={16} className="shrink-0" /><input type="search" aria-label="搜索专家" placeholder="搜索专家" value={query} onChange={(e) => onQuery(e.target.value)} className="min-h-11 w-full min-w-0 bg-transparent text-sm outline-none" /></label>}
  </div>;
}

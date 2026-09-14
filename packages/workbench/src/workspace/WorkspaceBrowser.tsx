import { useEffect, useState } from "react";
import type { Host, Endpoint } from "../host";
import { useWorkbench } from "../session/store";
import { localValue, saveLocalValue } from "../session/localConversation";
import { useAgentGroups, type AgentGroup } from "./agentGroups";
import { AgentGroupManager } from "./AgentGroupManager";
import { AgentList } from "./AgentList";
import { OpenProject } from "./OpenProject";
import { ListHeader, ListScroll, ListToolbar, ListGroupSelect, ListSearch } from "../ui/ListLayout";

export function WorkspaceBrowser({host, endpoint, deviceName, onNewSession, selectedId}: {
  host: Host; endpoint: Endpoint; deviceName: string; selectedId?: string;
  onNewSession(id: string): void;
}) {
  const {workspaces, sessions, client} = useWorkbench();
  const machine = client?.identity?.machineId ?? deviceName;
  const {groups, error: groupError, update: updateGroups} = useAgentGroups(machine);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [groupId, setGroupId] = useState(() => localValue<string>(`agent-directory-group:${machine}`) ?? "");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const group = groups.find(g => g.id === groupId);
  useEffect(() => { saveLocalValue(`agent-directory-group:${machine}`, groupId); }, [machine, groupId]);
  return <section className="flex h-full min-h-0 flex-col" aria-label="专家目录">
    <ListHeader><AgentDirectoryToolbar host={host} endpoint={endpoint} query={query} onQuery={setQuery} searchOpen={searchOpen} onSearch={() => { setSearchOpen(v => !v); if (searchOpen) setQuery(""); }} groups={groups} groupId={group?.id ?? ""} onGroup={setGroupId} onManage={() => setGroupsOpen(true)} /></ListHeader>
    <ListScroll label="专家滚动区域"><AgentList selectedId={selectedId} workspaces={workspaces} sessions={sessions} onPick={onNewSession} query={query} memberIds={group?.workspaceIds} deviceName={deviceName} /></ListScroll>
    {groupsOpen && <AgentGroupManager groups={groups} workspaces={workspaces} error={groupError} update={updateGroups} onClose={() => setGroupsOpen(false)} />}
  </section>;
}

function AgentDirectoryToolbar({ host, endpoint, query, onQuery, groups, groupId, onGroup, onManage, searchOpen, onSearch }: {
  searchOpen: boolean; onSearch(): void;
  host: Host; endpoint: Endpoint; query: string; onQuery(value: string): void;
  groups: AgentGroup[]; groupId: string; onGroup(value: string): void; onManage(): void;
}) {
  return <div aria-label="专家目录工具栏" className="space-y-2">
    <ListToolbar label="专家导航工具栏" searchLabel="搜索专家" searchOpen={searchOpen} onSearch={onSearch}>
      <ListGroupSelect label="专家分组筛选" allLabel="全部专家" value={groupId} groups={groups} onChange={onGroup}/>
      <OpenProject host={host} endpoint={endpoint} />
    </ListToolbar>
    <div className="flex min-h-9 items-center justify-end"><button type="button" aria-label="管理专家分组" className="min-h-9 rounded-lg px-2 text-xs text-muted hover:bg-raised" onClick={onManage}>管理分组</button></div>
    {searchOpen && <ListSearch label="搜索专家" value={query} onChange={onQuery} onClose={onSearch}/>}

  </div>;
}

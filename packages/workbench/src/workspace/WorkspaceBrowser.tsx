import { useState } from "react";
import type { Host, Endpoint } from "../host";
import { useWorkbench } from "../session/store";
import { AgentList } from "./AgentList";
import { OpenProject } from "./OpenProject";
import { ListHeader, ListScroll, ListToolbar, ListSearch } from "../ui/ListLayout";

export function WorkspaceBrowser({host, endpoint, deviceName, onNewSession, selectedId}: {
  host: Host; endpoint: Endpoint; deviceName: string; selectedId?: string;
  onNewSession(id: string): void;
}) {
  const {workspaces, sessions} = useWorkbench();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  return <section className="flex h-full min-h-0 flex-col" aria-label="项目列表">
    <ListHeader><AgentDirectoryToolbar host={host} endpoint={endpoint} query={query} onQuery={setQuery} searchOpen={searchOpen} onSearch={() => { setSearchOpen(v => !v); if (searchOpen) setQuery(""); }} /></ListHeader>
    <ListScroll label="项目列表滚动区域"><AgentList selectedId={selectedId} workspaces={workspaces} sessions={sessions} onPick={onNewSession} query={query} deviceName={deviceName} /></ListScroll>
  </section>;
}

function AgentDirectoryToolbar({ host, endpoint, query, onQuery, searchOpen, onSearch }: {
  searchOpen: boolean; onSearch(): void;
  host: Host; endpoint: Endpoint; query: string; onQuery(value: string): void;
}) {
  return <div aria-label="项目列表工具栏" className="space-y-2">
    <ListToolbar label="项目导航工具栏" searchLabel="搜索项目" searchOpen={searchOpen} onSearch={onSearch}>
      <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-fg">全部项目</span>
      <OpenProject host={host} endpoint={endpoint} />
    </ListToolbar>
    {searchOpen && <ListSearch label="搜索项目" value={query} onChange={onQuery} onClose={onSearch}/>}

  </div>;
}

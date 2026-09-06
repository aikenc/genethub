import { useEffect, useMemo, useState } from "react";
import type { Host, Endpoint } from "../host";
import type { WorkspaceInfo } from "@genehub/proto";
import { useWorkbench } from "../session/store";
import { WorkspaceRow, RecentSessions } from "../shell/Sidebar";
import { buildAgentSpaceTree, type AgentSpaceTreeNode } from "./agent-space-tree";
import { FilesPanel } from "../files/FilesPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { OpenProject } from "./OpenProject";
import { ImportSessionsDialog } from "../session/ImportSessionsDialog";
import type { ExtraTab } from "../shell/tabs";

/** Browse relationships without changing the active conversation or its draft. */
export function WorkspaceBrowser({ host, endpoint, navigationKey, deviceName, initialWorkspaceId, extraTabs, onSession, onNewSession, onExtra }: {
  host: Host;
  endpoint: Endpoint;
  navigationKey: number;
  deviceName: string;
  initialWorkspaceId?: string | null;
  extraTabs: ExtraTab[];
  onSession(id: string): void;
  onNewSession(id: string): void;
  onExtra(tab: ExtraTab, workspaceId: string): void;
}) {
  const { workspaces, sessions, activeSessionId, renameWorkspace, removeWorkspace, renameSession, deleteSession, client } = useWorkbench();
  const [selectedId, setSelectedId] = useState<string | null>(initialWorkspaceId ?? null);
  const [surface, setSurface] = useState("sessions");
  const [query, setQuery] = useState("");
  useEffect(() => { setSelectedId(initialWorkspaceId ?? null); setSurface("sessions"); setQuery(""); }, [initialWorkspaceId, navigationKey]);
  const [importOpen, setImportOpen] = useState(false);
  const [terminals, setTerminals] = useState<string[]>([]);
  const tree = useMemo(() => buildAgentSpaceTree(workspaces), [workspaces]);
  const nodes = useMemo(() => {
    const map = new Map<string, AgentSpaceTreeNode>();
    const visit = (node: AgentSpaceTreeNode) => { map.set(node.workspace.id, node); node.children.forEach(visit); };
    tree.roots.forEach(visit); tree.anomalies.forEach(visit); return map;
  }, [tree]);
  const node = selectedId ? nodes.get(selectedId) : undefined;
  const workspace = node?.workspace;
  const parents: WorkspaceInfo[] = [];
  let parent = workspace;
  while (parent && !parents.some((item) => item.id === parent!.id)) {
    parents.unshift(parent);
    parent = workspaces.find((item) => item.id === parent?.agentSpace?.parentWorkspaceId);
  }
  const browse = (id: string | null) => { setSelectedId(id); setSurface("sessions"); setQuery(""); };
  const visible = query.trim()
    ? [...nodes.values()].filter((item) => `${item.workspace.name} ${item.breadcrumb}`.toLowerCase().includes(query.trim().toLowerCase()))
    : node?.children ?? [...tree.roots, ...tree.anomalies];
  return <section className="flex h-full min-h-0 flex-col" aria-label="空间浏览">
    <header className="shrink-0 border-b border-line px-4 py-3 md:px-6">
      <p className="text-xs text-muted">{deviceName}</p>
      <nav aria-label="空间路径" className="mt-2 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="min-h-10 rounded-lg px-2 text-accent hover:bg-raised" onClick={() => browse(null)}>全部空间</button>
        {parents.map((item) => <span className="inline-flex min-w-0 items-center" key={item.id}><span aria-hidden className="text-faint">/</span><button type="button" className="min-h-10 max-w-64 truncate rounded-lg px-2 hover:bg-raised" onClick={() => browse(item.id)}>{item.name}</button></span>)}
      </nav>
      {workspace ? <div className="mt-2 flex flex-wrap gap-1" aria-label="空间工具">
        {[["sessions", "会话与子空间"], ["files", "文件"], ["changes", "变更"], ["terminal", "终端"]].map(([id, label]) => <button key={id} type="button" aria-pressed={surface === id} className={`min-h-10 rounded-lg px-3 text-sm ${surface === id ? "bg-raised text-accent" : "text-muted hover:bg-raised"}`} onClick={() => { setSurface(id!); if (id === "terminal") setTerminals((current) => current.includes(workspace.id) ? current : [...current, workspace.id]); }}>{label}</button>)}
        {extraTabs.filter((tab) => !tab.scope || tab.scope === "workspace").map((tab) => <button key={tab.id} type="button" className="min-h-10 rounded-lg px-3 text-sm text-muted hover:bg-raised" onClick={() => onExtra(tab, workspace.id)}>{tab.label}</button>)}
      </div> : null}
    </header>
    {surface === "sessions" ? <div className="min-h-0 flex-1 overflow-y-auto p-4 md:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex flex-wrap items-center gap-2"><input type="search" aria-label="搜索空间" placeholder="搜索名称或上级空间" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm" /><OpenProject host={host} endpoint={endpoint} /></div>
        {workspace ? <ul className="mb-4"><WorkspaceRow workspace={workspace} workspaces={workspaces} breadcrumb={node.breadcrumb} projectWorkspaceId={tree.projectRootById[workspace.id] ?? workspace.id} relationAnomaly={tree.anomalies.some((item) => item.workspace.id === workspace.id)} running={sessions.filter((item) => item.workspaceId === workspace.id && ["running", "waiting"].includes(item.status)).length} shut browse active deviceName={deviceName} onToggle={() => browse(workspace.id)} onPick={() => browse(workspace.id)} onRename={(name) => void renameWorkspace(workspace.id, name)} onRemove={() => removeWorkspace(workspace.id)}>{null}</WorkspaceRow></ul> : null}
        <h2 className="mb-2 text-sm font-medium">{query ? "搜索结果" : workspace ? `子空间 · ${visible.length}` : "选择一个空间"}</h2>
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="同级空间">
          {visible.map((item) => <WorkspaceRow key={item.workspace.id} workspace={item.workspace} workspaces={workspaces} breadcrumb={item.breadcrumb} projectWorkspaceId={tree.projectRootById[item.workspace.id] ?? item.workspace.id} relationAnomaly={tree.anomalies.some((entry) => entry.workspace.id === item.workspace.id)} running={sessions.filter((entry) => entry.workspaceId === item.workspace.id && ["running", "waiting"].includes(entry.status)).length} shut browse active={false} deviceName={deviceName} onToggle={() => browse(item.workspace.id)} onPick={() => browse(item.workspace.id)} onRename={(name) => void renameWorkspace(item.workspace.id, name)} onRemove={() => removeWorkspace(item.workspace.id)}><p className="px-3 pb-2 text-xs text-faint">{query ? item.breadcrumb : `${item.children.length} 个子空间 · ${sessions.filter((entry) => entry.workspaceId === item.workspace.id).length} 个会话`}</p></WorkspaceRow>)}
        </ul>
        {!visible.length ? <p className="py-4 text-sm text-muted">{query ? "没有匹配的空间" : "没有子空间"}</p> : null}
        {workspace && !query ? <div className="mt-6 border-t border-line pt-4"><div className="mb-3 flex items-center gap-2"><h2 className="mr-auto text-sm font-medium">这个空间的会话</h2><button type="button" className="min-h-10 rounded-lg px-3 text-sm text-accent hover:bg-raised" onClick={() => setImportOpen(true)}>导入</button><button type="button" className="min-h-10 rounded-lg bg-accent px-3 text-sm text-white" onClick={() => onNewSession(workspace.id)}>新会话</button></div><RecentSessions sessions={sessions.filter((item) => item.workspaceId === workspace.id).map((item) => ({ ...item, unread: false }))} workspaces={workspaces} activeSessionId={activeSessionId} onPickSession={onSession} onRename={(id, title) => void renameSession(id, title)} onDelete={(id) => void deleteSession(id)} /></div> : null}
      </div>
    </div> : null}
    {workspace && surface === "files" ? <div className="min-h-0 flex-1"><FilesPanel key={workspace.id} workspaceId={workspace.id} /></div> : null}
    {workspace && surface === "changes" ? <div className="min-h-0 flex-1"><ChangesPanel key={workspace.id} workspaceId={workspace.id} /></div> : null}
    {terminals.filter((id) => nodes.has(id)).map((id) => <div key={id} className={surface === "terminal" && id === workspace?.id ? "min-h-0 flex-1" : "hidden"}><TerminalPanel workspaceId={id} /></div>)}
    {importOpen && workspace && client ? <ImportSessionsDialog workspaceId={workspace.id} onClose={() => setImportOpen(false)} /> : null}
  </section>;
}

import { useCompleteSessionList } from "./useCompleteSessionList";
import { FilterBar } from "../ui/FilterBar";
import { usePageViewState } from "../app/usePageNavigation";
import { DetailBackButton } from "../ui/ListLayout";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MachineSummary } from "../protocol/summary-directory";
import type { Target } from "../host";
import type { Host, Endpoint } from "../host";
import { useWorkbench } from "./store";
import { pickPromptSuggestions } from "./prompt-suggestions";
import { ExpertPickerDialog } from "../workspace/ExpertPicker";
import { ExpertSquad } from "../workspace/ExpertSquad";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { MoreHorizontal } from "lucide-react";
import { AgentAvatar, AgentAvatarPicker } from "../workspace/AgentAvatar";
import { AgentDetails, ExpertDirectories, AgentDetailsEnvironment } from "../workspace/AgentDetails";
import { AgentAdvancedSettings } from "../workspace/AgentAdvancedSettings";
import { RecentSessions } from "../shell/ConversationRows";
import { useAgentActivities } from "../workspace/useAgentActivity";
import { hasUnreadReply, useConversationLocalChanges } from "./localConversation";
import { attentionFilters, hasCurrentWork, matchesAttention, pendingSessions, type AttentionFilter } from "./attention";
import { projectPinned, setProjectPinned, useProjectPreferences } from "../workspace/project-preferences";
import { ImportSessionsDialog } from "./ImportSessionsDialog";
import { FilesPanel } from "../files/FilesPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export const NEW_SESSION_WORKSPACE_PREVIEW_LIMIT = 4;
export const NEW_SESSION_PROJECT_PREVIEW_LIMIT = NEW_SESSION_WORKSPACE_PREVIEW_LIMIT;

/** The single expert home. The existing Composer remains owned by WorkbenchApp. */
export function NewSessionPanel({ endpoint, surface = "sessions", onSurface, onBack, nested = false, draftPicker = false, sources = [], onPickDraftProject, onOpenProject }: {
  onOpenProject?(machine: Target,workspaceId: string): void;
  draftPicker?: boolean; sources?: MachineSummary[]; onPickDraftProject?(machine: Target, workspaceId: string): void;
  host?: Host; endpoint?: Endpoint | null; surface?: string; onSurface?(value: string, nested?: boolean): void; onBack?(): void; nested?: boolean;
} = {}) {
  const wb = useWorkbench();
  const environment = useContext(AgentDetailsEnvironment);
  const workspace = wb.workspaces.find((w) => w.id === wb.draft?.workspaceId);
  const [allProjects, setAllProjects] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [name, setName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const viewKey = `expert:${wb.client?.identity?.machineId ?? ""}:${workspace?.id ?? ""}`;
  const [view, setView] = usePageViewState(viewKey, {historyQuery: "", showAll: false, archived: false, filter: "all" as AttentionFilter});
  const {historyQuery, showAll, archived, filter} = view;
  const setHistoryQuery = (historyQuery: string) => setView(old => ({...old, historyQuery}));
  const setShowAll = (next: boolean | ((value: boolean) => boolean)) => setView(old => ({...old, showAll: typeof next === "function" ? next(old.showAll) : next}));
  const setArchived = (next: boolean | ((value: boolean) => boolean)) => setView(old => ({...old, archived: typeof next === "function" ? next(old.archived) : next}));
  const setFilter = (filter: AttentionFilter) => setView(old => ({...old, filter}));
  const [scrollTop, setScrollTop] = usePageViewState(`${viewKey}:scroll:${surface}`, 0, 500);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = scrollTop; }, [workspace?.id, surface, scrollTop]);
  useConversationLocalChanges(); useProjectPreferences();
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  useEffect(() => { if (surface === "terminal" && workspace) setTerminalIds(ids => ids.includes(workspace.id) ? ids : [...ids.slice(-3), workspace.id]); }, [surface, workspace?.id]);
  const [importOpen, setImportOpen] = useState(false);
  const activity = useAgentActivities();
  const machine = wb.client?.identity?.machineId ?? "";
  const guidanceKey = workspace?.agentSpace?.guidance?.join("\n") ?? "";
  const suggestions = useMemo(() => pickPromptSuggestions(3, Math.random,
    guidanceKey ? guidanceKey.split("\n") : undefined), [workspace?.id, guidanceKey]);
  const sessionSurface = !draftPicker && (surface === "sessions" || surface === "attention" || surface === "activity");
  useEffect(() => {
    const filter = surface === "attention" || surface === "activity" ? "running" : null;
    if (filter && view.filter !== filter) setView(old => ({...old, showAll: true, archived: false, historyQuery: "", filter}));
  }, [surface, workspace?.id]);
  const owned = (activity.sessions ?? []).filter(s => s.workspaceId === workspace?.id);
  const candidates = filter === "pending" ? pendingSessions(owned, activity.sessions ?? []) : owned;
  useCompleteSessionList(sessionSurface && (showAll || archived || Boolean(historyQuery.trim())));
  useEffect(() => {
    if (sessionSurface && workspace?.agentSpace?.parentWorkspaceId && wb.client?.identity?.features?.includes("session.page.v1")) wb.expandSessionSpace(workspace.id, true);
  }, [sessionSurface, workspace?.id, wb.client]);
  const rows = candidates.filter((s) =>
    ((filter === "pending" || filter === "running") && hasCurrentWork(s, activity.sessions) || s.archived === archived) &&
    matchesAttention(s, filter, hasUnreadReply(machine, s), activity.sessions) &&
    `${s.title ?? ""} ${s.messagePreview?.text ?? ""}`.toLowerCase().includes(historyQuery.toLowerCase()))
    .sort((a, b) => (b.messagePreview?.atMs ?? b.updatedAtMs) - (a.messagePreview?.atMs ?? a.updatedAtMs) || a.id.localeCompare(b.id));
  const navigate = (id: string, child = false) => { setChoosing(false); environment?.onOverview?.(id, "sessions", child); };
  if (!workspace) return <p className="p-4 text-sm text-muted">请选择可用项目后开始会话。</p>;
  const setSurface = (value: string, nested = false) => onSurface?.(value, nested);
  const draftProjects = sources.flatMap(source => source.workspaces.filter(w => !w.agentSpace?.parentWorkspaceId).map(w => ({workspace:w,source})))
    .sort((a,b) => Number(b.workspace.id === workspace.id && b.source.target.deviceHandle === machine) - Number(a.workspace.id === workspace.id && a.source.target.deviceHandle === machine));
  return <section className="flex h-full min-h-0 flex-col" aria-label="项目页面">
    <header className="shrink-0 border-b border-line px-3 py-3 md:px-6" style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}>
      <div className="mx-auto flex max-w-4xl items-center gap-2">
        <DetailBackButton onClick={onBack} listVisible={!nested}/>
        <button type="button" aria-label="更换项目头像" className="shrink-0 rounded-lg" onClick={() => setAvatarOpen(true)}><AgentAvatar id={workspace.id} name={workspace.name} /></button>
        <div className="min-w-0 flex-1"><h1 aria-label={draftPicker ? "新会话" : workspace.name} className="truncate text-lg font-semibold">{draftPicker ? "新会话" : <button type="button" aria-label="重命名项目" title="点击修改项目名称" className="max-w-full truncate text-left hover:text-accent" onClick={() => { setName(workspace.name); setRenameError(""); setRenameOpen(true); }}>{workspace.name}</button>}</h1>
          <p className="mt-1 truncate text-xs text-muted">{endpoint?.label ?? "当前设备"}{workspace.builtin ? " · 内置项目" : ""}</p>
        </div>
        <button type="button" className="min-h-12 shrink-0 rounded-lg px-3 text-sm text-accent hover:bg-raised" onClick={() => setChoosing(v => !v)} aria-label="切换项目" aria-expanded={choosing}>切换</button>
      </div>
      {choosing && <ExpertPickerDialog title="切换项目" onCreate={environment?.onCreateExpert ? () => { setChoosing(false); environment.onCreateExpert?.(); } : undefined} selectedId={workspace.id} onPick={id => navigate(id)} onClose={() => setChoosing(false)} />}
      {!draftPicker && <nav className="relative mx-auto mt-2 max-w-4xl" aria-label="项目页签">
        <FilterBar navigation label="项目页面切换" options={[["sessions", "会话"], ["components", "组件"], ["directories", "目录"], ["children", "小队"]]}
          value={sessionSurface ? "sessions" : surface} onChange={id => { setMenuOpen(false); setSurface(id); }}
          actions={<button type="button" aria-label="项目菜单" aria-expanded={menuOpen} className="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => setMenuOpen(v => !v)}><MoreHorizontal size={20} /></button>} />
        {menuOpen && <><button type="button" aria-label="关闭项目菜单" className="fixed inset-0 z-20 cursor-default" onClick={() => setMenuOpen(false)} /><div role="menu" className="absolute right-0 top-full z-30 min-w-40 rounded-xl border border-line bg-bg p-1 shadow-lg"><button type="button" role="menuitem" className="block min-h-11 w-full rounded-lg px-4 text-left text-sm hover:bg-raised" onClick={() => { setProjectPinned(machine,workspace.id,!projectPinned(machine,workspace.id)); setMenuOpen(false); }}>{projectPinned(machine,workspace.id) ? "取消置顶" : "置顶项目"}</button>{[["history",showAll ? "最近会话" : "查看全部会话"],["import","导入会话"],["details","资料与头像"],["files","文件"],["changes","变更"],["terminal","终端"]].map(([id,label]) => <button key={id} type="button" role="menuitem" className="block min-h-11 w-full rounded-lg px-4 text-left text-sm hover:bg-raised" onClick={() => { setMenuOpen(false); if(id === "import") setImportOpen(true); else if (id === "history") { setShowAll(v => !v); setArchived(false); setHistoryQuery(""); setSurface("sessions"); } else setSurface(id!, true); }}>{label}</button>)}</div></>}
      </nav>}
    </header>
    <div ref={scroller} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} className={surface === "terminal" ? "hidden" : ["files", "changes"].includes(surface) ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"} key={`${workspace.id}:${surface}`}>
      <div className="mx-auto max-w-4xl">
        {draftPicker && <div className="mb-6">
          <p className="mb-3 text-sm text-muted">项目</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{(allProjects ? draftProjects : draftProjects.slice(0,4)).map(({workspace:project,source}) => <button key={`${source.target.id}:${project.id}`} disabled={!["ready","partial"].includes(source.state)} aria-pressed={project.id === workspace.id && source.target.deviceHandle === machine}
            className="flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-line px-3 py-2 text-left aria-pressed:border-accent aria-pressed:bg-accent/5 disabled:opacity-50" onClick={() => onPickDraftProject?.(source.target,project.id)}>
            <AgentAvatar id={project.id} name={project.name}/><span className="min-w-0"><span className="block truncate text-sm">{project.name}</span><span className="block truncate text-xs text-muted">{source.target.label}{source.state === "offline" ? " · 离线" : ""}</span></span>
          </button>)}</div>
          {draftProjects.length > 4 && <button className="mt-2 min-h-11 text-xs text-accent" onClick={() => setAllProjects(!allProjects)}>{allProjects ? "收起项目" : `更多项目（${draftProjects.length - 4}）`}</button>}
        </div>}

        {sessionSurface && <>
          <FilterBar<AttentionFilter> label="当前项目会话状态" options={attentionFilters} value={filter}
            onChange={id => { if (surface !== "sessions") setSurface("sessions"); setFilter(id); setShowAll(id !== "all"); setHistoryQuery(""); }} />
          {filter === "pending" && <p className="mb-2 text-xs text-muted">完整待办列表，包含仍有待办的归档会话；打开会话处理具体问题。</p>}
          {activity.error && activity.sessions && <p role="status" className="mb-2 text-xs text-muted">会话列表刷新失败，当前显示最近记录。</p>}
          {showAll && <div className="mb-3 flex gap-2"><input aria-label="搜索当前项目会话" placeholder="搜索会话" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3 text-sm"/>{filter !== "pending" && filter !== "running" && <button type="button" aria-pressed={archived} className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => setArchived(v => !v)}>{archived ? "返回未归档" : "已归档"}</button>}</div>}
          {wb.client?.identity?.features?.includes("session.page.v1") && (showAll || archived || historyQuery || filter !== "all") && !wb.sessionsComplete && <p role="status" className="py-2 text-xs text-muted">{wb.sessionsError ? "完整会话范围读取失败，请重试。" : "正在读取完整会话范围…"}</p>}
          {!activity.sessions ? <p role="status" className="py-6 text-sm text-muted">{activity.error ? "会话暂时无法读取，请检查连接后重试。" : "正在读取会话…"}</p> : <>
            <RecentSessions rowActions={false} sessions={(showAll || filter !== "all" ? rows : rows.slice(0,10)).map(s => ({...s, unread: hasUnreadReply(machine, s)}))} workspaces={wb.workspaces} activeSessionId={null} onPickSession={id => void wb.selectSession(id)} onRename={(id,title) => void wb.renameSession(id,title)} onDelete={id => void wb.deleteSession(id)} />
            {!rows.length && !(wb.client?.identity?.features?.includes("session.page.v1") && (showAll || archived || historyQuery || filter !== "all") && !wb.sessionsComplete) && <p className="py-6 text-center text-sm text-muted">{archived || historyQuery || filter !== "all" ? "没有匹配的会话" : "还没有会话，从下面开始吧"}</p>}
          </>}
        </>}
        {surface === "components" && <AgentAdvancedSettings key={workspace.id} workspace={workspace} section="components" inline />}
        {surface === "directories" && <><ExpertDirectories workspace={workspace} /><div className="mt-4 flex flex-wrap gap-2">{[["files","文件"],["changes","变更"],["terminal","终端"]].map(([id,label]) => <button type="button" key={id} className="min-h-11 rounded-lg border border-line px-4 text-sm" onClick={() => setSurface(id!, true)}>{label}</button>)}</div>{environment?.workspaceTools?.(workspace.id)}</>}
        {surface === "children" && <ExpertSquad key={workspace.id} workspace={workspace} sources={sources} onOpenRemote={onOpenProject} onOpen={id => navigate(id, true)} />}
        {surface === "details" && <AgentDetails workspace={workspace} deviceName={endpoint?.label ?? "当前设备"} compact />}
      </div>
      {surface === "files" && <FilesPanel workspaceId={workspace.id} />}
      {surface === "changes" && <ChangesPanel workspaceId={workspace.id} />}

    </div>
    {terminalIds.filter(id => wb.workspaces.some(w => w.id === id)).map(id => <div key={id} className={surface === "terminal" && workspace.id === id ? "min-h-0 flex-1" : "hidden"}><TerminalPanel workspaceId={id} /></div>)}
    {surface === "sessions" && <div role="region" aria-label="可以先问问" className="shrink-0 px-4 pb-2"><div className="mx-auto flex max-w-chat flex-wrap gap-2">{suggestions.map(s => <button type="button" key={s} className="min-h-9 shrink-0 rounded-full border border-line px-3 text-xs text-muted hover:text-fg" onClick={() => wb.appendComposerDraftLine(null, s)}>{s}</button>)}</div></div>}
    {avatarOpen && <WorkspaceDetailsDialog title="更换头像" onClose={() => setAvatarOpen(false)}><AgentAvatarPicker id={workspace.id} /></WorkspaceDetailsDialog>}
    {renameOpen && <WorkspaceDetailsDialog title="修改项目名称" onClose={() => { if (!renameBusy) setRenameOpen(false); }}>
      <label className="block text-sm">项目名称<input autoFocus aria-label="项目名称" maxLength={80} value={name} disabled={renameBusy} onChange={e => setName(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-line bg-raised px-3" /></label>
      {renameError && <p role="alert" className="mt-2 text-sm text-danger">{renameError}</p>}
      <button type="button" disabled={renameBusy || !name.trim()} className="mt-4 min-h-11 w-full rounded-lg bg-accent text-sm text-white disabled:opacity-40" onClick={async () => { setRenameBusy(true); setRenameError(""); try { await wb.renameWorkspace(workspace.id, name); setRenameOpen(false); } catch(e) { setRenameError(e instanceof Error ? e.message : "重命名失败"); } finally { setRenameBusy(false); } }}>{renameBusy ? "保存中…" : "保存名称"}</button>
    </WorkspaceDetailsDialog>}
    {importOpen && wb.client && <ImportSessionsDialog workspaceId={workspace.id} onClose={() => setImportOpen(false)} />}
  </section>;
}

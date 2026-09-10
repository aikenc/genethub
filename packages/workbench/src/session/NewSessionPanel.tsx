import { FilterBar } from "../ui/FilterBar";
import { usePageViewState } from "../app/usePageNavigation";
import { DetailBackButton } from "../ui/ListLayout";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ImportSessionsDialog } from "./ImportSessionsDialog";
import { FilesPanel } from "../files/FilesPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export const NEW_SESSION_WORKSPACE_PREVIEW_LIMIT = 4;
export const NEW_SESSION_PROJECT_PREVIEW_LIMIT = NEW_SESSION_WORKSPACE_PREVIEW_LIMIT;

/** The single expert home. The existing Composer remains owned by WorkbenchApp. */
export function NewSessionPanel({ endpoint, surface = "sessions", onSurface, onBack, nested = false }: {
  host?: Host; endpoint?: Endpoint | null; surface?: string; onSurface?(value: string, nested?: boolean): void; onBack?(): void; nested?: boolean;
} = {}) {
  const wb = useWorkbench();
  const environment = useContext(AgentDetailsEnvironment);
  const workspace = wb.workspaces.find((w) => w.id === wb.draft?.workspaceId);
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
  useConversationLocalChanges();
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  useEffect(() => { if (surface === "terminal" && workspace) setTerminalIds(ids => ids.includes(workspace.id) ? ids : [...ids.slice(-3), workspace.id]); }, [surface, workspace?.id]);
  const [importOpen, setImportOpen] = useState(false);
  const activity = useAgentActivities();
  const machine = wb.client?.identity?.machineId ?? "";
  const guidanceKey = workspace?.agentSpace?.guidance?.join("\n") ?? "";
  const suggestions = useMemo(() => pickPromptSuggestions(3, Math.random,
    guidanceKey ? guidanceKey.split("\n") : undefined), [workspace?.id, guidanceKey]);
  const sessionSurface = surface === "sessions" || surface === "attention" || surface === "activity";
  useEffect(() => {
    const filter = surface === "attention" ? "pending" : surface === "activity" ? "running" : null;
    if (filter && view.filter !== filter) setView(old => ({...old, showAll: true, archived: false, historyQuery: "", filter}));
  }, [surface, workspace?.id]);
  const owned = (activity.sessions ?? []).filter(s => s.workspaceId === workspace?.id);
  const candidates = filter === "pending" ? pendingSessions(owned, activity.sessions ?? []) : owned;
  const rows = candidates.filter((s) =>
    ((filter === "pending" || filter === "running") && hasCurrentWork(s, activity.sessions) || s.archived === archived) &&
    matchesAttention(s, filter, hasUnreadReply(machine, s), activity.sessions) &&
    `${s.title ?? ""} ${s.messagePreview?.text ?? ""}`.toLowerCase().includes(historyQuery.toLowerCase()))
    .sort((a, b) => (b.messagePreview?.atMs ?? b.updatedAtMs) - (a.messagePreview?.atMs ?? a.updatedAtMs) || a.id.localeCompare(b.id));
  const navigate = (id: string, child = false) => { setChoosing(false); environment?.onOverview?.(id, "sessions", child); };
  if (!workspace) return <p className="p-4 text-sm text-muted">请选择可用专家后开始会话。</p>;
  const setSurface = (value: string, nested = false) => onSurface?.(value, nested);
  return <section className="flex h-full min-h-0 flex-col" aria-label="专家页面">
    <header className="shrink-0 border-b border-line px-3 py-3 md:px-6" style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}>
      <div className="mx-auto flex max-w-4xl items-center gap-2">
        <DetailBackButton onClick={onBack} listVisible={!nested}/>
        <button type="button" aria-label="更换专家头像" className="shrink-0 rounded-lg" onClick={() => setAvatarOpen(true)}><AgentAvatar id={workspace.id} name={workspace.name} /></button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-lg font-semibold"><button type="button" aria-label="重命名专家" title="点击修改专家名称" className="max-w-full truncate text-left hover:text-accent" onClick={() => { setName(workspace.name); setRenameError(""); setRenameOpen(true); }}>{workspace.name}</button></h1>
          <p className="mt-1 truncate text-xs text-muted">{workspace.agentSpace?.components.filter(c => c.enabled).map(c => c.role ? `${c.componentId} · ${c.role}` : c.componentId).join(" / ") || (workspace.workspaceFile ? "多目录专家" : "目录专家")}</p>
        </div>
        <button type="button" className="min-h-12 shrink-0 rounded-lg px-3 text-sm text-accent hover:bg-raised" onClick={() => setChoosing(v => !v)} aria-label="切换专家" aria-expanded={choosing}>切换</button>
      </div>
      {choosing && <ExpertPickerDialog title="切换专家" selectedId={workspace.id} onPick={id => navigate(id)} onClose={() => setChoosing(false)} />}
      <nav className="relative mx-auto mt-2 max-w-4xl" aria-label="专家页签">
        <FilterBar navigation label="专家页面切换" options={[["sessions", "会话"], ["components", "组件"], ["directories", "目录"], ["children", "小队"]]}
          value={sessionSurface ? "sessions" : surface} onChange={id => { setMenuOpen(false); setSurface(id); }}
          actions={<button type="button" aria-label="专家菜单" aria-expanded={menuOpen} className="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => setMenuOpen(v => !v)}><MoreHorizontal size={20} /></button>} />
        {menuOpen && <><button type="button" aria-label="关闭专家菜单" className="fixed inset-0 z-20 cursor-default" onClick={() => setMenuOpen(false)} /><div role="menu" className="absolute right-0 top-full z-30 min-w-40 rounded-xl border border-line bg-bg p-1 shadow-lg">{[["history",showAll ? "最近会话" : "查看全部会话"],["import","导入会话"],["details","资料与头像"],["files","文件"],["changes","变更"],["terminal","终端"]].map(([id,label]) => <button key={id} type="button" role="menuitem" className="block min-h-11 w-full rounded-lg px-4 text-left text-sm hover:bg-raised" onClick={() => { setMenuOpen(false); if(id === "import") setImportOpen(true); else if (id === "history") { setShowAll(v => !v); setArchived(false); setHistoryQuery(""); setSurface("sessions"); } else setSurface(id!, true); }}>{label}</button>)}</div></>}
      </nav>
    </header>
    <div ref={scroller} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} className={surface === "terminal" ? "hidden" : ["files", "changes"].includes(surface) ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"} key={`${workspace.id}:${surface}`}>
      <div className="mx-auto max-w-4xl">
        {sessionSurface && <>
          <FilterBar<AttentionFilter> label="当前专家会话状态" options={attentionFilters} value={filter}
            onChange={id => { if (surface !== "sessions") setSurface("sessions"); setFilter(id); setShowAll(id !== "all"); setHistoryQuery(""); }} />
          {filter === "pending" && <p className="mb-2 text-xs text-muted">完整待办列表，包含仍有待办的归档会话；打开会话处理具体问题。</p>}
          {activity.error && activity.sessions && <p role="status" className="mb-2 text-xs text-muted">会话状态待同步，当前显示最近已知记录。</p>}
          {showAll && <div className="mb-3 flex gap-2"><input aria-label="搜索当前专家会话" placeholder="搜索会话" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3 text-sm"/>{filter !== "pending" && filter !== "running" && <button type="button" aria-pressed={archived} className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => setArchived(v => !v)}>{archived ? "返回未归档" : "已归档"}</button>}</div>}
          {!activity.sessions ? <p role="status" className="py-6 text-sm text-muted">{activity.error ? "会话暂时无法读取，请检查连接后重试。" : "正在读取会话…"}</p> : <>
            <RecentSessions sessions={(showAll || filter !== "all" ? rows : rows.slice(0,10)).map(s => ({...s, unread: hasUnreadReply(machine, s)}))} workspaces={wb.workspaces} activeSessionId={null} onPickSession={id => void wb.selectSession(id)} onRename={(id,title) => void wb.renameSession(id,title)} onDelete={id => void wb.deleteSession(id)} />
            {!rows.length && <p className="py-6 text-center text-sm text-muted">{archived || historyQuery || filter !== "all" ? "没有匹配的会话" : "还没有会话，从下面开始吧"}</p>}
          </>}
        </>}
        {surface === "components" && <AgentAdvancedSettings key={workspace.id} workspace={workspace} section="components" inline />}
        {surface === "directories" && <><ExpertDirectories workspace={workspace} /><div className="mt-4 flex flex-wrap gap-2">{[["files","文件"],["changes","变更"],["terminal","终端"]].map(([id,label]) => <button type="button" key={id} className="min-h-11 rounded-lg border border-line px-4 text-sm" onClick={() => setSurface(id!, true)}>{label}</button>)}</div>{environment?.workspaceTools?.(workspace.id)}</>}
        {surface === "children" && <ExpertSquad key={workspace.id} workspace={workspace} onOpen={id => navigate(id, true)} />}
        {surface === "details" && <AgentDetails workspace={workspace} deviceName={endpoint?.label ?? "当前设备"} compact />}
      </div>
      {surface === "files" && <FilesPanel workspaceId={workspace.id} />}
      {surface === "changes" && <ChangesPanel workspaceId={workspace.id} />}

    </div>
    {terminalIds.filter(id => wb.workspaces.some(w => w.id === id)).map(id => <div key={id} className={surface === "terminal" && workspace.id === id ? "min-h-0 flex-1" : "hidden"}><TerminalPanel workspaceId={id} /></div>)}
    {surface === "sessions" && <div className="shrink-0 px-4 pb-2"><div className="mx-auto flex max-w-chat gap-2 overflow-x-auto">{suggestions.map(s => <button type="button" key={s} className="min-h-9 shrink-0 rounded-full border border-line px-3 text-xs text-muted hover:text-fg" onClick={() => wb.appendComposerDraftLine(null, s)}>{s}</button>)}</div></div>}
    {avatarOpen && <WorkspaceDetailsDialog title="更换头像" onClose={() => setAvatarOpen(false)}><AgentAvatarPicker id={workspace.id} /></WorkspaceDetailsDialog>}
    {renameOpen && <WorkspaceDetailsDialog title="修改专家名称" onClose={() => { if (!renameBusy) setRenameOpen(false); }}>
      <label className="block text-sm">专家名称<input autoFocus aria-label="专家名称" maxLength={80} value={name} disabled={renameBusy} onChange={e => setName(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-line bg-raised px-3" /></label>
      {renameError && <p role="alert" className="mt-2 text-sm text-danger">{renameError}</p>}
      <button type="button" disabled={renameBusy || !name.trim()} className="mt-4 min-h-11 w-full rounded-lg bg-accent text-sm text-white disabled:opacity-40" onClick={async () => { setRenameBusy(true); setRenameError(""); try { await wb.renameWorkspace(workspace.id, name); setRenameOpen(false); } catch(e) { setRenameError(e instanceof Error ? e.message : "重命名失败"); } finally { setRenameBusy(false); } }}>{renameBusy ? "保存中…" : "保存名称"}</button>
    </WorkspaceDetailsDialog>}
    {importOpen && wb.client && <ImportSessionsDialog workspaceId={workspace.id} onClose={() => setImportOpen(false)} />}
  </section>;
}

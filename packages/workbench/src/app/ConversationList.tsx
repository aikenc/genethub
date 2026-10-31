import { FilterBar } from "../ui/FilterBar";
import { useEffect, useRef, useState } from "react";
import { ListFilter, MoreHorizontal, Plus } from "lucide-react";
import type { Host, Endpoint, Target } from "../host";
import { useWorkbench } from "../session/store";
import { useAgentActivities } from "../workspace/useAgentActivity";
import { attentionFilters, hasCurrentWork, matchesAttention, pendingSessions, type AttentionFilter } from "../session/attention";
import { matchesConversation, defaultConversationFilter, type ConversationFilter } from "../session/conversationFilters";
import { buildAgentSpaceTree, isDescendant } from "../workspace/agent-space-tree";
import { localValue, saveLocalValue, hasUnreadReply, useConversationLocalChanges } from "../session/localConversation";
import { RecentSessions } from "../shell/ConversationRows";
import { ListPane, ListHeader, ListScroll, ListToolbar, ListSearch, listPrimaryAction } from "../ui/ListLayout";
import { OpenProject } from "../workspace/OpenProject";
import { ExpertPickerDialog } from "../workspace/ExpertPicker";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";

type Props = {
  host: Host;
  endpoint?: Endpoint | null;
  open: boolean;
  hidden?: boolean;
  sessionOnly?: boolean;
  onPickTarget?(target: Target, endpoint: Endpoint): void;
  onOpenOverview?(): void;
  onNavigate(): void;
};
/** Device changes discard selection and editing state, never retarget queued actions. */
export function ConversationList(props: Props) {
  const machine = useWorkbench((state) => state.client?.identity?.machineId ?? "");
  return <ConversationListContent key={machine} {...props} machine={machine} />;
}

function ConversationListContent({ host, endpoint, open, hidden, onNavigate, onOpenOverview, machine }: Props & { machine: string }) {
  const wb = useWorkbench();
  const activity = useAgentActivities();
  useConversationLocalChanges();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const listMenuTrigger = useRef<HTMLButtonElement>(null);
  const [agentId, setAgentId] = useState(() => localValue<string>(`agent-filter-view:${machine}`) ?? "");
  useEffect(() => { if (machine) saveLocalValue(`agent-filter-view:${machine}`, agentId); }, [machine, agentId]);
  const selectedWorkspace = wb.workspaces.find((w) => w.id === agentId);
  const isChildWorkspace = Boolean(selectedWorkspace?.agentSpace?.parentWorkspaceId);
  const [choosingAgent, setChoosingAgent] = useState(false);
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [grouping, setGrouping] = useState<{ grouped: string[]; flat: string[] }>(() => {
    const saved = localValue<unknown>(`conversation-groups:${machine}`);
    const roots = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((root): root is string => typeof root === "string") : [];
    // The previous UI auto-saved [] even when nobody chose a layout. It cannot
    // express an explicit flat override, so keep its positive choices only.
    if (Array.isArray(saved)) return { grouped: roots(saved), flat: [] };
    const value = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
    return { grouped: roots(value.grouped), flat: roots(value.flat) };
  });
  useEffect(() => { if (machine) saveLocalValue(`conversation-groups:${machine}`, grouping); }, [machine, grouping]);
  const tree = buildAgentSpaceTree(wb.workspaces);
  const groupedProjectIds = new Set(tree.roots.filter(({ workspace, children }) =>
    !grouping.flat.includes(workspace.root) && (children.length > 0 || grouping.grouped.includes(workspace.root)))
    .map(node => node.workspace.id));
  const [ownership, setOwnership] = useState<ConversationFilter["ownership"]>("all");
  const [state, setState] = useState<AttentionFilter>("all");
  const [advanced, setAdvanced] = useState(false);
  const [managing, setManaging] = useState(false);
  const selectionScope = JSON.stringify([query, agentId, ownership, state, wb.includeArchived, grouping]);
  const [selectionState, setSelectionState] = useState({ scope: "", ids: new Set<string>() });
  const selected = selectionState.scope === selectionScope ? selectionState.ids : new Set<string>();
  const setSelected = (next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    setSelectionState((old) => ({ scope: selectionScope, ids: typeof next === "function" ? next(old.scope === selectionScope ? old.ids : new Set()) : next }));
  };
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const batchLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // A changed query is a new selection scope: hidden rows cannot stay selected.
  useEffect(() => { setConfirmArchive(false); }, [selectionScope]);
  const sources = wb.sessions.filter(
    (s) =>
      !agentId ||
      s.workspaceId === agentId ||
      isDescendant(wb.workspaces, s.workspaceId, agentId),
  );
  const candidates = state === "pending" ? pendingSessions(sources, wb.sessions) : sources;
  const rows = candidates.filter((s) => {
    const ws = wb.workspaces.find(w => w.id === s.workspaceId);
    const currentView = state === "pending" || state === "running" || state === "blocked";
    if (!matchesConversation(s, wb.workspaces, { ...defaultConversationFilter,
      ownership: isChildWorkspace || state === "pending" ? "all" : ownership,
      archived: currentView && hasCurrentWork(s, wb.sessions) ? Boolean(s.archived) : wb.includeArchived })) return false;
    if (!`${s.title} ${s.description ?? ""} ${s.labels?.join(" ") ?? ""} ${tree.breadcrumbById[s.workspaceId] ?? ws?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
    return matchesAttention(s, state, hasUnreadReply(machine, s), wb.sessions);
  }).map((s) => ({ ...s, unread: hasUnreadReply(machine, s) }));
  const visibleIds = new Set(rows.map((s) => s.id));
  const selection = new Set([...selected].filter((id) => visibleIds.has(id)));
  const toggle = (id: string) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const archive = async () => {
    if (batchLock.current) return;
    const client = wb.client;
    if (!client || wb.connection !== "ready") return;
    const targets = rows.filter((s) => selection.has(s.id));
    const archived = !wb.includeArchived;
    batchLock.current = true; setBusy(true); setConfirmArchive(false);
    let succeeded = 0;
    const failures: string[] = [];
    const failedIds = new Set<string>();
    // Bound writes and capture the original Client. Never retry an ambiguous write automatically.
    for (const session of targets) {
      if (!mounted.current || useWorkbench.getState().client !== client) break;
      if (session.unsupported || session.historyOnly) {
        failures.push(`${session.title || "新会话"}：只读或版本不兼容`); failedIds.add(session.id); continue;
      }
      try {
        const reply = await client.call({ type: "session.archive", payload: { sessionId: session.id, archived } });
        if (!reply || reply.type !== "session" || reply.data.id !== session.id || reply.data.archived !== archived) throw new Error("设备未确认归档结果");
        succeeded++;
      } catch (e) { failedIds.add(session.id); failures.push(`${session.title || "新会话"}：${e instanceof Error ? e.message : "结果未确认"}`); }
    }
    if (mounted.current && useWorkbench.getState().client === client) {
      await wb.refreshSessions();
      if (mounted.current) {
        setNotice(`${succeeded} 个会话已${archived ? "归档" : "恢复"}${failures.length ? `；${failures.length} 个未完成：${failures.join("；")}。请核对后再操作。` : "。"}`);
        setSelected(failedIds); setManaging(failures.length > 0); setBusy(false);
      }
    }
    batchLock.current = false;
  };
  const input = "min-h-10 min-w-0 rounded-lg border border-line bg-surface px-2 text-sm text-fg";
  return <ListPane label="会话列表" open={open} hidden={hidden}>
    <ListHeader>
      <fieldset disabled={busy} className="min-w-0 space-y-2 disabled:opacity-60">
        <ListToolbar label="会话导航工具栏" searchLabel="搜索会话" searchOpen={searchOpen} onSearch={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery(""); }}>
          <button type="button" aria-label="选择项目范围" onClick={() => setChoosingAgent(true)} className="min-h-11 min-w-0 flex-1 truncate rounded-lg px-2 text-left text-sm font-semibold text-fg hover:bg-raised">{selectedWorkspace?.name ?? "全部会话"}</button>
          <button type="button" aria-label="会话分组" aria-expanded={groupingOpen}
            onClick={() => setGroupingOpen(true)}
            className={`min-h-9 shrink-0 rounded-lg border px-2 text-xs font-medium ${groupedProjectIds.size ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-surface text-muted hover:bg-raised"}`}>分组</button>
          <button type="button" aria-label="新建会话" className={listPrimaryAction} onClick={() => { wb.newSession(agentId || null, null); onNavigate(); }}><Plus size={18} />新建</button>
        </ListToolbar>
        <FilterBar<AttentionFilter> label="会话状态工具栏" options={attentionFilters} value={state} onChange={setState} actions={<>
          <button type="button" aria-label="会话筛选" aria-expanded={advanced} className={`flex h-9 w-8 shrink-0 items-center justify-center ${agentId || ownership !== "all" ? "text-accent" : "text-muted"}`} onClick={() => setAdvanced(true)}><ListFilter size={16} /></button>
          <button ref={listMenuTrigger} type="button" aria-label="会话列表选项" aria-expanded={listMenuOpen} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => setListMenuOpen(!listMenuOpen)}><MoreHorizontal size={20} /></button>
        </>} />
        {searchOpen && <ListSearch label="搜索会话" value={query} onChange={setQuery} onClose={() => { setSearchOpen(false); setQuery(""); }}/>}
        {wb.includeArchived && state !== "pending" && state !== "running" && <div className="flex items-center justify-between text-xs text-muted"><span>已归档会话</span><button className="min-h-9 px-2 text-accent" onClick={() => { useWorkbench.setState({includeArchived: false}); void wb.refreshSessions(); }}>返回当前会话</button></div>}

      </fieldset>
      {listMenuOpen && <>
        <button type="button" aria-label="收起会话列表选项" className="fixed inset-0 z-40 cursor-default" onClick={() => setListMenuOpen(false)} />
        <div role="menu" aria-label="会话列表选项" className="absolute right-3 top-full z-50 w-40 rounded-xl border border-line bg-surface p-1 shadow-xl" onKeyDown={(e) => { if (e.key === "Escape") setListMenuOpen(false); }}>
          {onOpenOverview && <button type="button" role="menuitem" className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={()=>{listMenuTrigger.current?.focus();setListMenuOpen(false);onOpenOverview();}}>跨设备项目与会话</button>}
          <button type="button" role="menuitem" className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => { setListMenuOpen(false); setSearchOpen(true); }}>搜索会话</button>
          <button type="button" role="menuitem" disabled={busy} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => { setListMenuOpen(false); setManaging(!managing); setSelected(new Set()); }}>{managing ? "结束管理" : "管理列表"}</button>
          <button type="button" role="menuitem" disabled={busy} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => { setListMenuOpen(false); setState("all"); useWorkbench.setState({includeArchived: !wb.includeArchived}); void wb.refreshSessions(); }}>{wb.includeArchived ? "当前会话" : "已归档列表"}</button>
        </div>
      </>}
    </ListHeader>
    {activity.error && <p role="status" className="px-3 py-2 text-xs text-muted">会话状态待同步，当前显示最近已知记录。</p>}
    {state === "pending" && <p className="px-3 py-1 text-xs text-muted">包含可处理的内部及归档会话；每项可进入具体问题。</p>}
    {notice && <div role="status" className="flex max-h-[10%] shrink-0 gap-2 overflow-y-auto border-b border-line px-3 py-2 text-xs leading-5"><p className="min-w-0 flex-1 break-words">{notice}</p><button aria-label="关闭操作结果" className="h-8 w-8 shrink-0" onClick={() => setNotice("")}>×</button></div>}
    <ListScroll label="会话滚动区域">
      <RecentSessions sessions={rows} workspaces={wb.workspaces} activeSessionId={wb.activeSessionId}
        groupedProjectIds={groupedProjectIds}
        selection={managing ? { ids: selection, toggle, disabled: busy } : undefined}
        onPickSession={(id) => { void wb.selectSession(id); onNavigate(); }}
        onRename={(id, title) => void wb.renameSession(id, title)} onDelete={(id) => void wb.deleteSession(id)} />
      {!rows.length && <div className="px-4 py-8 text-center text-sm text-muted"><p>{query || agentId || state !== "all" || wb.includeArchived ? "没有匹配的会话" : "从一个项目开始会话"}</p></div>}
    </ListScroll>
    {managing && <footer aria-label="批量管理会话" className="max-h-[42%] shrink-0 space-y-2 overflow-y-auto border-t border-line bg-surface p-3">
      <p className="text-xs text-muted">已选 {selection.size} 条{busy ? " · 正在处理，请稍候…" : " · 切换筛选会清空选择"}</p>
      <div className="flex gap-2">
        <button disabled={busy || !rows.length} className="min-h-10 rounded-lg border border-line px-3 text-sm" onClick={() => setSelected(selection.size === rows.length ? new Set() : new Set(rows.map((s) => s.id)))}>{selection.size === rows.length && rows.length ? "取消全选" : "全选结果"}</button>
        <button disabled={busy || !selection.size || wb.connection !== "ready"} className="min-h-10 flex-1 rounded-lg border border-line text-sm disabled:opacity-40" onClick={() => setConfirmArchive(true)}>{wb.includeArchived ? "恢复所选" : "归档所选"}</button>
        <button disabled={busy} className="min-h-10 px-2 text-accent" onClick={() => { setManaging(false); setSelected(new Set()); }}>完成</button>
      </div>

    </footer>}
    {groupingOpen && <WorkspaceDetailsDialog title="会话分组" onClose={() => setGroupingOpen(false)}>
      <p className="mb-2 text-xs leading-5 text-muted">含子 Space 的项目默认分组，其他会话平铺。可按需调整，仅改变本浏览器上的展示。</p>
      <div className="space-y-1">{tree.roots.map(({ workspace }) => <label key={workspace.id} className="flex min-h-11 items-center gap-3 rounded px-2 text-sm hover:bg-raised">
        <input type="checkbox" aria-label={`按项目分组 ${workspace.name}`} checked={groupedProjectIds.has(workspace.id)}
          onChange={event => {
            const checked = event.target.checked;
            setGrouping(old => ({
              grouped: checked ? [...new Set([...old.grouped, workspace.root])] : old.grouped.filter(root => root !== workspace.root),
              flat: checked ? old.flat.filter(root => root !== workspace.root) : [...new Set([...old.flat, workspace.root])],
            }));
          }}
          className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" />
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      </label>)}</div>
      <button type="button" className="mt-3 min-h-11 w-full rounded-lg bg-accent text-sm text-white" onClick={() => setGroupingOpen(false)}>完成</button>
    </WorkspaceDetailsDialog>}
        {choosingAgent && <ExpertPickerDialog title="按项目筛选" selectedId={agentId} allowNone onClose={() => setChoosingAgent(false)} onPick={id => { setAgentId(id); setChoosingAgent(false); }} />}
        {advanced && <WorkspaceDetailsDialog title="筛选会话" onClose={() => setAdvanced(false)}><div className="grid gap-3">
          <div className="flex items-center gap-2 text-xs text-muted">项目<button type="button" aria-label="按项目筛选" className={`${input} min-w-0 flex-1 truncate text-left`} onClick={() => setChoosingAgent(true)}>{wb.workspaces.find(w => w.id === agentId)?.name ?? "所有项目"}</button></div>
          {!isChildWorkspace && <label className="flex items-center gap-2 text-xs text-muted">范围<select aria-label="会话范围" value={ownership} onChange={(e) => setOwnership(e.target.value as ConversationFilter["ownership"])} className={`${input} flex-1`}><option value="primary">主要会话（含等待与失败）</option><option value="children">子项目会话</option><option value="all">全部会话</option></select></label>}
          {isChildWorkspace && <p className="text-xs text-muted">当前已选定子 Space，直接展示该 Space 下的会话。</p>}
          <button className="min-h-9 text-xs text-accent" onClick={() => { setAgentId(""); setOwnership("all"); setState("all"); setQuery(""); }}>清除筛选</button>
          <button className="min-h-11 rounded-lg bg-accent text-white" onClick={() => setAdvanced(false)}>查看结果</button>
        </div></WorkspaceDetailsDialog>}
      {confirmArchive && <WorkspaceDetailsDialog title={wb.includeArchived ? "恢复会话" : "归档会话"} onClose={() => setConfirmArchive(false)}><div className="text-sm"><p>{wb.includeArchived ? "恢复" : "归档"}选中的 {selection.size} 个会话？会话历史保留，变更会保存到设备。</p><div className="mt-1 flex justify-end gap-2"><button className="min-h-9 px-2" onClick={() => setConfirmArchive(false)}>取消</button><button className="min-h-9 px-2 text-accent" onClick={() => void archive()}>确认{wb.includeArchived ? "恢复" : "归档"}</button></div></div></WorkspaceDetailsDialog>}
    {!wb.workspaces.length && endpoint && <OpenProject host={host} endpoint={endpoint} />}
  </ListPane>;
}

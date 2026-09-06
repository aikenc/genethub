import { useEffect, useRef, useState } from "react";
import { ListFilter, MoreHorizontal, Plus, Search } from "lucide-react";
import type { Host, Endpoint, Target } from "../host";
import { useWorkbench } from "../session/store";
import { matchesConversation, defaultConversationFilter, type ConversationFilter } from "../session/conversationFilters";
import { inAgentGroup, useAgentGroups } from "../workspace/agentGroups";
import { localValue, saveLocalValue } from "../session/localConversation";
import { RecentSessions } from "../shell/ConversationRows";
import { OpenProject } from "../workspace/OpenProject";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";

type Props = {
  host: Host;
  endpoint?: Endpoint | null;
  open: boolean;
  hidden?: boolean;
  sessionOnly?: boolean;
  onPickTarget?(target: Target, endpoint: Endpoint): void;
  onNavigate(): void;
};
/** Device changes discard selection and editing state, never retarget queued actions. */
export function ConversationList(props: Props) {
  const machine = useWorkbench((state) => state.client?.identity?.machineId ?? "");
  return <ConversationListContent key={machine} {...props} machine={machine} />;
}

function ConversationListContent({ host, endpoint, open, hidden, onNavigate, machine }: Props & { machine: string }) {
  const wb = useWorkbench();
  const [, refreshLocal] = useState(0);
  const { groups, error: groupError } = useAgentGroups(machine);
  const [groupId, setGroupId] = useState(() => localValue<string>(`agent-group-view:${machine}`) ?? "");
  useEffect(() => { if (machine) saveLocalValue(`agent-group-view:${machine}`, groupId); }, [machine, groupId]);
  const group = groups.find((g) => g.id === groupId);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [ownership, setOwnership] = useState<ConversationFilter["ownership"]>("primary");
  const [state, setState] = useState("all");
  const [advanced, setAdvanced] = useState(false);
  const [managing, setManaging] = useState(false);
  const selectionScope = JSON.stringify([query, agentId, ownership, state, groupId, wb.includeArchived]);
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
    const refresh = () => refreshLocal((n) => n + 1);
    window.addEventListener("genehub-conversation-local", refresh);
    return () => { mounted.current = false; window.removeEventListener("genehub-conversation-local", refresh); };
  }, []);
  useEffect(() => {
    if (wb.connection !== "ready" || busy) return;
    const timer = setInterval(() => void wb.refreshSessions(), 5000);
    return () => clearInterval(timer);
  }, [wb.connection, wb.refreshSessions, busy]);
  // A changed query is a new selection scope: hidden rows cannot stay selected.
  useEffect(() => { setConfirmArchive(false); }, [selectionScope]);
  const rows = wb.sessions.filter((s) => {
    // Explicit Agent/group membership may reveal an internal conversation; the default inbox never does.
    const explicit = Boolean(group || agentId);
    if (!matchesConversation(s, wb.workspaces, { ...defaultConversationFilter, ownership: explicit ? "all" : ownership, archived: wb.includeArchived })) return false;
    if (group && !inAgentGroup(s, group)) return false;
    if (agentId && s.workspaceId !== agentId) return false;
    if (!`${s.title} ${wb.workspaces.find((w) => w.id === s.workspaceId)?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
    const unread = Boolean(s.messagePreview && localValue(`read:${machine}:${s.id}`) !== s.messagePreview.itemId);
    return state === "all" || (state === "unread" ? unread : state === "blocked" ? ["waiting", "failed"].includes(s.status) : s.status === "running");
  }).map((s) => ({ ...s, unread: Boolean(s.messagePreview && localValue(`read:${machine}:${s.id}`) !== s.messagePreview.itemId) }));
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
      if (session.unsupported || session.managed?.userInteraction === "readOnly") {
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
  return <aside aria-label="会话列表" className={`${hidden ? "hidden" : open ? "flex" : "hidden md:flex"} min-h-0 w-full flex-1 flex-col overflow-hidden border-r border-line bg-sidebar md:w-80 md:flex-none`}>
    <header className="relative shrink-0 border-b border-line px-3 pb-2 pt-3">
      <fieldset disabled={busy} className="min-w-0 space-y-2 disabled:opacity-60">
        <div aria-label="会话导航工具栏" className="flex min-h-11 min-w-0 items-center gap-2">
          <button type="button" aria-label="搜索会话" aria-expanded={searchOpen} className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery(""); }}><Search size={18} /></button>
          <select aria-label="按 Agent 分组" value={group?.id ?? ""} onChange={(e) => { setGroupId(e.target.value); setAgentId(""); }} className="min-h-11 min-w-0 flex-1 truncate rounded-lg bg-transparent text-sm font-semibold text-fg">
            <option value="">全部 Agent</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <button type="button" aria-label="新建会话" className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-white" onClick={() => { wb.newSession(agentId || (group?.workspaceIds.length === 1 ? group.workspaceIds[0] : null), null); onNavigate(); }}><Plus size={18} />新建</button>
        </div>
        <div aria-label="会话状态工具栏" className="flex min-w-0 items-center gap-1 text-xs">
          {([["all", "全部"], ["blocked", "受阻"], ["unread", "未读"], ["running", "运行"]] as const).map(([id, label]) => <button key={id} aria-pressed={state === id} onClick={() => setState(id)} className={`min-h-9 flex-1 rounded-lg px-1 ${state === id ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-raised"}`}>{label}</button>)}
          <button type="button" aria-label="会话筛选" aria-expanded={advanced} className={`flex h-9 w-8 shrink-0 items-center justify-center ${agentId || ownership !== "primary" ? "text-accent" : "text-muted"}`} onClick={() => setAdvanced(true)}><ListFilter size={16} /></button>
          <button type="button" aria-label="会话列表选项" aria-expanded={listMenuOpen} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => setListMenuOpen(!listMenuOpen)}><MoreHorizontal size={20} /></button>
        </div>
        {searchOpen && <div className="flex items-center gap-2 rounded-lg bg-raised px-3">
          <input autoFocus type="search" aria-label="搜索会话" placeholder="搜索当前列表" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-10 w-full min-w-0 bg-transparent text-sm outline-none" />
          <button type="button" aria-label="关闭搜索" className="h-10 w-8 shrink-0 text-muted" onClick={() => { setSearchOpen(false); setQuery(""); }}>×</button>
        </div>}
        {wb.includeArchived && <div className="flex items-center justify-between text-xs text-muted"><span>已归档会话</span><button className="min-h-9 px-2 text-accent" onClick={() => { useWorkbench.setState({includeArchived: false}); void wb.refreshSessions(); }}>返回当前会话</button></div>}

      </fieldset>
      {listMenuOpen && <>
        <button type="button" aria-label="收起会话列表选项" className="fixed inset-0 z-40 cursor-default" onClick={() => setListMenuOpen(false)} />
        <div role="menu" aria-label="会话列表选项" className="absolute right-3 top-full z-50 w-40 rounded-xl border border-line bg-surface p-1 shadow-xl" onKeyDown={(e) => { if (e.key === "Escape") setListMenuOpen(false); }}>
          <button type="button" role="menuitem" className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => { setListMenuOpen(false); setSearchOpen(true); }}>搜索会话</button>
          <button type="button" role="menuitem" disabled={busy} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => { setListMenuOpen(false); setManaging(!managing); setSelected(new Set()); }}>{managing ? "结束管理" : "管理列表"}</button>
          <button type="button" role="menuitem" disabled={busy} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => { setListMenuOpen(false); useWorkbench.setState({includeArchived: !wb.includeArchived}); void wb.refreshSessions(); }}>{wb.includeArchived ? "当前会话" : "已归档列表"}</button>
        </div>
      </>}
    </header>
    {groupError && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-danger">{groupError}</p>}
    {notice && <div role="status" className="flex max-h-[10%] shrink-0 gap-2 overflow-y-auto border-b border-line px-3 py-2 text-xs leading-5"><p className="min-w-0 flex-1 break-words">{notice}</p><button aria-label="关闭操作结果" className="h-8 w-8 shrink-0" onClick={() => setNotice("")}>×</button></div>}
    <div aria-label="会话滚动区域" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
      <RecentSessions sessions={rows} workspaces={wb.workspaces} activeSessionId={wb.activeSessionId}
        selection={managing ? { ids: selection, toggle, disabled: busy } : undefined}
        onPickSession={(id) => { void wb.selectSession(id); onNavigate(); }}
        onRename={(id, title) => void wb.renameSession(id, title)} onDelete={(id) => void wb.deleteSession(id)} />
      {!rows.length && <div className="px-4 py-8 text-center text-sm text-muted"><p>{query || group || agentId || state !== "all" || wb.includeArchived ? "没有匹配的会话" : "从一个 Agent 开始会话"}</p>{group && <p className="mt-2 text-xs leading-5">可在 Agent 页管理此分组的成员。</p>}</div>}
    </div>
    {managing && <footer aria-label="批量管理会话" className="max-h-[42%] shrink-0 space-y-2 overflow-y-auto border-t border-line bg-surface p-3">
      <p className="text-xs text-muted">已选 {selection.size} 条{busy ? " · 正在处理，请稍候…" : " · 切换筛选会清空选择"}</p>
      <div className="flex gap-2">
        <button disabled={busy || !rows.length} className="min-h-10 rounded-lg border border-line px-3 text-sm" onClick={() => setSelected(selection.size === rows.length ? new Set() : new Set(rows.map((s) => s.id)))}>{selection.size === rows.length && rows.length ? "取消全选" : "全选结果"}</button>
        <button disabled={busy || !selection.size || wb.connection !== "ready"} className="min-h-10 flex-1 rounded-lg border border-line text-sm disabled:opacity-40" onClick={() => setConfirmArchive(true)}>{wb.includeArchived ? "恢复所选" : "归档所选"}</button>
        <button disabled={busy} className="min-h-10 px-2 text-accent" onClick={() => { setManaging(false); setSelected(new Set()); }}>完成</button>
      </div>

    </footer>}
        {advanced && <WorkspaceDetailsDialog title="筛选会话" onClose={() => setAdvanced(false)}><div className="grid gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">Agent<select aria-label="按 Agent 筛选" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={`${input} flex-1`}><option value="">所有 Agent</option>{wb.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          {!group && !agentId && <label className="flex items-center gap-2 text-xs text-muted">范围<select aria-label="会话范围" value={ownership} onChange={(e) => setOwnership(e.target.value as ConversationFilter["ownership"])} className={`${input} flex-1`}><option value="primary">主要会话</option><option value="children">子 Agent 会话</option><option value="all">全部会话</option></select></label>}
          {(group || agentId) && <p className="text-xs text-muted">仅查看明确选定的会话，包含选中的子 Agent。</p>}
          <button className="min-h-9 text-xs text-accent" onClick={() => { setAgentId(""); setOwnership("primary"); setState("all"); setQuery(""); }}>清除筛选</button>
          <button className="min-h-11 rounded-lg bg-accent text-white" onClick={() => setAdvanced(false)}>查看结果</button>
        </div></WorkspaceDetailsDialog>}
      {confirmArchive && <WorkspaceDetailsDialog title={wb.includeArchived ? "恢复会话" : "归档会话"} onClose={() => setConfirmArchive(false)}><div className="text-sm"><p>{wb.includeArchived ? "恢复" : "归档"}选中的 {selection.size} 个会话？会话历史保留，变更会保存到设备。</p><div className="mt-1 flex justify-end gap-2"><button className="min-h-9 px-2" onClick={() => setConfirmArchive(false)}>取消</button><button className="min-h-9 px-2 text-accent" onClick={() => void archive()}>确认{wb.includeArchived ? "恢复" : "归档"}</button></div></div></WorkspaceDetailsDialog>}
    {!wb.workspaces.length && endpoint && <OpenProject host={host} endpoint={endpoint} />}
  </aside>;
}

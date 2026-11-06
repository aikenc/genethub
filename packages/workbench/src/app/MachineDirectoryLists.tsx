import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, RefreshCw, Search, X } from "lucide-react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import type { Endpoint, Host, Target } from "../host";
import { MachineConnections } from "../protocol/machine-connections";
import { MachineSummaryDirectory, type MachineSummary, type SummaryDirectory } from "../protocol/summary-directory";
import { useWorkbench, workbenchForClient } from "../session/store";
import { hasUnreadReply, initializeReplyReads, useConversationLocalChanges } from "../session/localConversation";
import { matchesAttention, type AttentionFilter } from "../session/attention";
import { SessionStatusIcon } from "../shell/SessionStatusIcon";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { buildAgentSpaceTree } from "../workspace/agent-space-tree";
import { ListHeader, ListPane, ListScroll } from "../ui/ListLayout";
import { relativeTime } from "../ui/relativeTime";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";

const stateLabel = { deferred: "待同步", waiting: "待同步", loading: "同步中", ready: "在线", partial: "在线",
  offline: "离线", denied: "授权已撤销", timeout: "读取超时", unavailable: "暂不可用", notChecked: "未同步", rateLimited: "稍后重试" };
const keyOf = (machine: Target, id: string) => JSON.stringify([machine.deviceHandle ?? machine.id, id]);
const fresh = (source: MachineSummary) => source.state === "ready" || source.state === "partial";

/** One directory for both navigation surfaces; the machine selector never dials. */
export function MachineDirectoryLists({ connections, host, endpoint, section, open, hidden, onOpen, onNewSession, onAddProject }: {
  connections: MachineConnections; host: Host; endpoint: Endpoint; section: "sessions" | "projects";
  open: boolean; hidden: boolean;
  onOpen(machine: Target, sessionId?: string, workspaceId?: string): Promise<void>;
  onNewSession(): void; onAddProject(machine?: Target): void;
}) {
  const client = useWorkbench(state => state.client);
  const connection = useWorkbench(state => state.connection);
  const activeId = useWorkbench(state => state.activeSessionId);
  const liveSessions = useWorkbench(state => state.sessions);
  const liveWorkspaces = useWorkbench(state => state.workspaces);
  const sessionsChecked = useWorkbench(state => state.sessionsCheckedAtMs);
  useConversationLocalChanges();
  const [directory, setDirectory] = useState<SummaryDirectory>({ sources: [], checked: 0, complete: false });
  const [machineId, setMachineId] = useState("");
  const [searching, setSearching] = useState(false), [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filter, setFilter] = useState<AttentionFilter>("all");
  const [expanded, setExpanded] = useState(new Set<string>());
  const [internals, setInternals] = useState(new Set<string>());
  const [spaceFilters, setSpaceFilters] = useState<Record<string, string>>({});
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [managing, setManaging] = useState(false), [selection, setSelection] = useState(new Set<string>());
  const [confirming, setConfirming] = useState(false);
  const source = useRef<MachineSummaryDirectory>();
  const mounted = useRef(false), initialized = useRef(false), lock = useRef(false), refreshLock = useRef(false);
  const navigation = useRef(0);
  const refresh = useCallback(async () => {
    if (!source.current || lock.current || refreshLock.current) return;
    refreshLock.current = true; setRefreshing(true); setError("");
    try { await source.current.refresh(value => { if (mounted.current) setDirectory(value); }); }
    catch (e) { if (mounted.current && !(e instanceof DOMException && e.name === "AbortError")) setError("目录刷新未完成，请重试；已读取的内容保留。"); }
    finally { refreshLock.current = false; if (mounted.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; initialized.current = false;
    const current = new MachineSummaryDirectory({ targets: () => connections.targets(), openTarget: host.openTarget! }, { connections });
    source.current = current;
    return () => { mounted.current = false; navigation.current++; current.close(); source.current = undefined; };
  }, [connections, host]);
  useEffect(() => {
    if ((!client?.identity && connection !== "closed") || initialized.current) return;
    initialized.current = true; void refresh();
  }, [client, connection, refresh]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => { if (document.visibilityState === "visible" && initialized.current) void refresh(); }, 30_000);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  useEffect(() => { setSelection(new Set()); setConfirming(false); }, [machineId, query, filter, section, includeArchived]);

  // Fresh active-source facts can update immediately, without another query or
  // a second connection. Inactive/offline sources retain explicitly dated data.
  const sources = useMemo(() => directory.sources.map(row => {
    if (row.target.deviceHandle !== client?.identity?.machineId || client?.connectionState !== "ready" || row.state === "denied") return row;
    return { ...row, state: (["waiting", "loading", "deferred", "notChecked"].includes(row.state) && sessionsChecked ? "partial" : row.state) as MachineSummary["state"], version: client.identity?.daemonVersion ?? row.version, workspaces: liveWorkspaces.length ? liveWorkspaces : row.workspaces,
      sessions: [...new Map([...row.sessions, ...liveSessions].map(s => [s.id, s])).values()],
      updatedAt: sessionsChecked ? new Date(sessionsChecked).toISOString() : row.updatedAt };
  }), [directory, client, liveSessions, liveWorkspaces, sessionsChecked]);
  useEffect(() => {
    for (const row of directory.sources) if (fresh(row)) initializeReplyReads(row.target.deviceHandle ?? row.target.id, row.sessions);
  }, [directory]);
  const selectedSources = sources.filter(row => !machineId || row.target.id === machineId);
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const navigate = async (row: MachineSummary, sessionId?: string, workspaceId?: string) => {
    const generation = ++navigation.current;
    await run(async () => {
      if (generation !== navigation.current) return;
      await onOpen(row.target, sessionId, workspaceId);
    });
  };
  const workspacePage = async (row: MachineSummary, workspace: WorkspaceInfo, more = false) => {
    const key = keyOf(row.target, workspace.id);
    const page = await source.current!.workspacePage(row.target, workspace.id, more ? cursors[key] ?? null : null);
    if (mounted.current) setCursors(old => ({ ...old, [key]: page.nextCursor }));
  };
  const toggle = (key: string) => setSelection(old => { const next = new Set(old); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const batch = async () => run(async () => {
    setConfirming(false);
    let succeeded = 0;
    const failures: string[] = [];
    for (const row of selectedSources) {
      const entries = section === "projects" ? row.workspaces : row.sessions;
      for (const item of entries) {
        if (!selection.has(keyOf(row.target, item.id))) continue;
        if (!mounted.current) return;
        try {
          if (!fresh(row)) throw new Error("状态未确认，请先刷新");
          await connections.use(row.target, async target => {
            const state = workbenchForClient(target);
            if (section === "projects" && state) { await state.removeWorkspace(item.id); return; }
            const reply = section === "projects"
              ? await target.call({ type: "workspace.remove", payload: { workspaceId: item.id } })
              : await target.call({ type: "session.archive", payload: { sessionId: item.id, archived: !includeArchived } });
            if (section === "projects" ? reply?.type !== "workspaces" : reply?.type !== "session" || reply.data.archived === includeArchived) throw new Error("未收到确认，请核对后再操作");
          });
          succeeded++;
        } catch (e) { failures.push(`${"name" in item ? item.name : item.title}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    if (mounted.current) {
      setSelection(new Set());
      setError(`${succeeded} 项已${section === "projects" ? "移除" : includeArchived ? "恢复" : "归档"}${failures.length ? `；${failures.join("；")}` : ""}`);
      await source.current!.refresh(setDirectory);
      if (useWorkbench.getState().client) { await useWorkbench.getState().refreshWorkspaces(); await useWorkbench.getState().refreshSessions(); }
    }
  });
  const q = query.trim().toLocaleLowerCase();
  const rowButton = (row: MachineSummary, session: SessionSummary) => {
    if (Boolean(session.archived) !== includeArchived) return null;
    const workspace = row.workspaces.find(w => w.id === session.workspaceId);
    const key = keyOf(row.target, session.id);
    const unread = hasUnreadReply(row.target.deviceHandle ?? row.target.id, session);
    if (!`${session.title} ${session.description ?? ""} ${workspace?.name ?? ""}`.toLocaleLowerCase().includes(q) || !matchesAttention(session, filter, unread, row.sessions)) return null;
    return <li key={key} className="flex min-w-0 items-center gap-1">
      {managing && <input aria-label={`选择会话 ${session.title}`} type="checkbox" className="m-3 h-4 w-4" checked={selection.has(key)} onChange={() => toggle(key)} />}
      <button type="button" disabled={busy || !fresh(row)} aria-current={row.target.deviceHandle === client?.identity?.machineId && activeId === session.id ? "page" : undefined}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-raised disabled:opacity-60" onClick={() => void navigate(row, session.id)}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-xl [&_.entity-avatar]:h-[22px] [&_.entity-avatar]:w-[22px] [&_.entity-avatar]:text-base"><AgentAvatar id={workspace?.id ?? session.workspaceId} name={workspace?.name ?? "Space"} size="small" /></span>
        <span className="min-w-0 flex-1"><span className={`block truncate text-sm ${unread ? "font-semibold" : ""}`}>{session.title || "新会话"}</span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted"><span className="truncate">{workspace?.name ?? "Space"}</span><SessionStatusIcon session={session} sessions={row.sessions} unread={unread} stale={!fresh(row)} disconnected={!fresh(row)} /><span className="ml-auto shrink-0">{relativeTime(session.updatedAtMs)}</span></span>
        </span>
      </button>
    </li>;
  };
  return <ListPane label={section === "projects" ? "项目列表面板" : "会话列表"} open={open} hidden={hidden}>
    <ListHeader>
      <div className="flex min-h-11 min-w-0 items-center gap-1">
        {searching ? <><input autoFocus aria-label={`搜索${section === "projects" ? "项目" : "会话"}`} placeholder="搜索已加载内容" value={query} onChange={e => setQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-2 text-sm" /><button aria-label="关闭搜索" className="h-11 w-11 shrink-0" onClick={() => { setSearching(false); setQuery(""); }}><X size={18} /></button></> : <>
          <select aria-label="机器筛选" value={machineId} onChange={e => setMachineId(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-transparent text-sm font-semibold">
            <option value="">全部机器 · {sources.filter(fresh).length}/{sources.length} 在线</option>
            {sources.map(row => <option key={row.target.id} value={row.target.id}>{row.target.label} · {stateLabel[row.state]}{row.version ? ` · ${row.version}` : ""}</option>)}
          </select>
          <button aria-label="搜索列表" className="flex h-11 w-9 shrink-0 items-center justify-center" onClick={() => setSearching(true)}><Search size={18} /></button>
          <button aria-label="刷新列表" disabled={busy || refreshing} className="flex h-11 w-9 shrink-0 items-center justify-center disabled:opacity-40" onClick={() => void refresh()}><RefreshCw size={16} className={busy || refreshing ? "animate-spin" : ""} /></button>
          <button aria-label={section === "projects" ? "添加项目" : "新建会话"} className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white" onClick={() => {
            const selected = sources.find(row => row.target.id === machineId);
            if (section === "projects") onAddProject(selected?.target);
            else if (selected && selected.workspaces[0]) void navigate(selected, undefined, selected.workspaces.find(w => !w.agentSpace?.parentWorkspaceId)?.id ?? selected.workspaces[0].id);
            else onNewSession();
          }}><Plus size={18} /></button>
        </>}
      </div>
      <div className="flex flex-wrap items-center gap-1" aria-label="会话状态工具栏">
        {section === "sessions" && ([["all", "全部"], ["pending", "待你处理"], ["running", "进行中"], ["blocked", "受阻"], ["unread", "未读"]] as const).map(([id, text]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)} className={`min-h-10 rounded-lg px-2 text-xs ${filter === id ? "bg-accent/10 text-accent" : "text-muted"}`}>{text}</button>)}
        {section === "sessions" && <button disabled={busy} aria-pressed={includeArchived} className="min-h-10 px-2 text-xs text-muted" onClick={() => {
          const next = !includeArchived; setIncludeArchived(next); setCursors({}); source.current?.setIncludeArchived(next); void refresh();
        }}>{includeArchived ? "返回当前" : "已归档"}</button>}
        <button disabled={busy} aria-pressed={managing} onClick={() => { setManaging(!managing); setSelection(new Set()); }} className="ml-auto min-h-10 px-2 text-xs text-muted">{managing ? "完成" : "批量"}</button>
      </div>
      {error && <p role="status" className="max-h-24 overflow-y-auto break-words text-xs text-muted">{error}</p>}
      {(q || filter !== "all") && <p className="text-xs text-muted">已检索 {sources.filter(fresh).length}/{sources.length} 台机器的已加载记录，加载更早会话可扩大范围。</p>}
    </ListHeader>
    <ListScroll label={section === "projects" ? "项目列表滚动区域" : "会话滚动区域"}>
      {!sources.length && <p role="status" className="p-4 text-sm text-muted">正在读取机器目录…</p>}
      {selectedSources.flatMap(row => {
        const tree = buildAgentSpaceTree(row.workspaces);
        const roots = [...tree.roots, ...tree.anomalies];
        const groups = roots.map(({ workspace }) => {
          const key = keyOf(row.target, workspace.id);
          const direct = row.sessions.filter(s => s.workspaceId === workspace.id).sort((a,b) => b.updatedAtMs - a.updatedAtMs);
          const children = row.workspaces.filter(w => w.id !== workspace.id && tree.projectRootById[w.id] === workspace.id);
          const inside = row.sessions.filter(s => children.some(w => w.id === s.workspaceId)).sort((a,b) => b.updatedAtMs - a.updatedAtMs);
          const show = expanded.has(key) || q || filter !== "all";
          const internalOpen = internals.has(key) || q || filter !== "all";
          if (section === "projects" && !`${workspace.name} ${workspace.root}`.toLocaleLowerCase().includes(q)) return null;
          const matching = [...direct, ...inside].some(s => rowButton(row, s) !== null);
          if (section === "sessions" && (q || filter !== "all") && !matching) return null;
          return <section key={key} className="mb-2 min-w-0 rounded-xl" aria-label={`项目 ${workspace.name}`}>
            <div className="flex min-w-0 items-center">
              {managing && section === "projects" && <input aria-label={`选择项目 ${workspace.name}`} className="m-3 h-4 w-4" type="checkbox" checked={selection.has(key)} onChange={() => toggle(key)} />}
              <button type="button" disabled={busy} aria-expanded={section === "sessions" ? Boolean(show) : undefined} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-raised" onClick={() => {
                if (section === "projects") { void navigate(row, undefined, workspace.id); return; }
                const next = new Set(expanded); next.has(key) ? next.delete(key) : next.add(key); setExpanded(next);
                if (next.has(key) && fresh(row)) void run(() => workspacePage(row, workspace));
              }}>
                <AgentAvatar id={workspace.id} name={workspace.name} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{workspace.name}</span><span className="mt-1 block truncate text-xs text-muted">{row.target.label}{!fresh(row) ? ` · ${stateLabel[row.state]} · ${row.updatedAt ? `上次同步 ${relativeTime(Date.parse(row.updatedAt))}` : "状态未知"}` : ""}</span></span>
                {section === "sessions" && <ChevronDown size={16} className={`shrink-0 text-muted ${show ? "" : "-rotate-90"}`} />}
              </button>
            </div>
            {section === "sessions" && show && <>
              <ul>{direct.map(session => rowButton(row, session))}</ul>
              {cursors[key] && <button disabled={busy} className="min-h-11 w-full text-xs text-accent" onClick={() => void run(() => workspacePage(row, workspace, true))}>更早会话</button>}
              {!direct.length && fresh(row) && <button disabled={busy} className="min-h-11 w-full text-xs text-accent" onClick={() => void navigate(row, undefined, workspace.id)}>在此项目开始会话</button>}
              {children.length > 0 && <>
                <button aria-expanded={Boolean(internalOpen)} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs text-muted" onClick={() => { const next = new Set(internals); next.has(key) ? next.delete(key) : next.add(key); setInternals(next); }}><ChevronDown size={16} className={internalOpen ? "" : "-rotate-90"} />内部会话 · {children.length} 个 Space</button>
                {internalOpen && <>
                  <select aria-label={`${workspace.name} Space 筛选`} value={spaceFilters[key] ?? ""} onChange={e => { const value = e.target.value; setSpaceFilters(old => ({...old, [key]: value})); if (value) void run(() => workspacePage(row, children.find(w => w.id === value)!)); }} className="min-h-11 w-full min-w-0 rounded-lg bg-raised px-2 text-xs"><option value="">全部 Space</option>{children.map(w => <option key={w.id} value={w.id}>{w.name} · {row.target.label}</option>)}</select>
                  <ul>{inside.filter(s => !spaceFilters[key] || s.workspaceId === spaceFilters[key]).map(s => rowButton(row, s))}</ul>
                  {spaceFilters[key] && cursors[keyOf(row.target, spaceFilters[key]!)] && <button disabled={busy} className="min-h-11 w-full text-xs text-accent" onClick={() => void run(() => workspacePage(row, children.find(w => w.id === spaceFilters[key])!, true))}>更早内部会话</button>}
                </>}
              </>}
            </>}
          </section>;
        });
        return [...groups, row.nextCursor && section === "sessions" ? <button key={`${row.target.id}:more`} disabled={busy || !fresh(row)} className="min-h-11 w-full px-2 text-xs text-accent" onClick={() => void run(() => source.current!.loadMore(row.target))}>加载 {row.target.label} 的更早会话</button> : null,
          !fresh(row) ? <p key={`${row.target.id}:state`} role="status" className="px-3 py-2 text-xs text-muted">{row.target.label} · {stateLabel[row.state]}{row.updatedAt ? "，显示上次同步记录" : "，状态未知"}</p> : null];
      })}
    </ListScroll>
    {managing && <footer className="shrink-0 border-t border-line p-3"><button disabled={!selection.size || busy} onClick={() => setConfirming(true)} className="min-h-11 w-full rounded-lg border border-line text-sm disabled:opacity-40">{section === "projects" ? "移除" : includeArchived ? "恢复" : "归档"}所选 {selection.size} 项</button></footer>}
    {confirming && <WorkspaceDetailsDialog title={section === "projects" ? "移除所选项目" : includeArchived ? "恢复所选会话" : "归档所选会话"} onClose={() => setConfirming(false)}><p className="text-sm">{section === "projects" ? "只移除项目登记，保留磁盘文件；运行中的项目由设备拒绝。" : "会话历史保留，归档不会停止任务。"}</p><button className="mt-3 min-h-11 w-full rounded-lg bg-accent text-sm text-white" onClick={() => void batch()}>确认处理 {selection.size} 项</button></WorkspaceDetailsDialog>}
    <span className="sr-only">当前正文来自 {endpoint.label}</span>
  </ListPane>;
}

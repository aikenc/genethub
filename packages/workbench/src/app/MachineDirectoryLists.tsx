import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleHelp, MoreHorizontal, Plus, Search } from "lucide-react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import type { Endpoint, Host, Target } from "../host";
import { MachineConnections } from "../protocol/machine-connections";
import { MachineSummaryDirectory, type MachineSummary, type SummaryDirectory } from "../protocol/summary-directory";
import { useWorkbench, workbenchForClient } from "../session/store";
import { hasUnreadReply, initializeReplyReads, useConversationLocalChanges } from "../session/localConversation";
import { matchesAttention, type AttentionFilter } from "../session/attention";
import { SessionActivityIcons, SessionStatusIcon } from "../shell/SessionStatusIcon";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { projectPinned, useProjectPreferences } from "../workspace/project-preferences";
import { buildAgentSpaceTree } from "../workspace/agent-space-tree";
import { ListHeader, ListPane, ListScroll } from "../ui/ListLayout";
import { relativeTime } from "../ui/relativeTime";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { MachineFilter, machineReady as fresh, machineStateLabel as stateLabel } from "./MachineFilter";

const keyOf = (machine: Target, id: string) => JSON.stringify([machine.deviceHandle ?? machine.id, id]);
const latest = (s: SessionSummary) => s.messagePreview?.atMs ?? s.updatedAtMs;
const byTime = (a: SessionSummary, b: SessionSummary) => latest(b) - latest(a) || a.id.localeCompare(b.id);

/** A shared directory is a navigation surface, never a change to the active execution target. */
export function MachineDirectoryLists({ connections, host, endpoint, section, open, hidden, onOpen, onNewSession, onAddProject, onSources }: {
  connections: MachineConnections; host: Host; endpoint: Endpoint; section: "sessions" | "projects";
  open: boolean; hidden: boolean;
  onOpen(machine: Target, sessionId?: string, workspaceId?: string): Promise<void>;
  onSources?(sources: MachineSummary[]): void;
  onNewSession(machine?: Target, workspaceId?: string): void; onAddProject(machine?: Target): void;
}) {
  const client = useWorkbench(state => state.client), connection = useWorkbench(state => state.connection);
  const activeId = useWorkbench(state => state.activeSessionId);
  const liveSessions = useWorkbench(state => state.sessions), liveWorkspaces = useWorkbench(state => state.workspaces);
  const sessionsChecked = useWorkbench(state => state.sessionsCheckedAtMs);
  const observations = useWorkbench(state => state.sessionObservations);
  useConversationLocalChanges(); useProjectPreferences();
  const [directory, setDirectory] = useState<SummaryDirectory>({ sources: [], checked: 0, complete: false });
  const [machineId, setMachineId] = useState("");
  const [searching, setSearching] = useState(false), [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false), [filter, setFilter] = useState<AttentionFilter>("all");
  const [collapsed, setCollapsed] = useState(new Set<string>()), [internals, setInternals] = useState(new Set<string>());
  const [spaceFilters, setSpaceFilters] = useState<Record<string, string>>({});
  const [rootLimits, setRootLimits] = useState<Record<string, number>>({}), [innerLimits, setInnerLimits] = useState<Record<string, number>>({});
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [refreshing, setRefreshing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [managing, setManaging] = useState(false), [selection, setSelection] = useState(new Set<string>());
  const [confirming, setConfirming] = useState(false), [options, setOptions] = useState(false), [legend, setLegend] = useState(false);
  const [pinnedClosed, setPinnedClosed] = useState(false);
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
  const sources = useMemo(() => directory.sources.map(row => {
    if (row.target.deviceHandle !== client?.identity?.machineId || client?.connectionState !== "ready" || row.state === "denied") return row;
    return { ...row, state: (["waiting", "loading", "deferred", "notChecked"].includes(row.state) && sessionsChecked ? "partial" : row.state) as MachineSummary["state"], version: client.identity?.daemonVersion ?? row.version, workspaces: liveWorkspaces.length ? liveWorkspaces : row.workspaces,
      sessions: [...new Map([...row.sessions, ...liveSessions.filter(s => (observations[s.id] ?? 0) > (row.updatedAt ? Date.parse(row.updatedAt) : 0))].map(s => [s.id, s])).values()],
      updatedAt: sessionsChecked ? new Date(sessionsChecked).toISOString() : row.updatedAt };
  }), [directory, client, liveSessions, liveWorkspaces, sessionsChecked, observations]);
  useEffect(() => { onSources?.(sources); }, [sources,onSources]);
  useEffect(() => { for (const row of directory.sources) if (fresh(row)) initializeReplyReads(row.target.deviceHandle ?? row.target.id, row.sessions); }, [directory]);
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
    await run(async () => { if (generation === navigation.current) await onOpen(row.target, sessionId, workspaceId); });
  };
  const workspacePage = async (row: MachineSummary, workspace: WorkspaceInfo, more = false) => {
    const key = keyOf(row.target, workspace.id);
    const page = await source.current!.workspacePage(row.target, workspace.id, more ? cursors[key] ?? null : null);
    if (mounted.current) setCursors(old => ({ ...old, [key]: page.nextCursor }));
  };
  const loadInternals = async (row: MachineSummary, children: WorkspaceInfo[], more = false) => {
    let index = 0;
    const todo = children.filter(w => !more || cursors[keyOf(row.target, w.id)]);
    await Promise.all(Array.from({ length: Math.min(2, todo.length) }, async () => {
      while (index < todo.length && mounted.current) await workspacePage(row, todo[index++]!, more);
    }));
  };
  const q = query.trim().toLocaleLowerCase(), narrowed = Boolean(q || filter !== "all");
  const matches = (row: MachineSummary, s: SessionSummary) => {
    const workspace = row.workspaces.find(w => w.id === s.workspaceId);
    return Boolean(s.archived) === includeArchived && `${s.title} ${s.description ?? ""} ${workspace?.name ?? ""}`.toLocaleLowerCase().includes(q)
      && matchesAttention(s, filter, hasUnreadReply(row.target.deviceHandle ?? row.target.id, s), row.sessions);
  };
  const groups = selectedSources.flatMap(row => {
    const tree = buildAgentSpaceTree(row.workspaces);
    return [...tree.roots, ...tree.anomalies].map(({ workspace }) => {
      const key = keyOf(row.target, workspace.id);
      const children = row.workspaces.filter(w => w.id !== workspace.id && tree.projectRootById[w.id] === workspace.id);
      const direct = row.sessions.filter(s => s.workspaceId === workspace.id && matches(row, s)).sort(byTime);
      const inside = row.sessions.filter(s => children.some(w => w.id === s.workspaceId) && matches(row, s)).sort(byTime);
      const show = !collapsed.has(key) || narrowed, internalOpen = internals.has(key) || narrowed;
      const internalFilter = narrowed ? "" : spaceFilters[key];
      const childRows = inside.filter(s => !internalFilter || s.workspaceId === internalFilter).slice(0, innerLimits[key] ?? 10);
      return { row, workspace, key, children, direct, inside, show, internalOpen, childRows,
        pinned: projectPinned(row.target.deviceHandle ?? row.target.id, workspace.id, workspace.builtin === true),
        time: Math.max(0, ...direct.map(latest), ...inside.map(latest)) };
    });
  }).filter(g => section === "projects" ? `${g.workspace.name} ${g.workspace.root}`.toLocaleLowerCase().includes(q) : !narrowed || g.direct.length + g.inside.length > 0)
    .sort((a,b) => b.time - a.time || a.workspace.name.localeCompare(b.workspace.name));
  const flatRows = groups.filter(g => !g.children.length).flatMap(g => g.direct.map(session => ({ row: g.row, session }))).sort((a,b) => byTime(a.session,b.session));
  const visibleSessions = [...flatRows, ...groups.filter(g => g.children.length && g.show).flatMap(g => [
    ...g.direct.slice(0, rootLimits[g.key] ?? 5), ...(g.internalOpen ? g.childRows : []),
  ].map(session => ({ row: g.row, session })))];
  const selectable = section === "projects" ? groups.filter(g => !g.workspace.builtin && (!g.pinned || !pinnedClosed)).map(g => g.key)
    : visibleSessions.filter(({row,session}) => fresh(row) && !session.historyOnly && !session.unsupported).map(({row,session}) => keyOf(row.target, session.id));
  const chosen = new Set([...selection].filter(key => selectable.includes(key)));
  const toggle = (key: string) => setSelection(old => { const next = new Set(old); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const batch = async () => run(async () => {
    setConfirming(false);
    let succeeded = 0;
    const failures: string[] = [];
    for (const row of selectedSources) {
      for (const item of section === "projects" ? row.workspaces : row.sessions) {
        if (!chosen.has(keyOf(row.target, item.id))) continue;
        if (!mounted.current) return;
        try {
          if (!fresh(row)) throw new Error("状态未确认，请先刷新");
          await connections.use(row.target, async target => {
            const state = workbenchForClient(target);
            if (section === "projects" && state) { await state.removeWorkspace(item.id); return; }
            if (section === "sessions" && state) {
              if (!await state.archiveSession(item.id,!includeArchived)) throw new Error("未收到归档结果，请核对后再操作");
              return;
            }
            const reply = section === "projects" ? await target.call({ type: "workspace.remove", payload: { workspaceId: item.id } })
              : await target.call({ type: "session.archive", payload: { sessionId: item.id, archived: !includeArchived } });
            if (section === "projects" ? reply?.type !== "workspaces" : reply?.type !== "session" || reply.data.archived === includeArchived) throw new Error("未收到确认，请核对后再操作");
          });
          succeeded++;
        } catch (e) { failures.push(`${"name" in item ? item.name : item.title}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    if (mounted.current) {
      setSelection(new Set());
      await source.current!.refresh(value => { if (mounted.current) setDirectory(value); });
      if (useWorkbench.getState().client) { await useWorkbench.getState().refreshWorkspaces(); await useWorkbench.getState().refreshSessions(); }
      if (mounted.current) setError(`${succeeded} 项已${section === "projects" ? "移除" : includeArchived ? "恢复" : "归档"}${failures.length ? `；${failures.join("；")}` : ""}`);
    }
  });
  const rowButton = (row: MachineSummary, session: SessionSummary) => {
    const workspace = row.workspaces.find(w => w.id === session.workspaceId), key = keyOf(row.target, session.id);
    const unread = hasUnreadReply(row.target.deviceHandle ?? row.target.id, session);
    return <li key={key} className="conversation-row flex min-w-0 items-center gap-1">
      {managing && <input aria-label={`选择会话 ${session.title}`} type="checkbox" className="m-2 h-5 w-5 shrink-0" disabled={!fresh(row) || Boolean(session.historyOnly || session.unsupported)} checked={chosen.has(key)} onChange={() => toggle(key)} />}
      <button type="button" disabled={busy || !fresh(row) || Boolean(session.unsupported)} aria-current={row.target.deviceHandle === client?.identity?.machineId && activeId === session.id ? "page" : undefined}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-raised aria-[current=page]:bg-raised disabled:opacity-60" onClick={() => managing ? toggle(key) : void navigate(row, session.id)}>
        <AgentAvatar id={session.workspaceId} name={workspace?.name ?? "Space"} size="medium" />
        <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5">
          {unread && <span role="img" aria-label="有未读新回复" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold" : ""}`}>{session.title || "新会话"}</span>
          <time className="shrink-0 text-[10px] text-faint" dateTime={new Date(latest(session)).toISOString()}>{relativeTime(latest(session))}</time>
        </span><span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted"><span className="min-w-0 flex-1 truncate">{workspace && row.workspaces.some(w => w.agentSpace?.parentWorkspaceId === workspace.id) ? "前台" : workspace?.name ?? "Space"}{session.archived ? " · 已归档" : ""}{session.historyOnly ? " · 只读" : ""}</span>
          <SessionStatusIcon session={session} sessions={row.sessions} stale={!fresh(row)} disconnected={!fresh(row)} observedAtMs={row.updatedAt ? Date.parse(row.updatedAt) : 0} />
        </span></span>
      </button>
    </li>;
  };
  const moreRoot = async (g: typeof groups[number]) => {
    const limit = (rootLimits[g.key] ?? 5) + 5;
    if (g.direct.length < limit) await workspacePage(g.row, g.workspace, Boolean(cursors[g.key]));
    if (mounted.current) setRootLimits(old => ({...old,[g.key]:limit}));
  };
  const projectRow = (g: typeof groups[number]) => <section key={g.key} aria-label={`项目 ${g.workspace.name}`} className={section === "sessions" ? "project-session-group mb-2 min-w-0 rounded-xl border border-line bg-surface/50 p-1" : "mb-1 min-w-0"}>
    <div className="flex min-w-0 items-center">
      {managing && section === "projects" && <input aria-label={`选择项目 ${g.workspace.name}`} className="m-2 h-5 w-5 shrink-0" type="checkbox" disabled={g.workspace.builtin || !fresh(g.row)} checked={chosen.has(g.key)} onChange={() => toggle(g.key)} />}
      <button type="button" disabled={busy} aria-expanded={section === "sessions" ? g.show : undefined} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-raised" onClick={() => {
        if (section === "projects") { if (managing && !g.workspace.builtin) toggle(g.key); else if (!managing) void navigate(g.row, undefined, g.workspace.id); return; }
        const next = new Set(collapsed); next.has(g.key) ? next.delete(g.key) : next.add(g.key); setCollapsed(next); setSelection(new Set());
      }}>
        <AgentAvatar id={g.workspace.id} name={g.workspace.name} />
        <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{g.workspace.name}</span><span className="shrink-0 text-[10px] text-faint">{g.workspace.builtin ? "内置" : g.time ? relativeTime(g.time) : ""}</span></span>
          <span className="mt-1 flex min-w-0 items-center gap-2"><SessionActivityIcons sessions={g.row.sessions.filter(s => s.workspaceId === g.workspace.id || g.children.some(w => w.id === s.workspaceId))} partial={g.row.state === "partial" || Boolean(g.row.nextCursor)} stale={!fresh(g.row)} />
            <span className={`ml-auto min-w-0 truncate text-[11px] ${["offline","denied","timeout","unavailable","rateLimited"].includes(g.row.state) ? "text-danger" : "text-faint"}`}>{g.row.target.label}{!fresh(g.row) ? ` · ${stateLabel[g.row.state]}` : ""}</span>
          </span>
        </span>
        {section === "sessions" && <ChevronDown size={16} className={`shrink-0 text-muted ${g.show ? "" : "-rotate-90"}`} />}
      </button>
    </div>
    {section === "sessions" && g.show && <>
      {g.row.projectPages?.[g.workspace.id]?.error && <p role="status" className="p-2 text-xs text-muted">前台会话读取失败。<button className="ml-2 text-accent" onClick={() => void run(() => workspacePage(g.row,g.workspace))}>重试</button></p>}
      <ul>{g.direct.slice(0, rootLimits[g.key] ?? 5).map(s => rowButton(g.row, s))}</ul>
      {(g.direct.length > (rootLimits[g.key] ?? 5) || cursors[g.key] || g.row.projectPages?.[g.workspace.id]?.nextCursor) && <button disabled={busy} className="min-h-10 w-full text-xs text-accent" onClick={() => void run(() => moreRoot(g))}>更早前台会话</button>}
      {!g.direct.length && fresh(g.row) && !g.row.projectPages?.[g.workspace.id]?.error && <button disabled={busy} className="min-h-11 w-full text-xs text-accent" onClick={() => onNewSession(g.row.target, g.workspace.id)}>在此项目开始会话</button>}
      {g.children.length > 0 && <>
        <button aria-expanded={g.internalOpen} className="mt-1 flex min-h-11 w-full items-center gap-2 border-t border-line px-2 text-left text-xs text-muted" onClick={() => {
          const next = new Set(internals); next.has(g.key) ? next.delete(g.key) : next.add(g.key); setInternals(next); setSelection(new Set());
          if (next.has(g.key) && fresh(g.row)) void run(() => loadInternals(g.row, g.children));
        }}><ChevronDown size={16} className={`shrink-0 ${g.internalOpen ? "" : "-rotate-90"}`} /><span className="min-w-0 flex-1 truncate">团队内部 · {g.children.length} 个 Space</span><SessionActivityIcons sessions={g.inside} partial={g.row.state === "partial" || Boolean(g.row.nextCursor)} stale={!fresh(g.row)} /></button>
        {g.internalOpen && <>
          <select aria-label={`${g.workspace.name} Space 筛选`} value={spaceFilters[g.key] ?? ""} onChange={e => { const value = e.target.value; setSelection(new Set()); setSpaceFilters(old => ({...old, [g.key]: value})); if (value) void run(() => workspacePage(g.row, g.children.find(w => w.id === value)!)); }} className="my-1 min-h-10 w-full min-w-0 rounded-lg border border-line bg-surface px-2 text-xs"><option value="">全部 Space · {g.children.length}</option>{g.children.map(w => <option key={w.id} value={w.id}>{w.name} · {g.row.target.label}{!fresh(g.row) ? ` · ${stateLabel[g.row.state]}` : ""}</option>)}</select>
          <ul>{g.childRows.map(s => rowButton(g.row,s))}</ul>
          {!g.childRows.length && <p className="p-3 text-xs text-muted">{busy ? "正在读取内部会话…" : "没有匹配的会话"}</p>}
          {(g.inside.length > (innerLimits[g.key] ?? 10) || g.children.some(w => cursors[keyOf(g.row.target,w.id)])) && <button disabled={busy} className="min-h-11 w-full text-xs text-accent" onClick={() => void run(async () => {
            await loadInternals(g.row, spaceFilters[g.key] ? g.children.filter(w => w.id === spaceFilters[g.key]) : g.children, true);
            setInnerLimits(old => ({...old, [g.key]:(old[g.key] ?? 10)+10}));
          })}>更早内部会话</button>}
        </>}
      </>}
    </>}
  </section>;
  const changeArchived = () => {
    if (lock.current || refreshLock.current) return;
    const next = !includeArchived; setIncludeArchived(next); setCursors({}); source.current?.setIncludeArchived(next); setOptions(false); void refresh();
  };
  return <ListPane label={section === "projects" ? "项目列表面板" : "会话列表"} open={open} hidden={hidden}>
    <ListHeader>
      <div className="flex min-h-11 min-w-0 items-center gap-1">
        {searching ? <><input autoFocus aria-label={`搜索${section === "projects" ? "项目" : "会话"}`} placeholder="搜索会话、项目或 Space" value={query} onChange={e => setQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-2 text-sm" /><button aria-label="关闭搜索" className="min-h-11 shrink-0 px-2 text-xs" onClick={() => { setSearching(false); setQuery(""); }}>取消</button></> : <>
          <MachineFilter sources={sources} value={machineId} onChange={setMachineId} section={section} />
          <button aria-label="搜索列表" className="flex h-11 w-8 shrink-0 items-center justify-center text-muted" onClick={() => setSearching(true)}><Search size={18} /></button>
          <button disabled={busy} aria-pressed={managing} className="min-h-11 shrink-0 px-2 text-xs text-muted" onClick={() => { setManaging(!managing); setSelection(new Set()); }}>{managing ? "完成" : "批量"}</button>
          <button aria-label={section === "projects" ? "添加项目" : "新建会话"} disabled={busy} className="flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-lg bg-accent px-2 text-xs text-white" onClick={() => {
            const selected = sources.find(row => row.target.id === machineId);
            if (section === "projects") onAddProject(selected?.target); else onNewSession(selected?.target);
          }}><Plus size={16} />{section === "projects" ? "添加" : "新建"}</button>
        <button aria-label="列表选项" aria-expanded={options} className="flex h-9 w-8 shrink-0 items-center justify-center text-muted" onClick={() => setOptions(!options)}><MoreHorizontal size={18} /></button>
        </>}
      </div>
      {section === "sessions" && <div className="flex min-w-0 flex-wrap items-center gap-0.5" aria-label="会话状态工具栏">
        {section === "sessions" && ([["all", "全部"], ["pending", "待你处理"], ["running", "进行中"], ["blocked", "受阻"], ["unread", "未读"]] as const).map(([id, text]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)} className={`min-h-9 rounded-lg px-2 text-xs ${filter === id ? "bg-accent/10 text-accent" : "text-muted"}`}>{text}</button>)}
        <button aria-label="状态图标说明" className="ml-auto flex h-9 w-8 shrink-0 items-center justify-center text-muted" onClick={() => setLegend(true)}><CircleHelp size={16} /></button>
      </div>}
      {options && <><button aria-label="关闭列表选项" className="fixed inset-0 z-40 cursor-default" onClick={() => setOptions(false)} /><div role="menu" aria-label="列表选项" className="absolute right-3 top-full z-50 min-w-40 rounded-xl border border-line bg-surface p-1 shadow-xl">
        <button role="menuitem" disabled={busy || refreshing} className="min-h-11 w-full px-3 text-left text-sm" onClick={() => { setOptions(false); void refresh(); }}>{refreshing ? "刷新中…" : "刷新列表"}</button>
        {section === "sessions" && <button role="menuitem" disabled={busy || refreshing} className="min-h-11 w-full px-3 text-left text-sm" onClick={changeArchived}>{includeArchived ? "返回当前会话" : "查看已归档"}</button>}
      </div></>}
      {includeArchived && section === "sessions" && <button disabled={busy || refreshing} className="min-h-9 w-full text-left text-xs text-accent" onClick={changeArchived}>已归档会话 · 返回当前</button>}
      {error && <p role="status" className="max-h-24 overflow-y-auto break-words text-xs text-muted">{error}</p>}
      {narrowed && <p className="text-xs text-muted">已检索 {sources.filter(fresh).length}/{sources.length} 台机器的已加载记录；可加载更早会话扩大范围。</p>}
    </ListHeader>
    <ListScroll label={section === "projects" ? "项目列表滚动区域" : "会话滚动区域"}>
      {!sources.length && <p role="status" className="p-4 text-sm text-muted">正在读取机器目录…</p>}
      {section === "projects" ? <>
        {groups.some(g => g.pinned) && <><button aria-expanded={!pinnedClosed} className="flex min-h-10 w-full items-center gap-1 px-2 text-xs text-muted" onClick={() => { setPinnedClosed(!pinnedClosed); setSelection(new Set()); }}><ChevronDown size={14} className={pinnedClosed ? "-rotate-90" : ""} />置顶 · {groups.filter(g => g.pinned).length}</button>{!pinnedClosed && groups.filter(g => g.pinned).map(projectRow)}</>}
        {groups.some(g => !g.pinned) && <p className="px-2 py-2 text-xs text-faint">项目</p>}{groups.filter(g => !g.pinned).map(projectRow)}
      </> : <>
        {groups.filter(g => g.children.length).map(projectRow)}
        <ul aria-label="最近会话">{flatRows.map(({row,session}) => rowButton(row,session))}</ul>
        {!flatRows.length && !groups.some(g => g.children.length) && sources.some(fresh) && <p className="p-5 text-center text-sm text-muted">{narrowed || includeArchived ? "没有匹配的会话" : "从一个项目开始会话"}</p>}
      </>}
      {selectedSources.map(row => <div key={row.target.id}>
        {row.nextCursor && section === "sessions" && <button disabled={busy || !fresh(row)} className="min-h-11 w-full px-2 text-xs text-accent" onClick={() => void run(() => source.current!.loadMore(row.target))}>加载 {row.target.label} 的更早会话</button>}
        {!fresh(row) && <p role="status" className="px-3 py-2 text-xs text-muted">{row.target.label} · {stateLabel[row.state]}{row.updatedAt ? ` · 上次同步 ${relativeTime(Date.parse(row.updatedAt))}` : " · 状态未知"}</p>}
      </div>)}
    </ListScroll>
    {managing && <footer aria-label="批量操作" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line p-3">
      <button disabled={busy || !selectable.length} className="min-h-11 text-xs text-accent" onClick={() => setSelection(chosen.size === selectable.length ? new Set() : new Set(selectable))}>{chosen.size === selectable.length && chosen.size ? "取消全选" : "全选当前可见"}</button>
      <span className="min-w-0 flex-1 text-xs text-muted">已选 {chosen.size}</span>
      <button disabled={!chosen.size || busy} onClick={() => setConfirming(true)} className="min-h-11 rounded-lg border border-line px-3 text-sm disabled:opacity-40">{section === "projects" ? "移除" : includeArchived ? "恢复" : "归档"}</button>
    </footer>}
    {confirming && <WorkspaceDetailsDialog title={section === "projects" ? "移除所选项目" : includeArchived ? "恢复所选会话" : "归档所选会话"} onClose={() => setConfirming(false)}><p className="text-sm">{section === "projects" ? "只移除项目登记，保留磁盘文件；运行中的项目由设备拒绝。" : "会话历史保留，归档不会停止任务。"}</p><button className="mt-3 min-h-11 w-full rounded-lg bg-accent text-sm text-white" onClick={() => void batch()}>确认处理 {chosen.size} 项</button></WorkspaceDetailsDialog>}
    {legend && <WorkspaceDetailsDialog title="状态图标说明" onClose={() => setLegend(false)}><div className="space-y-3 text-sm"><p>手形：待你处理；警告：运行异常；转圈：Agent 处理中；圆圈：等待或协作进行中。</p><p>暂停：已暂停；协作：等待其他会话；收件箱：结果待处理；虚线圆：连接或协作状态待核对；圆点：未读。</p><p className="text-xs text-muted">主状态按上述顺序优先显示。≥ 表示已读取会话中的活动下限，继续加载历史可能发现更多；没有图标不代表项目空闲。离线时保留上次确认结果。</p></div></WorkspaceDetailsDialog>}
    <span className="sr-only">当前正文来自 {endpoint.label}</span>
  </ListPane>;
}

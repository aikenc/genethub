import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal, Pin, Plus, Search } from "lucide-react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import type { Endpoint, Target } from "../host";
import { MachineConnections } from "../protocol/machine-connections";
import { MachineSummaryDirectory, type MachineSummary, type SummaryDirectory } from "../protocol/summary-directory";
import { useWorkbench, workbenchForClient, adoptMachineActivity } from "../session/store";
import { hasUnreadReply, initializeReplyReads, useConversationLocalChanges } from "../session/localConversation";
import { hasCurrentWork, matchesAttention } from "../session/attention";
import { initialListViews, patchListView, projectFrontTime, projectSearchMatches, type ListViewState, type ListViews } from "../session/project-view";
import { isDefaultConversationSession } from "../session/conversationFilters";
import { sessionPinned, useSessionPreferences } from "../session/session-preferences";
import { orderSessionRows, splitPinnedSessions } from "../session/session-order";
import { SessionActivityIcons, SessionStatusIcon } from "../shell/SessionStatusIcon";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { projectPinned, useProjectPreferences } from "../workspace/project-preferences";
import { buildAgentSpaceTree } from "../workspace/agent-space-tree";
import { spaceKey as keyOf, memberSource, workspaceMembers } from "../workspace/members";
import { ListHeader, ListPane, ListScroll } from "../ui/ListLayout";
import { relativeTime } from "../ui/relativeTime";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { MachineFilter, machineReady as fresh, machineStateLabel as stateLabel } from "./MachineFilter";

const latest = (s: SessionSummary) => s.messagePreview?.atMs ?? s.updatedAtMs;

/** A shared directory is a navigation surface, never a change to the active execution target. */
/** `apply` removes projects or (un)archives sessions; the others are project-only. */
type BatchAction = "apply" | "terminate" | "resume";

// A member is resumed by its terminated ancestor, so ancestors go first.
function ancestorsFirst(workspaces: WorkspaceInfo[]) {
  const depth = (workspace: WorkspaceInfo) => {
    let count = 0;
    for (let parent = workspace.agentSpace?.parentWorkspaceId; parent && count < workspaces.length; count++) {
      parent = workspaces.find(candidate => candidate.id === parent)?.agentSpace?.parentWorkspaceId;
    }
    return count;
  };
  return [...workspaces].sort((left, right) => depth(left) - depth(right));
}

export function MachineDirectoryLists({ connections, directory:sharedDirectory, endpoint, section, open, hidden, onOpen, onNewSession, onAddProject, onSources }: {
  connections: MachineConnections; directory:MachineSummaryDirectory; endpoint: Endpoint; section: "sessions" | "projects";
  open: boolean; hidden: boolean;
  onOpen(machine: Target, sessionId?: string, workspaceId?: string, signal?: AbortSignal): Promise<void>;
  onSources?(sources: MachineSummary[]): void;
  onNewSession(machine?: Target, workspaceId?: string): void; onAddProject(machine?: Target): void;
}) {
  const client = useWorkbench(state => state.client), connection = useWorkbench(state => state.connection);
  const activeId = useWorkbench(state => state.activeSessionId);
  const liveSessions = useWorkbench(state => state.sessions), liveWorkspaces = useWorkbench(state => state.workspaces);
  const sessionsChecked = useWorkbench(state => state.sessionsCheckedAtMs);
  const observations = useWorkbench(state => state.sessionObservations);
  useConversationLocalChanges(); useProjectPreferences(); useSessionPreferences();
  const [directory, setDirectory] = useState<SummaryDirectory>({ sources: [], checked: 0, complete: false });
  const [machineId, setMachineId] = useState("");
  const [searching, setSearching] = useState(false);
  const [views, setViews] = useState<ListViews>(initialListViews);
  const { query, filter, includeArchived } = views[section];
  const patchView = (patch: Partial<ListViewState>) => setViews(old => patchListView(old, section, patch));
  const [projectFilter, setProjectFilter] = useState<"all" | "builtin" | "team">("all");
  const [refreshing, setRefreshing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [managing, setManaging] = useState(false), [selection, setSelection] = useState(new Set<string>());
  const [confirming, setConfirming] = useState<false | BatchAction>(false), [options, setOptions] = useState(false);
  const [pinnedClosed, setPinnedClosed] = useState(false), [sessionsPinnedClosed, setSessionsPinnedClosed] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState(new Set<string>());
  const [catalogVersion, setCatalogVersion] = useState(0);
  // A project's rank is captured once per catalogue refresh; paging older
  // sessions or internal member activity cannot reshuffle the visible rows.
  const rankCache = useRef({ version: -1, times: {} as Record<string, number> });
  const source = useRef<MachineSummaryDirectory>();
  const mounted = useRef(false), initialized = useRef(false), lock = useRef(false), refreshLock = useRef(false);
  // A request made during a refresh runs once afterwards instead of being dropped.
  const pendingRefresh = useRef<boolean | null>(null);
  const navigation = useRef(0);
  const navigationController = useRef<AbortController>();
  const refresh = useCallback(async (force = false) => {
    if (!source.current || lock.current) return;
    if (refreshLock.current) { pendingRefresh.current = Boolean(pendingRefresh.current) || force; return; }
    refreshLock.current = true; setRefreshing(true); setError("");
    try {
      for (let next: boolean | null = force; next !== null && source.current; next = pendingRefresh.current) {
        pendingRefresh.current = null;
        await source.current.refresh(undefined,undefined,undefined,next);
      }
      if (mounted.current) setCatalogVersion(v => v + 1);
    }
    catch (e) { if (mounted.current && !(e instanceof DOMException && e.name === "AbortError")) setError("目录刷新未完成，请重试；已读取的内容保留。"); }
    finally { refreshLock.current = false; pendingRefresh.current = null; if (mounted.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; initialized.current = false;
    const current = sharedDirectory;
    // Current and archived views share a bounded snapshot. Archived work that
    // still needs attention stays reachable without another transport query.
    current.setIncludeArchived(true);
    source.current = current;
    const stop = current.subscribe(value => {if (mounted.current) setDirectory(value);});
    return () => { mounted.current = false; navigation.current++; navigationController.current?.abort(); stop(); source.current = undefined; };
  }, [sharedDirectory]);
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
  useEffect(() => { setSelection(new Set()); setConfirming(false); }, [machineId, query, filter, projectFilter, section, includeArchived]);
  const sources = useMemo(() => directory.sources.map(row => {
    const activity = row.activeSessions ?? [];
    row = {...row, sessions: [...new Map([...row.sessions, ...activity].map(s => [s.id,s])).values()]};
    if (row.catalogRevision !== undefined) return row;
    if (row.target.deviceHandle !== client?.identity?.machineId || client?.connectionState !== "ready" || row.state === "denied") return row;
    return { ...row, state: (["waiting", "loading", "deferred", "notChecked"].includes(row.state) && sessionsChecked ? "partial" : row.state) as MachineSummary["state"], version: client.identity?.daemonVersion ?? row.version, workspaces: liveWorkspaces.length ? liveWorkspaces : row.workspaces,
      sessions: [...new Map([...row.sessions, ...liveSessions.filter(s => (observations[s.id] ?? 0) > (row.updatedAt ? Date.parse(row.updatedAt) : 0))].map(s => [s.id, s])).values()],
      updatedAt: sessionsChecked ? new Date(sessionsChecked).toISOString() : row.updatedAt };
  }), [directory, client, liveSessions, liveWorkspaces, sessionsChecked, observations]);
  useEffect(() => { onSources?.(sources); }, [sources,onSources]);
  useEffect(() => {
    const row = directory.sources.find(row => row.target.deviceHandle === client?.identity?.machineId);
    if (client && row && row.catalogRevision === undefined) adoptMachineActivity(client,row.activeSessions ?? [],Boolean(row.activityComplete));
  }, [directory,client]);
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
    if (lock.current) return;
    navigationController.current?.abort();
    const controller = new AbortController(); navigationController.current = controller;
    const generation = ++navigation.current;
    setError("");
    try { await onOpen(row.target, sessionId, workspaceId, controller.signal); }
    catch (e) { if (mounted.current && !controller.signal.aborted && generation === navigation.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  const q = query.trim().toLocaleLowerCase(), narrowed = Boolean(q || filter !== "all");
  const matches = (row: MachineSummary, s: SessionSummary) => {
    const workspace = row.workspaces.find(w => w.id === s.workspaceId);
    return (Boolean(s.archived) === includeArchived || !includeArchived && hasCurrentWork(s,row.sessions)) && `${s.title} ${s.description ?? ""} ${workspace?.name ?? ""}`.toLocaleLowerCase().includes(q)
      && matchesAttention(s, filter, hasUnreadReply(row.target.deviceHandle ?? row.target.id, s), row.sessions);
  };
  const rowFor = (id: string) => memberSource(sources, id);
  const references = new Set(sources.flatMap(row => row.workspaces.flatMap(workspace => (workspace.agentSpace?.members ?? []).flatMap(member => {
    const owner = rowFor(member.machineId);
    return owner ? [keyOf(owner.target,member.workspaceId)] : [];
  }))));
  const groups = sources.flatMap(row => {
    const tree = buildAgentSpaceTree(row.workspaces);
    return [...tree.roots,...tree.anomalies].filter(({workspace}) => (!references.has(keyOf(row.target,workspace.id)) || Boolean(workspace.agentSpace?.members?.length))).map(({workspace}) => {
      const key = keyOf(row.target,workspace.id);
      const children = workspaceMembers(sources,row,workspace);
      const visibleChildren = children.filter(child => !machineId || child.row?.target.id === machineId);
      const front = row.sessions.filter(s => s.workspaceId === workspace.id);
      const allSessions = [...front,...children.flatMap(child => child.row?.sessions.filter(s => s.workspaceId === child.workspaceId) ?? [])];
      const searchFields = { name: workspace.name, root: workspace.root,
        memberNames: children.map(child => child.name),
        sessionTexts: allSessions.map(s => `${s.title} ${s.description ?? ""}`) };
      return {row,workspace,key,children:visibleChildren,allChildren:children,allSessions,searchFields,
        partial:children.some(child => !child.workspace || !child.row?.activityComplete) || !row.activityComplete,
        stale:Boolean(row.cached) || !fresh(row) || children.some(child => !child.row || child.row.cached || !fresh(child.row)),
        machineCount:new Set([row.target.id,...children.map(child => child.row?.target.id ?? child.key)]).size,
        pinned:projectPinned(row.target.deviceHandle ?? row.target.id,workspace.id) };
    });
  }).filter(g => (!machineId || g.row.target.id === machineId || g.children.length > 0)
    && (section !== "projects" || projectSearchMatches(q, g.searchFields))
    && (section !== "projects" || projectFilter === "all" || (projectFilter === "builtin" ? g.workspace.builtin : g.allChildren.length > 0)));
  if (rankCache.current.version !== catalogVersion) rankCache.current = { version: catalogVersion, times: {} };
  for (const g of groups) {
    if (rankCache.current.times[g.key] === undefined) {
      rankCache.current.times[g.key] = projectFrontTime(g.allSessions.filter(s => s.workspaceId === g.workspace.id));
    }
  }
  const times = rankCache.current.times;
  const orderedGroups = [...groups].sort((a,b) => (times[b.key] ?? 0) - (times[a.key] ?? 0)
    || a.workspace.name.localeCompare(b.workspace.name));
  const toggleProject = (g: typeof orderedGroups[number]) => {
    setExpandedProjects(old => {
      const next = new Set(old);
      next.has(g.key) ? next.delete(g.key) : next.add(g.key);
      return next;
    });
  };

  // The machines the user is looking at keep their live subscriptions first.
  // Our expansion shows member Spaces only, so an expanded project's member
  // rows are the equivalent of main's expanded internal group.
  const preferredKey = [...new Set([
    ...(machineId ? [machineId] : []),
    ...directory.sources.filter(row => row.target.deviceHandle && row.target.deviceHandle === client?.identity?.machineId).map(row => row.target.id),
    ...groups.filter(g => expandedProjects.has(g.key) || (section === "projects" && Boolean(q)))
      .flatMap(g => g.children.flatMap(child => child.row ? [child.row.target.id] : [])),
  ])].sort().join("\n");
  const preferred = useRef("");
  useEffect(() => {
    const before = new Set(preferred.current ? preferred.current.split("\n") : []);
    const ids = preferredKey ? preferredKey.split("\n") : [];
    preferred.current = preferredKey;
    source.current?.prefer(ids);
    if (initialized.current && ids.some(id => !before.has(id))) void refresh();
  }, [preferredKey, refresh]);
  // The session view is flat: each row keeps its own rank. Projects and
  // machines are row metadata, never a grouping or sorting unit.
  const sessionRows = orderSessionRows(selectedSources.flatMap(row => row.sessions
    .filter(s => isDefaultConversationSession(s, row.workspaces) && matches(row, s))
    .map(session => ({row, session}))));
  const { pinned: pinnedRows, normal: normalRows } = splitPinnedSessions(
    sessionRows,
    ({row,session}) => sessionPinned(row.target.deviceHandle ?? row.target.id, session.id),
  );
  const selectable = section === "projects" ? orderedGroups.filter(g => !g.workspace.builtin && (!g.pinned || !pinnedClosed)).map(g => g.key)
    : sessionRows.filter(({row,session}) => fresh(row) && !session.historyOnly && !session.unsupported).map(({row,session}) => keyOf(row.target, session.id));
  const chosen = new Set([...selection].filter(key => selectable.includes(key)));
  const chosenGroups = section === "projects" ? orderedGroups.filter(g => chosen.has(g.key)) : [];
  const activeChosen = chosenGroups.flatMap(g => g.allSessions).filter(s => s.status === "running" || s.status === "waiting").length;
  const actionLabel = (action: BatchAction) => action === "terminate" ? "终止" : action === "resume" ? "恢复运行" : section === "projects" ? "移除" : includeArchived ? "恢复" : "归档";
  const toggle = (key: string) => setSelection(old => { const next = new Set(old); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const batch = async (action: BatchAction) => run(async () => {
    setConfirming(false);
    let succeeded = 0;
    const failures: string[] = [];
    for (const row of sources) {
      for (const item of section === "projects" ? ancestorsFirst(row.workspaces) : row.sessions) {
        if (!chosen.has(keyOf(row.target, item.id))) continue;
        if (action === "resume" && "root" in item && item.terminatedAtMs === undefined) continue;
        if (!mounted.current) return;
        try {
          if (!fresh(row)) throw new Error("状态未确认，请先刷新");
          await connections.use(row.target, async target => {
            const state = workbenchForClient(target);
            const terminable = Boolean(target.identity?.features?.includes("workspace.terminate.v1"));
            if (section === "projects" && action !== "apply") {
              if (!terminable) throw new Error("请先更新这台机器，再终止或恢复项目");
              const resume = action === "resume";
              const workspaces = state ? await state.terminateWorkspace(item.id, resume) : await (async () => {
                const reply = await target.call({ type: resume ? "workspace.resume" : "workspace.terminate", payload: { workspaceId: item.id } });
                if (reply?.type !== "workspaces") throw new Error("未收到确认，请核对后再操作");
                return reply.data;
              })();
              source.current?.acceptWorkspaces(row.target, workspaces);
              return;
            }
            if (section === "projects" && state) { await state.removeWorkspace(item.id); return; }
            if (section === "sessions" && state) {
              if (!await state.archiveSession(item.id,!includeArchived)) throw new Error("未收到归档结果，请核对后再操作");
              return;
            }
            const reply = section === "projects" ? await target.call({ type: "workspace.remove", payload: { workspaceId: item.id, ...(terminable ? { terminate: true } : {}) } })
              : await target.call({ type: "session.archive", payload: { sessionId: item.id, archived: !includeArchived } });
            if (section === "projects" ? reply?.type !== "workspaces" : reply?.type !== "session" || reply.data.archived === includeArchived) throw new Error("未收到确认，请核对后再操作");
            if (reply?.type === "workspaces") source.current?.acceptWorkspaceRemoval(row.target,row.workspaces.filter(w => !reply.data.some(next => next.id === w.id)).map(w => w.id));
            else if (reply?.type === "session") source.current?.acceptSessionSummary(row.target,reply.data);
          });
          succeeded++;
        } catch (e) { failures.push(`${"name" in item ? item.name : item.title}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    if (mounted.current) {
      setSelection(new Set());
      if (mounted.current) setError(`${succeeded} 项已${actionLabel(action)}${failures.length ? `；${failures.join("；")}` : ""}`);
    }
  });
  const rowButton = (row: MachineSummary, session: SessionSummary) => {
    // A cached directory is a locator, not authorization: onOpen obtains a
    // fresh authenticated connection before it can read the selected body.
    const canOpen = fresh(row) || Boolean(row.cached) && row.target.online !== false
      && row.state !== "denied" && row.state !== "offline";
    const workspace = row.workspaces.find(w => w.id === session.workspaceId), key = keyOf(row.target, session.id);
    const machineKey = row.target.deviceHandle ?? row.target.id;
    const pinned = sessionPinned(machineKey, session.id);
    const unread = hasUnreadReply(machineKey, session);
    return <li key={key} className="conversation-row flex min-w-0 items-center">
      {managing && <input aria-label={`选择会话 ${session.title}`} type="checkbox" className="m-2 h-5 w-5 shrink-0" disabled={!fresh(row) || Boolean(session.historyOnly || session.unsupported)} checked={chosen.has(key)} onChange={() => toggle(key)} />}
      <button type="button" disabled={busy || !(managing ? fresh(row) : canOpen) || Boolean(session.unsupported)} aria-current={row.target.deviceHandle === client?.identity?.machineId && activeId === session.id ? "page" : undefined}
        aria-label={`打开会话 ${session.title || "新会话"}`}
        className={`flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised aria-[current=page]:bg-raised disabled:opacity-60 ${pinned ? "bg-raised/30" : ""}`} onClick={() => managing ? toggle(key) : void navigate(row, session.id)}>
        <AgentAvatar id={session.workspaceId} name={workspace?.name ?? "Space"} size="medium" />
        <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5">
          {unread && <span role="img" aria-label="有未读新回复" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
          <span className={`gh-conversation-title min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>{session.title || "新会话"}</span>
          {pinned && <Pin size={11} aria-label="已置顶" className="shrink-0 text-accent" />}
          <time className="shrink-0 text-[10px] text-faint" dateTime={new Date(latest(session)).toISOString()}>{relativeTime(latest(session))}</time>
        </span><span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted"><span className="min-w-0 flex-1 truncate">{workspace?.name ?? "Space"}{session.archived ? " · 已归档" : ""}{session.historyOnly ? " · 只读" : ""}</span>
          <SessionStatusIcon session={session} sessions={row.sessions} stale={Boolean(row.cached) || !fresh(row)} disconnected={!fresh(row)} observedAtMs={row.updatedAt ? Date.parse(row.updatedAt) : 0} />
        </span></span>
      </button>
    </li>;
  };
  const projectRow = (g: typeof orderedGroups[number]) => {
    const expanded = expandedProjects.has(g.key) || (section === "projects" && Boolean(q));
    const members = g.children;
    return <section key={g.key} aria-label={`项目 ${g.workspace.name}`} className="mb-0.5 min-w-0">
      <div className="flex min-w-0 items-start">
        {managing && <input aria-label={`选择项目 ${g.workspace.name}`} className="m-2 h-5 w-5 shrink-0" type="checkbox" disabled={g.workspace.builtin || !fresh(g.row)} checked={chosen.has(g.key)} onChange={() => toggle(g.key)} />}
        {members.length > 0
          ? <button type="button" aria-label={`${expanded ? "折叠" : "展开"}成员 ${g.workspace.name}`} aria-expanded={expanded}
              className="mt-1 flex h-9 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-raised hover:text-fg"
              onClick={() => toggleProject(g)}>
              <ChevronDown size={14} className={`transition-transform ${expanded ? "" : "-rotate-90"}`} />
            </button>
          : <span className="mt-1 h-9 w-6 shrink-0" aria-hidden />}
        <button type="button" disabled={busy} aria-label={`打开项目 ${g.workspace.name}`}
          className={`flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised ${g.pinned ? "bg-raised/30" : ""}`}
          onClick={() => { if (managing) { if (!g.workspace.builtin) toggle(g.key); return; } void navigate(g.row, undefined, g.workspace.id); }}>
          <AgentAvatar id={g.workspace.id} name={g.workspace.name} />
          <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{g.workspace.name}</span>{g.pinned && <Pin size={11} aria-label="已置顶" className="shrink-0 text-accent" />}{g.workspace.terminatedAtMs !== undefined && <span title="恢复前平台不会在此项目运行任何 Agent 或定时任务" className="shrink-0 rounded bg-danger/10 px-1 text-[10px] text-danger">已终止</span>}<span className="shrink-0 text-[10px] text-faint">{g.workspace.builtin ? "内置" : times[g.key] ? relativeTime(times[g.key]!) : ""}</span></span>
            <span className="mt-1 flex min-w-0 items-center gap-2"><SessionActivityIcons sessions={g.allSessions} partial={g.partial} stale={g.stale} />
              {members.length > 0 && <span className="shrink-0 text-[10px] text-faint">{members.length} 个成员</span>}
              <span className={`ml-auto min-w-0 truncate text-[11px] ${["offline","denied","timeout","unavailable","rateLimited"].includes(g.row.state) ? "text-danger" : "text-faint"}`}>{g.machineCount > 1 ? `${g.machineCount} 台机器` : g.row.target.label}{!fresh(g.row) ? ` · ${stateLabel[g.row.state]}` : ""}</span>
            </span>
          </span>
        </button>
      </div>
      {expanded && members.length > 0 && <ul aria-label={`${g.workspace.name} 成员`} className="ml-4 border-l border-line/40 pl-2">
        {members.map(space => {
          const sessions = space.row?.sessions.filter(item => item.workspaceId === space.workspaceId) ?? [];
          const available = Boolean(space.row && space.workspace);
          return <li key={space.key}>
            <button type="button" disabled={!available} aria-label={`打开成员 ${space.name}`}
              className="flex min-h-10 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-[11px] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
              onClick={() => { if (space.row) void navigate(space.row, undefined, space.workspaceId); }}>
              <AgentAvatar id={space.workspaceId} name={space.name} size="small" />
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <span className="shrink-0 text-[10px] text-faint">{space.machine}</span>
              <span className="shrink-0 text-[10px] text-faint">{!available ? "状态未知" : stateLabel[space.row!.state]}</span>
              <SessionActivityIcons sessions={sessions} partial={Boolean(space.row && !space.row.activityComplete)} stale={!space.row || Boolean(space.row.cached) || !fresh(space.row)} />
            </button>
          </li>;
        })}
      </ul>}
    </section>;
  };
  const changeArchived = () => {
    if (lock.current || refreshLock.current) return;
    patchView({ includeArchived: !includeArchived }); setOptions(false);
  };
  return <ListPane label={section === "projects" ? "项目列表面板" : "会话列表"} open={open} hidden={hidden}>
    <ListHeader>
      <div className="flex min-h-11 min-w-0 items-center gap-1">
        {searching ? <><input autoFocus aria-label={`搜索${section === "projects" ? "项目" : "会话"}`} placeholder="搜索会话、项目或成员" value={query} onChange={e => patchView({ query: e.target.value })} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-2 text-sm" /><button aria-label="关闭搜索" className="min-h-11 shrink-0 px-2 text-xs" onClick={() => { setSearching(false); patchView({ query: "" }); }}>取消</button></> : <>
          <MachineFilter sources={sources} value={machineId} onChange={setMachineId} section={section} />
          <button aria-label="搜索列表" className="flex h-11 w-8 shrink-0 items-center justify-center text-muted" onClick={() => setSearching(true)}><Search size={18} /></button>
          <button aria-label={section === "projects" ? "添加项目" : "新建会话"} disabled={busy} className="flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-lg bg-accent px-2 text-xs text-white" onClick={() => {
            const selected = sources.find(row => row.target.id === machineId);
            if (section === "projects") onAddProject(selected?.target); else onNewSession(selected?.target);
          }}><Plus size={16} />{section === "projects" ? "添加" : "新建"}</button>
        </>}
      </div>
      <div className="gh-directory-filters flex min-w-0 items-center" aria-label={section === "sessions" ? "会话状态工具栏" : "项目类型工具栏"}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center">
          {section === "sessions" ? ([["all", "全部"], ["running", "进行中"], ["unread", "未读"]] as const).map(([id, text]) => <button key={id} aria-pressed={filter === id} onClick={() => patchView({ filter: id })} className={`min-h-9 rounded-lg px-1.5 text-xs ${filter === id ? "bg-accent/10 text-accent" : "text-muted"}`}>{text}</button>)
            : ([["all", "所有"], ["builtin", "内置"], ["team", "团队"]] as const).map(([id, text]) => <button key={id} aria-pressed={projectFilter === id} onClick={() => setProjectFilter(id)} className={`min-h-9 rounded-lg px-1.5 text-xs ${projectFilter === id ? "bg-accent/10 text-accent" : "text-muted"}`}>{text}</button>)}
        </div>
        <div className="flex shrink-0 items-center">
          <button disabled={busy} aria-pressed={managing} className="min-h-9 shrink-0 px-1.5 text-xs text-muted" onClick={() => { setManaging(!managing); setSelection(new Set()); }}>{managing ? "完成" : "批量"}</button>
          <button aria-label="列表选项" aria-expanded={options} className="flex h-9 w-8 shrink-0 items-center justify-center text-muted" onClick={() => setOptions(!options)}><MoreHorizontal size={18} /></button>
        </div>
      </div>
      {options && <><button aria-label="关闭列表选项" className="fixed inset-0 z-40 cursor-default" onClick={() => setOptions(false)} /><div role="menu" aria-label="列表选项" className="absolute right-3 top-full z-50 min-w-40 rounded-xl border border-line bg-surface p-1 shadow-xl">
        <button role="menuitem" disabled={busy || refreshing} className="min-h-11 w-full px-3 text-left text-sm" onClick={() => { setOptions(false); void refresh(true); }}>{refreshing ? "刷新中…" : "刷新列表"}</button>
        {section === "sessions" && <button role="menuitem" disabled={busy || refreshing} className="min-h-11 w-full px-3 text-left text-sm" onClick={changeArchived}>{includeArchived ? "返回当前会话" : "查看已归档"}</button>}
      </div></>}
      {includeArchived && section === "sessions" && <button disabled={busy || refreshing} className="min-h-9 w-full text-left text-xs text-accent" onClick={changeArchived}>已归档会话 · 返回当前</button>}
      {error && <p role="status" className="max-h-24 overflow-y-auto break-words text-xs text-muted">{error}</p>}
      {narrowed && <p className="text-xs text-muted">已检索 {sources.filter(fresh).length}/{sources.length} 台机器的已加载记录；{section === "projects" ? "匹配项目、会话标题或成员名称。" : "可加载更早会话扩大范围。"}</p>}
    </ListHeader>
    <ListScroll label={section === "projects" ? "项目列表滚动区域" : "会话滚动区域"}>
      {!sources.length && <p role="status" className="p-4 text-sm text-muted">正在读取机器目录…</p>}
      {section === "projects" ? <>
        {orderedGroups.some(g => g.pinned) && <section aria-label="置顶项目" className="mb-2 overflow-hidden rounded-lg border border-line/40 bg-raised/40">
          <button type="button" aria-expanded={!pinnedClosed} className="flex min-h-9 w-full items-center gap-1.5 px-2 text-left text-[11px] text-muted transition-colors hover:bg-raised/60" onClick={() => { setPinnedClosed(!pinnedClosed); setSelection(new Set()); }}>
            <ChevronDown size={13} className={`shrink-0 transition-transform ${pinnedClosed ? "-rotate-90" : ""}`} />
            <Pin size={12} aria-hidden className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">置顶</span>
            <span className="shrink-0 text-faint">{orderedGroups.filter(g => g.pinned).length}</span>
          </button>
          {!pinnedClosed && <div className="p-1 pt-0">{orderedGroups.filter(g => g.pinned).map(projectRow)}</div>}
        </section>}
        {orderedGroups.some(g => !g.pinned) && <p className="px-2 pb-1 pt-2 text-[11px] text-faint">项目</p>}{orderedGroups.filter(g => !g.pinned).map(projectRow)}
      </> : <>
        {pinnedRows.length > 0 && <section aria-label="置顶会话" className="mb-2 overflow-hidden rounded-lg border border-line/40 bg-raised/40">
          <button type="button" aria-expanded={!sessionsPinnedClosed} className="flex min-h-9 w-full items-center gap-1.5 px-2 text-left text-[11px] text-muted transition-colors hover:bg-raised/60" onClick={() => { setSessionsPinnedClosed(!sessionsPinnedClosed); setSelection(new Set()); }}>
            <ChevronDown size={13} className={`shrink-0 transition-transform ${sessionsPinnedClosed ? "-rotate-90" : ""}`} />
            <Pin size={12} aria-hidden className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">置顶</span>
            <span className="shrink-0 text-faint">{pinnedRows.length}</span>
          </button>
          {!sessionsPinnedClosed && <ul aria-label="置顶会话" className="p-1 pt-0">{pinnedRows.map(({row,session}) => rowButton(row,session))}</ul>}
        </section>}
        <ul aria-label="最近会话">{normalRows.map(({row,session}) => rowButton(row,session))}</ul>
        {!sessionRows.length && sources.some(fresh) && <p className="p-5 text-center text-sm text-muted">{narrowed || includeArchived ? "没有匹配的会话" : "从一个项目开始会话"}</p>}
      </>}
      {selectedSources.map(row => <div key={row.target.id}>
        {row.nextCursor && section === "sessions" && <button disabled={busy || !fresh(row)} className="min-h-11 w-full px-2 text-xs text-accent" onClick={() => void run(() => source.current!.loadMore(row.target))}>加载 {row.target.label} 的更早会话</button>}
        {(row.cached || !fresh(row)) && <p role="status" className="px-3 py-2 text-xs text-muted">{row.target.label} · {row.cached ? "上次状态" : stateLabel[row.state]}{row.updatedAt ? ` · 上次同步 ${relativeTime(Date.parse(row.updatedAt))}` : " · 状态未知"}</p>}
      </div>)}
    </ListScroll>
    {managing && <footer aria-label="批量操作" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line p-3">
      <button disabled={busy || !selectable.length} className="min-h-11 text-xs text-accent" onClick={() => setSelection(chosen.size === selectable.length ? new Set() : new Set(selectable))}>{chosen.size === selectable.length && chosen.size ? "取消全选" : "全选当前可见"}</button>
      <span className="min-w-0 flex-1 text-xs text-muted">已选 {chosen.size}</span>
      {section === "projects" && chosenGroups.some(g => g.workspace.terminatedAtMs !== undefined) && <button disabled={busy} onClick={() => setConfirming("resume")} className="min-h-11 rounded-lg border border-line px-3 text-sm disabled:opacity-40">恢复</button>}
      {section === "projects" && <button disabled={!chosen.size || busy} onClick={() => setConfirming("terminate")} className="min-h-11 rounded-lg border border-line px-3 text-sm text-danger disabled:opacity-40">终止</button>}
      <button disabled={!chosen.size || busy} onClick={() => setConfirming("apply")} className="min-h-11 rounded-lg border border-line px-3 text-sm disabled:opacity-40">{actionLabel("apply")}</button>
    </footer>}
    {confirming && <WorkspaceDetailsDialog title={`${actionLabel(confirming)}所选${section === "projects" ? "项目" : "会话"}`} onClose={() => setConfirming(false)}><p className="text-sm">{
      section === "sessions" ? "会话历史保留，归档不会停止任务。"
        : confirming === "resume" ? "解除终止。不会自动重启任何会话；之后发送消息、团队调度和定时任务会照常运行。"
          : confirming === "terminate" ? `平台会立即停止所选项目及其成员的全部会话、后台进程和定时任务${activeChosen ? `（当前 ${activeChosen} 个会话正在运行或等待交互）` : ""}，并取消等待中的提问。恢复之前平台不会在其中运行任何 Agent 或定时任务（未升级的旧版本 GeneHub 除外）；恢复需由你操作或明确要求 Agent 执行。文件和历史会话保留。`
            : `只移除项目登记，保留磁盘文件和历史会话。${activeChosen ? `其中 ${activeChosen} 个会话正在运行或等待交互，` : ""}仍在运行或等待交互的会话会先被平台停止。`
    }</p><button className={`mt-3 min-h-11 w-full rounded-lg text-sm text-white ${confirming === "terminate" ? "bg-danger" : "bg-accent"}`} onClick={() => void batch(confirming)}>确认{section === "sessions" ? "处理" : actionLabel(confirming)} {confirming === "resume" ? chosenGroups.filter(g => g.workspace.terminatedAtMs !== undefined).length : chosen.size} 项</button></WorkspaceDetailsDialog>}
    <span className="sr-only">当前正文来自 {endpoint.label}</span>
  </ListPane>;
}

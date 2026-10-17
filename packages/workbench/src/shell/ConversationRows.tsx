import { EntityAvatar, EntityText } from "../ui/EntityIdentity";
import type {
  SessionSummary,
  WorkspaceInfo,
} from "@genehub/proto";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { markContentRead } from "../session/localConversation";
import { sessionAttention } from "../session/attention";
import { Hand, Loader2 } from "lucide-react";
import { useWorkbench } from "../session/store";
import { SessionProcessesDialog } from "../processes/SessionProcessesDialog";
import { relativeTime } from "../ui/relativeTime";
import { useAgentActivity } from "../workspace/useAgentActivity";
import { AgentDetailsDialog, AgentDetailsEnvironment } from "../workspace/AgentDetails";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { SessionStatusIcon } from "./SessionStatusIcon";

interface RowActions {
  selection?: { ids: ReadonlySet<string>; toggle(id: string): void; disabled?: boolean };
  onPickSession(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onDelete(sessionId: string): void;
}

type ListedSession = SessionSummary & { unread: boolean };

/** Every workspace, with its conversations under it. */
export function WorkspaceRow({
  workspace,
  breadcrumb,
  relationAnomaly,
  running,
  shut,
  active,
  deviceName,
  onToggle,
  onPick,
  onRename,
  onRemove,
  onNewSession,
  children,
  browse = false,
  pick = false,
  density = "auto",
  expanded,
  onExpand,
  childCount = 0,
  actions = true,
}: {
  browse?: boolean;
  /** Same row identity as the project list, used only to choose a project. */
  pick?: boolean;
  density?: "auto" | "comfortable" | "compact";
  expanded?: boolean;
  onExpand?(): void;
  childCount?: number;
  actions?: boolean;
  workspace: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  breadcrumb: string;
  projectWorkspaceId: string;
  relationAnomaly: boolean;
  running: number;
  shut: boolean;
  active: boolean;
  deviceName: string;
  onToggle(): void;
  onPick(): void;
  onRename(name: string): void;
  onRemove(): Promise<void>;
  onNewSession?(): void;
  children: ReactNode;
}) {
  const environment = useContext(AgentDetailsEnvironment);
  const openDetails = () => environment?.onOverview ? environment.onOverview(workspace.id, "details") : setDetails(true);
  const activity = useAgentActivity(workspace.id);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  if (pick) {
    return (
      <li data-density={density} className="entity-row">
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-label={workspace.name}
          title={breadcrumb}
          className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left ${
            active ? "bg-accent/10 text-fg" : "text-fg hover:bg-raised"
          }`}
          onClick={onPick}
        >
          <EntityAvatar id={workspace.id} name={workspace.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{workspace.name}</span>
            {breadcrumb && breadcrumb !== workspace.name ? (
              <span className="block truncate text-[11px] font-normal text-faint">{breadcrumb}</span>
            ) : null}
          </span>
        </button>
      </li>
    );
  }
  return (
    <li data-density={density} className="entity-row group relative mb-1">
      {editing ? (
        <Rename
          initial={workspace.name}
          label="项目名称"
          onCommit={(name) => {
            setEditing(false);
            onRename(name);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          className={`agent-row-body relative flex min-h-14 w-full items-center gap-1 rounded-md pr-1 text-sm ${active ? "bg-raised text-fg" : "text-fg"}`}
        >
          {!browse && (
            <button
              type="button"
              aria-label={
                browse
                  ? `进入 ${workspace.name}`
                  : shut
                    ? `展开 ${workspace.name}`
                    : `折叠 ${workspace.name}`
              }
              aria-expanded={browse ? undefined : !shut}
              className="flex h-10 w-8 shrink-0 items-center justify-center rounded text-faint hover:bg-sidebar-hover hover:text-fg md:h-auto md:w-auto md:px-1 md:py-1"
              onClick={onToggle}
            >
              <span aria-hidden>{browse ? "›" : shut ? "▸" : "▾"}</span>
            </button>
          )}
          <button
            type="button"
            className="entity-main flex min-w-0 flex-1 items-center gap-3 py-2 text-left font-medium hover:text-fg"
            aria-label={workspace.name}
            title={`${breadcrumb}\n${workspace.root}`}
            onClick={onPick}
          >
            <EntityAvatar id={workspace.id} name={workspace.name} badge={!activity.error && activity.running && !activity.pending ? <Loader2 aria-label="有执行活动" className="h-3 w-3 animate-spin text-ok" /> : undefined}/>
            <EntityText title={workspace.name} hint="当前会话及仍有活动的归档会话；待办可进入具体处理位置">
              <span className="truncate">{activity.error ? "会话状态待同步" : activity.count === undefined ? "正在读取会话…" : activity.label || `${relativeTime(activity.recent ?? 0)} · ${activity.count} 个会话`}</span>
            </EntityText>
          </button>
          {!!activity.pending && <button type="button" aria-label={`查看 ${workspace.name} 的 ${activity.pending} 项待办`} title="打开完整待办列表"
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-accent hover:bg-raised"
            onClick={() => environment?.onOverview ? environment.onOverview(workspace.id, "attention") : onPick()}>
            <Hand size={14} aria-hidden />{activity.pending}
          </button>}
          {!activity.pending && activity.tasks && <button type="button" aria-label={`查看 ${workspace.name} 的任务会话`}
            className="min-h-11 shrink-0 rounded-lg px-2 text-xs text-accent hover:bg-raised"
            onClick={() => environment?.onOverview ? environment.onOverview(workspace.id, "activity") : onPick()}>查看任务</button>}
          <div className="agent-row-actions" data-open={menu || undefined}>
            {onNewSession && <button type="button" aria-label={`与 ${workspace.name} 新建会话`} title="新建会话" className="agent-new min-h-11 rounded-lg px-2 text-xs font-medium text-accent hover:bg-raised" onClick={onNewSession}>＋ 新会话</button>}
          {relationAnomaly ? (
            <span className="text-[9px] text-danger" title="Parent 关系异常">
              !
            </span>
          ) : null}
          {childCount > 0 && onExpand && (
            <button
              type="button"
              aria-label={`${expanded ? "收起" : "展开"} ${workspace.name} 的子项目`}
              aria-expanded={expanded}
              onClick={onExpand}
              className="entity-expand flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised"
            >
              <span aria-hidden>{expanded ? "⌃" : "⌄"}</span>
            </button>
          )}
          {actions && (
            <button
              type="button"
              aria-label={`${workspace.name} 的项目操作`}
              aria-expanded={menu}
              className="entity-more flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sidebar-hover hover:text-fg"
              onClick={() => setMenu((open) => !open)}
            >
              <span aria-hidden>⋯</span>
            </button>
          )}
          </div>
        </div>
      )}
      {menu ? (
        <>
          <button
            type="button"
            aria-label="收起项目操作"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMenu(false)}
          />
          <div
            role="menu"
            className="absolute right-1 top-9 z-50 min-w-28 overflow-hidden rounded-lg border border-line-strong bg-surface py-1 shadow-[0_8px_30px_rgb(0_0_0_/0.35)]"
          >
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={() => {
                setMenu(false);
                openDetails();
              }}
            >
              详情
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={() => {
                setMenu(false);
                setEditing(true);
              }}
            >
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={running > 0}
              title={
                running > 0
                  ? "先停止这个项目中正在运行或等待的会话"
                  : undefined
              }
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-danger hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0 md:py-1.5 md:text-xs"
              onClick={() => {
                setMenu(false);
                setRemoving(true);
              }}
            >
              从列表移除
            </button>
          </div>
        </>
      ) : null}
      {details && <AgentDetailsDialog workspace={workspace} deviceName={deviceName} onClose={() => setDetails(false)} />}
      {removing ? (
        <div className="mx-1 mb-2 rounded-lg border border-line-strong bg-surface p-3 text-xs">
          <p className="font-medium text-fg">
            从列表移除「{workspace.name}」及其成员？
          </p>
          <p className="mt-1 leading-relaxed text-muted">
            同时移除其下全部成员的列表登记。文件和历史会话不会删除；运行中或等待交互时会阻止移除。
          </p>
          {removeError && <p role="alert" className="mt-2 text-danger">{removeError}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={removeBusy}
              className="rounded px-2 py-1 text-muted hover:bg-raised disabled:opacity-40"
              onClick={() => setRemoving(false)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={removeBusy}
              className="rounded bg-danger px-2 py-1 text-white disabled:opacity-40"
              onClick={() => {
                setRemoveBusy(true);
                setRemoveError("");
                void onRemove().then(() => setRemoving(false)).catch(e => {
                  setRemoveError(e instanceof Error ? e.message : "移除失败，请重试");
                }).finally(() => setRemoveBusy(false));
              }}
            >
              {removeBusy ? "移除中…" : "确认移除"}
            </button>
          </div>
        </div>
      ) : null}
      {children}
    </li>
  );
}

/**
 * The other question: what is running, across every project.
 *
 * Each row says which project it belongs to, because without the tree around it
 * a title on its own does not say where the work is happening.
 */
export function RecentSessions({
  sessions,
  workspaces,
  activeSessionId,
  density = "auto",
  pick = false,
  groupByTeam = false,
  listLabel = "最近会话",
  ...actions
}: {
  density?: "auto" | "comfortable" | "compact";
  sessions: ListedSession[];
  workspaces: WorkspaceInfo[];
  activeSessionId: string | null;
  /** Same rows as the sidebar, used only to choose a conversation. */
  pick?: boolean;
  /** Group conversations by project & 1+N project team with three-tier team organization. */
  groupByTeam?: boolean;
  listLabel?: string;
} & RowActions) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const deviceHandle = useWorkbench((s) => s.client?.identity?.machineId ?? "local");
  const openPreviewFloat = useWorkbench((s) => s.openPreviewFloat);

  const sortedSessions = [...sessions].sort(
    (left, right) =>
      (right.messagePreview?.atMs ?? right.updatedAtMs) -
      (left.messagePreview?.atMs ?? left.updatedAtMs),
  );

  if (!groupByTeam || pick) {
    return (
      <ul
        data-density={density}
        className={`entity-list conversation-list w-full min-w-0 max-w-full space-y-1 ${pick ? "overflow-hidden" : ""}`}
        role={pick ? "listbox" : undefined}
        aria-label={listLabel}
      >
        {sortedSessions.map((session) => {
          const project = workspaces.find(({ id }) => id === session.workspaceId);
          const parentProject = project?.agentSpace?.parentWorkspaceId
            ? workspaces.find(({ id }) => id === project.agentSpace?.parentWorkspaceId)
            : undefined;
          return (
            <SessionRow
              key={session.id}
              session={session}
              pick={pick}
              active={session.id === activeSessionId}
              project={project}
              parentProject={parentProject}
              {...actions}
            />
          );
        })}
      </ul>
    );
  }

  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const childrenByRoot = new Map<string, WorkspaceInfo[]>();
  for (const w of workspaces) {
    const pid = w.agentSpace?.parentWorkspaceId;
    if (pid && byId.has(pid)) {
      childrenByRoot.set(pid, [...(childrenByRoot.get(pid) ?? []), w]);
    }
  }
  const isProjectTeamRoot = (rootId: string): boolean => {
    const kids = childrenByRoot.get(rootId) ?? [];
    return kids.some(
      (k) =>
        k.name === "leader" ||
        k.name === "team-reflect" ||
        k.name === "qa" ||
        k.name.endsWith("-lead"),
    );
  };

  const groupsMap = new Map<string, ListedSession[]>();
  for (const session of sortedSessions) {
    const ws = byId.get(session.workspaceId);
    const rootId = ws?.agentSpace?.parentWorkspaceId && byId.has(ws.agentSpace.parentWorkspaceId)
      ? ws.agentSpace.parentWorkspaceId
      : session.workspaceId;
    groupsMap.set(rootId, [...(groupsMap.get(rootId) ?? []), session]);
  }

  const rolePriority = (roleName: string): number => {
    if (roleName === "leader") return 1;
    if (roleName.endsWith("-lead")) return 2;
    if (roleName === "qa") return 3;
    if (roleName === "research") return 4;
    return 5;
  };

  return (
    <ul
      data-density={density}
      className="entity-list conversation-list w-full min-w-0 max-w-full space-y-2"
      aria-label={listLabel}
    >
      {[...groupsMap.entries()].map(([rootId, groupSessions]) => {
        const rootWs = byId.get(rootId);
        const isTeam = isProjectTeamRoot(rootId);
        const collapsed = Boolean(collapsedGroups[rootId]);
        const runningCount = groupSessions.filter(
          (s) => s.status === "running" || s.status === "waiting",
        ).length;
        const rootHandle = rootWs?.folders?.[0]?.rootHandle;

        if (!isTeam) {
          return (
            <li key={rootId} className="project-session-group space-y-1">
              {rootWs && groupsMap.size > 1 && (
                <div className="flex items-center justify-between px-2 py-1 text-xs text-muted">
                  <button
                    type="button"
                    aria-label={`${collapsed ? "展开" : "折叠"}项目分组 ${rootWs.name}`}
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsedGroups((prev) => ({ ...prev, [rootId]: !prev[rootId] }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium text-muted hover:text-fg"
                  >
                    <span aria-hidden className="text-[10px]">{collapsed ? "▸" : "▾"}</span>
                    <AgentAvatar id={rootWs.id} name={rootWs.name} size="small" />
                    <span className="truncate">{rootWs.name}</span>
                    <span className="shrink-0 text-[11px] text-faint">({groupSessions.length})</span>
                  </button>
                </div>
              )}
              {!collapsed && (
                <ul className="space-y-1">
                  {groupSessions.map((session) => {
                    const project = byId.get(session.workspaceId);
                    const parentProject = project?.agentSpace?.parentWorkspaceId
                      ? byId.get(project.agentSpace.parentWorkspaceId)
                      : undefined;
                    return (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        project={project}
                        parentProject={parentProject}
                        {...actions}
                      />
                    );
                  })}
                </ul>
              )}
            </li>
          );
        }

        // 1+N Project Team three-tier organization:
        // Tier 1: Root (Front / Patrol) primary sessions
        // Tier 2: Core Member Spaces (leader, *-lead, qa, research) -> latest session per member space
        // Tier 3: Background & historical sub-sessions (team-reflect, reflect, work, or older member sessions)
        const frontSessions: ListedSession[] = [];
        const latestByMember = new Map<string, ListedSession>();
        const historyAndReflect: ListedSession[] = [];

        for (const session of groupSessions) {
          if (session.workspaceId === rootId) {
            frontSessions.push(session);
            continue;
          }
          const memberWs = byId.get(session.workspaceId);
          const roleName = memberWs?.name ?? "";
          if (roleName === "team-reflect" || roleName === "reflect" || roleName === "work") {
            historyAndReflect.push(session);
            continue;
          }
          if (!latestByMember.has(session.workspaceId)) {
            latestByMember.set(session.workspaceId, session);
          } else {
            historyAndReflect.push(session);
          }
        }

        const memberSessions = [...latestByMember.values()].sort((a, b) => {
          const wa = byId.get(a.workspaceId)?.name ?? "";
          const wbName = byId.get(b.workspaceId)?.name ?? "";
          const diff = rolePriority(wa) - rolePriority(wbName);
          return diff !== 0 ? diff : wa.localeCompare(wbName);
        });

        const showHistory = Boolean(expandedHistory[rootId]);

        return (
          <li
            key={rootId}
            aria-label={`项目团队分组 ${rootWs?.name ?? rootId}`}
            className="team-session-group rounded-xl border border-line bg-surface/60 p-1.5"
          >
            <div className="space-y-1 px-1.5 py-1">
              <button
                type="button"
                aria-label={`${collapsed ? "展开" : "折叠"}团队分组 ${rootWs?.name ?? rootId}`}
                aria-expanded={!collapsed}
                onClick={() => setCollapsedGroups((prev) => ({ ...prev, [rootId]: !prev[rootId] }))}
                className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs font-semibold text-fg hover:text-accent"
              >
                <span aria-hidden className="text-[10px] text-muted">{collapsed ? "▸" : "▾"}</span>
                <AgentAvatar id={rootId} name={rootWs?.name ?? "团队"} size="small" />
                <span className="min-w-0 flex-1 truncate" title={rootWs?.name ?? "项目团队"}>
                  {rootWs?.name ?? "项目团队"}
                </span>
                <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  项目团队
                </span>
                {runningCount > 0 && (
                  <span className="shrink-0 rounded bg-ok/15 px-1.5 py-0.5 text-[10px] font-medium text-ok">
                    {runningCount} 运行中
                  </span>
                )}
              </button>
              {rootWs && rootHandle && (
                <div className="flex items-center gap-1.5 pl-4">
                  <button
                    type="button"
                    aria-label={`打开 ${rootWs.name} 团队看板`}
                    title="打开常驻实时团队作战看板 (datas/board/index.html)"
                    className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20"
                    onClick={() =>
                      openPreviewFloat({
                        deviceHandle,
                        workspaceHandle: rootWs.id,
                        path: `${rootHandle}/datas/board/index.html`,
                        sessionId: activeSessionId,
                      })
                    }
                  >
                    📊 看板
                  </button>
                  <button
                    type="button"
                    aria-label={`打开 ${rootWs.name} 最新试玩`}
                    title="打开团队最新可玩版本 (datas/releases/index.html)"
                    className="rounded border border-ok/30 bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok hover:bg-ok/20"
                    onClick={() =>
                      openPreviewFloat({
                        deviceHandle,
                        workspaceHandle: rootWs.id,
                        path: `${rootHandle}/datas/releases/index.html`,
                        sessionId: activeSessionId,
                      })
                    }
                  >
                    🎮 试玩
                  </button>
                </div>
              )}
            </div>
            {!collapsed && (
              <div className="mt-1 space-y-1">
                {frontSessions.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-0.5 text-[10px] font-medium text-muted">📌 主入口（巡查）</div>
                    <ul className="space-y-1">
                      {frontSessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          active={session.id === activeSessionId}
                          project={rootWs}
                          {...actions}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {memberSessions.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-[10px] font-medium text-muted">
                      🧭 组长与团队成员 ({memberSessions.length})
                    </div>
                    <ul className="space-y-1 border-l-2 border-line pl-1.5 ml-2">
                      {memberSessions.map((session) => {
                        const project = byId.get(session.workspaceId);
                        return (
                          <SessionRow
                            key={session.id}
                            session={session}
                            active={session.id === activeSessionId}
                            project={project}
                            parentProject={rootWs}
                            {...actions}
                          />
                        );
                      })}
                    </ul>
                  </div>
                )}
                {historyAndReflect.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      aria-expanded={showHistory}
                      onClick={() => setExpandedHistory((prev) => ({ ...prev, [rootId]: !prev[rootId] }))}
                      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[11px] text-muted hover:bg-raised hover:text-fg"
                    >
                      <span aria-hidden>{showHistory ? "▾" : "▸"}</span>
                      <span>后台自省与历史子任务 ({historyAndReflect.length})</span>
                    </button>
                    {showHistory && (
                      <ul className="mt-1 space-y-1 border-l border-line pl-1.5 ml-2">
                        {historyAndReflect.map((session) => {
                          const project = byId.get(session.workspaceId);
                          return (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === activeSessionId}
                              project={project}
                              parentProject={rootWs}
                              {...actions}
                            />
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SessionRow({
  session,
  active,
  project,
  parentProject,
  pick = false,
  onPickSession,
  onRename,
  onDelete,
  selection,
}: {
  session: ListedSession;
  active: boolean;
  project?: WorkspaceInfo;
  parentProject?: WorkspaceInfo;
  pick?: boolean;
} & RowActions) {
  const [menu, setMenu] = useState<"shut" | "open" | "confirming">("shut");
  const [editing, setEditing] = useState(false);
  const [labeling, setLabeling] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const summaries = useWorkbench(state => state.sessions);
  const stale = useWorkbench(state => state.sessionsError || state.connection !== "ready");
  const facts = sessionAttention(session, summaries);
  // Written by a newer build into this project's folder. Listed, so the
  // conversation does not appear to have vanished, but not openable here.
  const messageDate = new Date(
    session.messagePreview?.atMs ?? session.updatedAtMs,
  );
  const unsupported = session.unsupported;
  const managedReadOnly = session.managed?.userInteraction === "readOnly";
  const displayTitle = title(session, Boolean(parentProject));

  if (editing) {
    return (
      <li>
        <Rename
          initial={title(session)}
          onCommit={(name) => {
            setEditing(false);
            if (name !== title(session)) onRename(session.id, name);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className={`conversation-row group relative w-full min-w-0 max-w-full ${pick ? "overflow-hidden" : ""}`}>
      <div className="flex w-full min-w-0 items-center">
        {selection && <input type="checkbox" aria-label={`选择 ${displayTitle}`} checked={selection.ids.has(session.id)} disabled={selection.disabled} onChange={() => selection.toggle(session.id)} className="ml-2 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" />}
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            role={pick ? "option" : undefined}
            aria-selected={pick ? active : undefined}
            disabled={selection ? selection.disabled : Boolean(unsupported)}
            title={unsupported ? whyUnsupported(unsupported) : undefined}
            className={`entity-main conversation-main block min-h-16 w-full min-w-0 rounded-lg px-3 py-3 text-left text-sm ${
              unsupported
                ? "cursor-not-allowed text-faint"
                : active
                  ? "bg-raised text-fg"
                  : "text-muted hover:bg-sidebar-hover hover:text-fg"
            }`}
            onClick={() => selection ? selection.toggle(session.id) : onPickSession(session.id)}
          >
            {/* Always three lines: title, time and project, then a short status icon with labels. */}
            <span className="entity-copy block min-w-0">
              <span className="entity-title flex min-w-0 items-center gap-1.5 text-sm font-medium leading-5 text-fg">
                {session.unread && <span role="img" aria-label="有未读新回复" title="有未读新回复" className="block h-2 w-2 shrink-0 rounded-full bg-accent" />}
                <span className="truncate" title={displayTitle}>{displayTitle}</span>
              </span>
              <span className={`conversation-facts entity-secondary flex min-w-0 items-center gap-1 text-xs font-normal leading-4 text-muted ${!selection && !pick ? "conversation-row-meta" : ""}`} title={`${messageDate.toLocaleString()} · ${parentProject && project ? `${parentProject.name} / ${project.name}` : (project?.name ?? "项目")}`}>
                <AgentAvatar id={session.workspaceId} name={project?.name ?? "项目"} size="small" />
                <span className="min-w-0 truncate"><time dateTime={messageDate.toISOString()}>{relativeTime(messageDate.getTime())}</time> · {parentProject && project ? `${parentProject.name} / ${project.name}` : (project?.name ?? "项目")}{session.draftCount ? ` · ${session.draftCount} 个草稿` : ""}{managedReadOnly ? " · 只读" : ""}{session.archived ? " · 已归档" : ""}{unsupported ? " · 需升级" : ""}</span>
              </span>
              <span className={`conversation-marks entity-secondary flex min-h-3.5 min-w-0 items-center gap-1 text-[10px] font-normal leading-[14px] ${!selection && !pick ? "conversation-row-meta" : ""}`}>
                {(facts.kind || stale) && <SessionStatusIcon session={session} sessions={summaries} stale={stale} />}
                {session.labels?.map((label) => <span key={label} className="session-label shrink-0 rounded bg-accent/10 px-1 text-accent">{label}</span>)}
              </span>
            </span>
          </button>

          {!selection && !pick && <button
            type="button"
            aria-label={`${displayTitle} 的更多操作`}
            aria-expanded={menu !== "shut"}
            // Always there on a touch screen: hover is the one interaction a phone
            // cannot perform, and hiding the only way to delete a conversation
            // behind it is how this ended up missing entirely.
            className="conversation-row-more absolute bottom-0.5 right-0.5 flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-sidebar-hover hover:text-fg"
            onClick={() => setMenu((state) => (state === "shut" ? "open" : "shut"))}
          >
            <span aria-hidden>⋯</span>
          </button>}
        </div>
      </div>

      {menu === "shut" || selection ? null : (
        <Menu
          onMarkRead={session.latestReply ? () => {
            markContentRead(useWorkbench.getState().client?.identity?.machineId ?? "", session.id, session.latestReply!);
            setMenu("shut");
          } : undefined}
          confirming={menu === "confirming"}
          readOnly={managedReadOnly}
          archived={session.archived}
          onArchive={() => {
            setMenu("shut");
            void useWorkbench
              .getState()
              .archiveSession(session.id, !session.archived);
          }}
          onRename={() => {
            setMenu("shut");
            setEditing(true);
          }}
          onLabel={() => {
            setMenu("shut");
            setLabeling(true);
          }}
          onOpenProcesses={() => {
            setMenu("shut");
            setProcessesOpen(true);
          }}
          onAskDelete={() => setMenu("confirming")}
          onDelete={() => {
            setMenu("shut");
            onDelete(session.id);
          }}
          onDismiss={() => setMenu("shut")}
        />
      )}
      {labeling && (
        <LabelEditor
          labels={session.labels ?? []}
          onChange={(change) => useWorkbench.getState().labelSession(session.id, change)}
          onDone={() => setLabeling(false)}
        />
      )}
      {processesOpen ? (
        <SessionProcessesDialog
          sessionId={session.id}
          onClose={() => setProcessesOpen(false)}
        />
      ) : null}
    </li>
  );
}

/**
 * Rename and delete for one conversation.
 *
 * Delete asks a second time in place rather than through `confirm()`: the
 * native dialog is the one piece of UI here that cannot be styled, cannot be
 * dismissed by tapping beside it, and on a phone arrives as a system alert over
 * an app that otherwise never shows one.
 */
function Menu({
  onMarkRead,
  archived,
  onArchive,
  confirming,
  readOnly,
  onRename,
  onLabel,
  onOpenProcesses,
  onAskDelete,
  onDelete,
  onDismiss,
}: {
  onMarkRead?(): void;
  archived: boolean;
  onArchive(): void;
  confirming: boolean;
  readOnly: boolean;
  onRename(): void;
  onLabel(): void;
  onOpenProcesses(): void;
  onAskDelete(): void;
  onDelete(): void;
  onDismiss(): void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="收起菜单"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onDismiss}
      />
      <div
        role="menu"
        className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-xl border border-line-strong bg-surface py-1 shadow-[0_8px_30px_rgb(0_0_0_/0.35)]"
      >
        {confirming && !readOnly ? (
          <>
            <p className="px-3 py-1.5 text-[11px] leading-snug text-muted">
              删掉之后没有回收站，对话和 agent 那边的记录都会消失。
            </p>
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-danger hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={onDelete}
            >
              确认删除
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-muted hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={onDismiss}
            >
              取消
            </button>
          </>
        ) : (
          <>
            {!readOnly && (
              <button
                type="button"
                role="menuitem"
                className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised"
                onClick={onArchive}
              >
                {archived ? "恢复会话" : "归档会话"}
              </button>
            )}
            {onMarkRead && <button type="button" role="menuitem" className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised" onClick={onMarkRead}>标为已读</button>}
            {!readOnly ? (
              <button
                type="button"
                role="menuitem"
                className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
                onClick={onRename}
              >
                重命名
              </button>
            ) : null}
            {!readOnly ? (
              <button
                type="button"
                role="menuitem"
                className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
                onClick={onLabel}
              >
                标签
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={onOpenProcesses}
            >
              后台进程
            </button>
            {!readOnly ? (
              <button
                type="button"
                role="menuitem"
                className="flex min-h-10 w-full items-center px-3 text-left text-sm text-danger hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
                onClick={onAskDelete}
              >
                删除
              </button>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** The row itself becomes the field, so the name is edited where it is read. */
function Rename({
  initial,
  label = "会话名称",
  onCommit,
  onCancel,
}: {
  initial: string;
  label?: string;
  onCommit(title: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.select();
  }, []);

  const commit = () => {
    const name = value.trim();
    // An empty field means "I changed my mind", not "call it nothing": the
    // daemon would refuse it anyway, and a row with no name is unusable.
    if (!name) return onCancel();
    onCommit(name);
  };

  return (
    <input
      ref={field}
      aria-label={label}
      className="min-h-11 w-full rounded-lg border border-accent bg-surface px-2 text-base text-fg outline-none md:min-h-0 md:rounded-md md:py-1.5 md:text-xs"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

/** Mirrors the daemon's limit so an over-long label is refused before it is sent. */
const MAX_LABEL_CHARS = 10;

/**
 * Add, remove and rename a conversation's labels in place.
 *
 * A rename is one `remove` + `add` request, so another device never sees the
 * label briefly missing.
 */
function LabelEditor({
  labels,
  onChange,
  onDone,
}: {
  labels: string[];
  onChange(change: { add?: string[]; remove?: string[] }): Promise<boolean>;
  onDone(): void;
}) {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, [renaming]);

  const commit = async () => {
    const label = draft.trim();
    if (!label) return setRenaming(null);
    if ([...label].length > MAX_LABEL_CHARS) return setError(`标签最多 ${MAX_LABEL_CHARS} 个字符`);
    if (await onChange({ add: [label], remove: renaming ? [renaming] : [] })) {
      setDraft("");
      setRenaming(null);
      setError("");
    }
  };

  return (
    <div role="group" aria-label="会话标签" className="mx-1 mb-2 rounded-lg border border-line-strong bg-surface p-2 text-xs">
      {labels.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1">
          {labels.map((label) => (
            <li key={label} className={`inline-flex items-center rounded text-accent ${label === renaming ? "bg-accent/25" : "bg-accent/10"}`}>
              <button type="button" aria-label={`修改标签 ${label}`} className="min-h-8 px-1.5" onClick={() => { setRenaming(label); setDraft(label); setError(""); }}>{label}</button>
              <button type="button" aria-label={`删除标签 ${label}`} className="min-h-8 px-1.5 text-muted hover:text-danger" onClick={() => void onChange({ remove: [label] })}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          ref={field}
          aria-label={renaming ? `把标签 ${renaming} 改为` : "添加标签"}
          placeholder={renaming ? "新的标签名，回车确认" : "添加标签，回车确认"}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setError(""); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              if (renaming) { setRenaming(null); setDraft(""); } else onDone();
            }
          }}
          className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-base text-fg outline-none focus:border-accent md:text-xs"
        />
        <button type="button" className="min-h-9 shrink-0 px-2 text-accent" onClick={onDone}>完成</button>
      </div>
      {error ? <p role="alert" className="mt-1 text-danger">{error}</p> : <p className="mt-1 text-faint">每个标签最多 {MAX_LABEL_CHARS} 个字符；点标签可修改。</p>}
    </div>
  );
}

/** The daemon names a session from its first message; long-lived team role sessions update `description` as milestones advance. */
const title = (session: SessionSummary, preferDescription = false) =>
  (preferDescription && session.description?.trim()) || session.title || "新会话";

/**
 * Why a conversation sitting in this workspace cannot be opened by this build.
 *
 * Sessions are stored with the code, so a beta and a release share them. The
 * beta may write a shape the release does not know how to read, and reading it
 * anyway would show the wrong thing rather than less.
 */
const whyUnsupported = (format: NonNullable<SessionSummary["unsupported"]>) =>
  `这个会话由更新版本的 GeneHub 写入（数据格式 ${format.written}，当前版本读到 ${format.supported}），升级后才能打开。`;

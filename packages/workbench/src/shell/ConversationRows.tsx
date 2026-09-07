import type {
  SessionSummary,
  WorkspaceInfo,
} from "@genehub/proto";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { readLocalDraft } from "../session/localConversation";
import { useWorkbench } from "../session/store";
import { SessionProcessesDialog } from "../processes/SessionProcessesDialog";
import { Info } from "lucide-react";
import { relativeTime } from "../ui/relativeTime";
import { useAgentActivity } from "../workspace/useAgentActivity";
import { inAgentGroup, useAgentGroups } from "../workspace/agentGroups";
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
  density = "auto",
  expanded,
  onExpand,
  childCount = 0,
  actions = true,
}: {
  browse?: boolean;
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
  return (
    <li data-density={density} className="entity-row group relative mb-1">
      {editing ? (
        <Rename
          initial={workspace.name}
          label="专家名称"
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
            <span className="relative shrink-0"><AgentAvatar id={workspace.id} name={workspace.name} />{activity.status && <span className="absolute -top-1 -right-1 rounded-full bg-sidebar p-0.5"><SessionStatusIcon status={activity.status} /></span>}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="entity-title truncate text-sm leading-6">
                {workspace.name}
              </span>
              <span className="entity-secondary agent-meta block truncate text-xs font-normal leading-5 text-muted" title={activity.count === undefined ? "完整会话摘要尚未加载" : "会话数量包含已归档；时间为最近一条会话记录"}>
                {activity.count === undefined ? (activity.error ? "会话信息暂不可用" : "正在读取会话…") : `${relativeTime(activity.recent ?? 0)} · ${activity.count} 个会话`}
              </span>
            </span>
          </button>
          <div className="agent-row-actions">
            {onNewSession && <button type="button" aria-label={`与 ${workspace.name} 新建会话`} title="新建会话" className="agent-new min-h-11 rounded-lg px-2 text-xs font-medium text-accent hover:bg-raised" onClick={onNewSession}>＋ 新会话</button>}
          {relationAnomaly ? (
            <span className="text-[9px] text-danger" title="Parent 关系异常">
              !
            </span>
          ) : null}
          {childCount > 0 && onExpand && (
            <button
              type="button"
              aria-label={`${expanded ? "收起" : "展开"} ${workspace.name} 的子专家`}
              aria-expanded={expanded}
              onClick={onExpand}
              className="entity-expand flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised"
            >
              <span aria-hidden>{expanded ? "⌃" : "⌄"}</span>
            </button>
          )}
          {!actions && !environment?.onOverview && <button type="button" aria-label={`${workspace.name} 的详情`} title="专家详情" className="flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={openDetails}><Info size={17} /></button>}
          {actions && (
            <button
              type="button"
              aria-label={`${workspace.name} 的专家操作`}
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
            aria-label="收起专家操作"
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
                  ? "先停止这个专家中正在运行或等待的会话"
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
            从列表移除「{workspace.name}」？
          </p>
          <p className="mt-1 leading-relaxed text-muted">
            文件和会话不会删除；以后重新打开同一专家即可继续。
          </p>
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
                void onRemove().finally(() => {
                  setRemoveBusy(false);
                  setRemoving(false);
                });
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
  ...actions
}: {
  density?: "auto" | "comfortable" | "compact";
  sessions: ListedSession[];
  workspaces: WorkspaceInfo[];
  activeSessionId: string | null;
} & RowActions) {
  const machine = useWorkbench((s) => s.client?.identity?.machineId ?? "");
  const { groups } = useAgentGroups(machine);
  return (
    <ul
      data-density={density}
      className="entity-list conversation-list space-y-1"
      aria-label="最近会话"
    >
      {[...sessions]
        .sort(
          (left, right) =>
            (right.messagePreview?.atMs ?? right.updatedAtMs) -
            (left.messagePreview?.atMs ?? left.updatedAtMs),
        )
        .map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            groupNames={groups.filter((g) => inAgentGroup(session, g)).map((g) => g.name)}
            active={session.id === activeSessionId}
            project={workspaces.find(({ id }) => id === session.workspaceId)}
            {...actions}
          />
        ))}
    </ul>
  );
}

function SessionRow({
  session,
  active,
  project,
  groupNames,
  onPickSession,
  onRename,
  onDelete,
  selection,
}: {
  session: ListedSession;
  active: boolean;
  project?: WorkspaceInfo;
  groupNames: string[];
} & RowActions) {
  const [menu, setMenu] = useState<"shut" | "open" | "confirming">("shut");
  const [editing, setEditing] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  // Written by a newer build into this project's folder. Listed, so the
  // conversation does not appear to have vanished, but not openable here.
  const draftText = readLocalDraft(
    `${useWorkbench.getState().client?.identity?.machineId ?? ""}:${session.id}`,
  ).text;
  const messageDate = new Date(
    session.messagePreview?.atMs ?? session.updatedAtMs,
  );
  const unsupported = session.unsupported;
  const managedReadOnly = session.managed?.userInteraction === "readOnly";

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
    <li className="conversation-row group relative flex items-center">
      {selection && <input type="checkbox" aria-label={`选择 ${title(session)}`} checked={selection.ids.has(session.id)} disabled={selection.disabled} onChange={() => selection.toggle(session.id)} className="ml-2 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" />}
      <button
        type="button"
        disabled={selection ? selection.disabled : Boolean(unsupported)}
        title={unsupported ? whyUnsupported(unsupported) : undefined}
        className={`entity-main conversation-main flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left text-sm ${
          unsupported
            ? "cursor-not-allowed text-faint"
            : active
              ? "bg-raised text-fg"
              : "text-muted hover:bg-sidebar-hover hover:text-fg"
        }`}
        onClick={() => selection ? selection.toggle(session.id) : onPickSession(session.id)}
      >
        <span className="relative shrink-0">
          <AgentAvatar id={session.workspaceId} name={project?.name ?? "专家"} />
          {["waiting", "running", "failed"].includes(session.status) && <span className="absolute -top-1 -right-1 rounded-full bg-sidebar p-0.5"><SessionStateIcon session={session} /></span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{title(session)}</span>
          <span className="entity-secondary mt-1 flex min-w-0 items-center gap-1 text-xs text-muted" title={`${messageDate.toLocaleString()} · ${project?.name ?? "专家"}${groupNames.length ? " · " + groupNames.join("、") : ""}`}>
            <time dateTime={messageDate.toISOString()} className="shrink-0">{relativeTime(messageDate.getTime())}</time>
            <span className="truncate">· {project?.name ?? "专家"}{groupNames.length ? ` · ${groupNames.join("、")}` : ""}{draftText ? " · 草稿" : ""}{managedReadOnly ? " · 只读" : ""}{unsupported ? " · 需升级" : ""}</span>
          </span>
        </span>
      </button>

      {!selection && <button
        type="button"
        aria-label={`${title(session)} 的更多操作`}
        aria-expanded={menu !== "shut"}
        // Always there on a touch screen: hover is the one interaction a phone
        // cannot perform, and hiding the only way to delete a conversation
        // behind it is how this ended up missing entirely.
        className="conversation-row-more flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sidebar-hover hover:text-fg"
        onClick={() => setMenu((state) => (state === "shut" ? "open" : "shut"))}
      >
        <span aria-hidden>⋯</span>
      </button>}

      {menu === "shut" || selection ? null : (
        <Menu
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
  archived,
  onArchive,
  confirming,
  readOnly,
  onRename,
  onOpenProcesses,
  onAskDelete,
  onDelete,
  onDismiss,
}: {
  archived: boolean;
  onArchive(): void;
  confirming: boolean;
  readOnly: boolean;
  onRename(): void;
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

function SessionStateIcon({ session }: { session: ListedSession }) {
  return <SessionStatusIcon status={session.status} unread={session.unread} />;
}

/** The daemon names a session from its first message; until then this stands in. */
const title = (session: SessionSummary) => session.title || "新会话";

/**
 * Why a conversation sitting in this workspace cannot be opened by this build.
 *
 * Sessions are stored with the code, so a beta and a release share them. The
 * beta may write a shape the release does not know how to read, and reading it
 * anyway would show the wrong thing rather than less.
 */
const whyUnsupported = (format: NonNullable<SessionSummary["unsupported"]>) =>
  `这个会话由更新版本的 GeneHub 写入（数据格式 ${format.written}，当前版本读到 ${format.supported}），升级后才能打开。`;

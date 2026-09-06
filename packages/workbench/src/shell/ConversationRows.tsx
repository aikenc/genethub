import type {
  AgentSpaceBuilderOperation,
  SessionSummary,
  WorkspaceInfo,
} from "@genehub/proto";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { readLocalDraft } from "../session/localConversation";
import { useWorkbench } from "../session/store";
import { SessionProcessesDialog } from "../processes/SessionProcessesDialog";
import { WorkspaceIcon } from "../workspace/WorkspaceIcon";
import { isDescendant } from "../workspace/agent-space-tree";
import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import { SessionStatusIcon } from "./SessionStatusIcon";

interface RowActions {
  onPickSession(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onDelete(sessionId: string): void;
}

type ListedSession = SessionSummary & { unread: boolean };

/** Every workspace, with its conversations under it. */
export function WorkspaceRow({
  workspace,
  workspaces,
  breadcrumb,
  projectWorkspaceId,
  relationAnomaly,
  running,
  shut,
  active,
  deviceName,
  onToggle,
  onPick,
  onRename,
  onRemove,
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
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [componentId, setComponentId] = useState("worker");
  const [workerRole, setWorkerRole] = useState("tester");
  const [parentId, setParentId] = useState(
    workspace.agentSpace?.parentWorkspaceId ?? "",
  );
  const [lifecycle, setLifecycle] = useState(
    workspace.agentSpace?.lifecycle ?? "persistent",
  );
  const [builderSummary, setBuilderSummary] = useState<string | null>(null);
  const configureAgentSpace = useWorkbench(
    (state) => state.configureAgentSpace,
  );
  const inspectAgentSpaceBuild = useWorkbench(
    (state) => state.inspectAgentSpaceBuild,
  );
  const revision = workspace.agentSpace?.revision ?? 0;
  useEffect(() => {
    setParentId(workspace.agentSpace?.parentWorkspaceId ?? "");
    setLifecycle(workspace.agentSpace?.lifecycle ?? "persistent");
  }, [workspace.id, revision]);
  const mutate = async (
    operation: Parameters<typeof configureAgentSpace>[2],
  ) => {
    setSpaceBusy(true);
    try {
      await configureAgentSpace(workspace.id, revision, operation);
    } finally {
      setSpaceBusy(false);
    }
  };
  const inspectBuild = async (operation: AgentSpaceBuilderOperation) => {
    setSpaceBusy(true);
    try {
      const report = await inspectAgentSpaceBuild(
        projectWorkspaceId,
        workspace.id,
        operation,
      );
      setBuilderSummary(report ? `${report.status} · ${report.command}` : null);
    } finally {
      setSpaceBusy(false);
    }
  };
  const parentChoices = workspaces.filter(
    (candidate) =>
      candidate.id !== workspace.id &&
      !isDescendant(workspaces, candidate.id, workspace.id),
  );
  return (
    <li data-density={density} className="entity-row group relative mb-1">
      {editing ? (
        <Rename
          initial={workspace.name}
          label="Agent 名称"
          onCommit={(name) => {
            setEditing(false);
            onRename(name);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          className={`flex min-h-14 w-full items-center gap-1 rounded-md pr-1 text-sm ${active ? "bg-raised text-fg" : "text-fg"}`}
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
            <span className="entity-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <WorkspaceIcon workspace={workspace} className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="entity-title truncate text-base leading-6">
                {workspace.name}
              </span>
              <span
                className={`entity-secondary block truncate text-xs font-normal leading-5 ${
                  workspace.agentSpace?.health?.status === "unhealthy"
                    ? "text-danger"
                    : "text-muted"
                }`}
                title={
                  workspace.agentSpace ? componentSummary(workspace) : undefined
                }
              >
                {workspace.agentSpace
                  ? componentSummary(workspace)
                  : `${workspace.folders.length} 个目录`}
              </span>
            </span>
          </button>
          {relationAnomaly ? (
            <span className="text-[9px] text-danger" title="Parent 关系异常">
              !
            </span>
          ) : null}
          {running > 0 ? (
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
              {running}
            </span>
          ) : null}
          {childCount > 0 && onExpand && (
            <button
              type="button"
              aria-label={`${expanded ? "收起" : "展开"} ${workspace.name} 的子 Agent`}
              aria-expanded={expanded}
              onClick={onExpand}
              className="entity-expand flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised"
            >
              <span aria-hidden>{expanded ? "⌃" : "⌄"}</span>
            </button>
          )}
          {actions && (
            <button
              type="button"
              aria-label={`${workspace.name} 的 Agent 操作`}
              aria-expanded={menu}
              className="flex h-10 w-8 shrink-0 items-center justify-center rounded text-faint hover:bg-sidebar-hover hover:text-fg md:h-7 md:w-6 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
              onClick={() => setMenu((open) => !open)}
            >
              <span aria-hidden>⋯</span>
            </button>
          )}
        </div>
      )}
      {menu ? (
        <>
          <button
            type="button"
            aria-label="收起 Agent 操作"
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
                setDetails(true);
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
                  ? "先停止这个 Agent中正在运行或等待的会话"
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
      {details ? (
        <WorkspaceDetailsDialog onClose={() => setDetails(false)}>
          <Detail label="名称" value={workspace.name} />
          {workspace.workspaceFile ? (
            <Detail label="配置文件" value={workspace.workspaceFile} />
          ) : null}
          {(workspace.folders?.length
            ? workspace.folders
            : [
                {
                  name: workspace.name,
                  root: workspace.root,
                  rootHandle: "",
                },
              ]
          ).map((folder, index) => (
            <Detail
              key={folder.root}
              label={index === 0 ? "主目录" : folder.name}
              value={folder.root}
            />
          ))}
          <Detail label="所属设备" value={deviceName} />
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-fg">Agent 配置</span>
              <span className="text-[10px] text-faint">
                revision {revision}
              </span>
            </div>
            {workspace.agentSpace ? (
              <>
                <Detail label="位置" value={breadcrumb} />
                <Detail
                  label="健康"
                  value={workspace.agentSpace.health?.status ?? "unknown"}
                />
                {(workspace.agentSpace.health?.reasons ?? []).map((reason) => (
                  <p key={reason} className="py-0.5 text-[10px] text-danger">
                    {reason}
                  </p>
                ))}
                <Detail
                  label="生命周期"
                  value={workspace.agentSpace.lifecycle}
                />
                <Detail
                  label="Builder"
                  value={workspace.agentSpace.builderLockDigest || "未验证"}
                />
                {workspace.agentSpace.bootstrapPack ? (
                  <Detail
                    label="Pack"
                    value={`${workspace.agentSpace.bootstrapPack.id} v${workspace.agentSpace.bootstrapPack.version}`}
                  />
                ) : null}
                <div className="mt-2 space-y-1" aria-label="Component 列表">
                  {workspace.agentSpace.components.map((component) => (
                    <div
                      key={component.componentId}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {component.componentId}
                        {component.role ? `:${component.role}` : ""}
                        {` · v${component.schemaVersion}`}
                        {!component.enabled ? " · 已停用" : ""}
                      </span>
                      <button
                        type="button"
                        disabled={spaceBusy}
                        className="rounded px-1 text-[10px] text-accent hover:bg-raised disabled:opacity-40"
                        onClick={() =>
                          void mutate({
                            kind: "setComponent",
                            componentId: component.componentId,
                            enabled: !component.enabled,
                            role: component.role ?? null,
                          })
                        }
                      >
                        {component.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        disabled={spaceBusy}
                        className="rounded px-1 text-[10px] text-danger hover:bg-raised disabled:opacity-40"
                        onClick={() =>
                          void mutate({
                            kind: "removeComponent",
                            componentId: component.componentId,
                          })
                        }
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-1 leading-relaxed text-muted">
                尚未注册为 AgentSpace。添加 Component 时内核会先验证当前目录的
                AgentSpaceBuilder 投影。
              </p>
            )}

            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1">
              <select
                aria-label="要添加的 Component"
                value={componentId}
                onChange={(event) => setComponentId(event.target.value)}
                className="min-w-0 rounded border border-line bg-raised px-2 py-1 text-fg"
              >
                <option value="pm">PM</option>
                <option value="executor">Executor</option>
                <option value="worker">Worker</option>
                <option value="reviewer">Reviewer</option>
              </select>
              {componentId === "worker" ? (
                <input
                  aria-label="Worker role"
                  value={workerRole}
                  onChange={(event) => setWorkerRole(event.target.value)}
                  placeholder="role，例如 tester"
                  className="min-w-0 rounded border border-line bg-raised px-2 py-1 text-fg"
                />
              ) : (
                <span />
              )}
            </div>
            <button
              type="button"
              disabled={
                spaceBusy || (componentId === "worker" && !workerRole.trim())
              }
              className="mt-1 w-full rounded bg-accent px-2 py-1 text-white disabled:opacity-40"
              onClick={() =>
                void mutate({
                  kind: "setComponent",
                  componentId,
                  enabled: true,
                  role: componentId === "worker" ? workerRole.trim() : null,
                })
              }
            >
              添加或更新 Component
            </button>

            <div className="mt-3 flex gap-1">
              <select
                aria-label="Parent AgentSpace"
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
                className="min-w-0 flex-1 rounded border border-line bg-raised px-2 py-1 text-fg"
              >
                <option value="">无 Parent（项目根）</option>
                {parentChoices.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={spaceBusy || !workspace.agentSpace}
                className="rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() =>
                  void mutate({
                    kind: "setParent",
                    parentWorkspaceId: parentId || null,
                  })
                }
              >
                保存 Parent
              </button>
            </div>

            <div className="mt-2 flex gap-1">
              <select
                aria-label="AgentSpace 生命周期"
                value={lifecycle}
                onChange={(event) => setLifecycle(event.target.value)}
                className="min-w-0 flex-1 rounded border border-line bg-raised px-2 py-1 text-fg"
              >
                <option value="persistent">persistent</option>
                <option value="pooled">pooled</option>
                <option value="ephemeral">ephemeral</option>
              </select>
              <button
                type="button"
                disabled={spaceBusy || !workspace.agentSpace}
                className="rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() => void mutate({ kind: "setLifecycle", lifecycle })}
              >
                保存生命周期
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1">
              {!workspace.agentSpace ? (
                <>
                  <button
                    type="button"
                    disabled={spaceBusy}
                    className="rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:opacity-40"
                    onClick={() => void inspectBuild({ kind: "init" })}
                  >
                    Builder 初始化
                  </button>
                  <button
                    type="button"
                    disabled={spaceBusy}
                    className="rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:opacity-40"
                    onClick={() =>
                      void inspectBuild({
                        kind: "build",
                        dryRun: false,
                        requireNoPostCommands: true,
                      })
                    }
                  >
                    Builder Build
                  </button>
                </>
              ) : null}
              <button
                type="button"
                disabled={spaceBusy}
                className="flex-1 rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() => void inspectBuild({ kind: "check" })}
              >
                Builder Check
              </button>
              <button
                type="button"
                disabled={spaceBusy}
                className="flex-1 rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() => void inspectBuild({ kind: "verify" })}
              >
                Builder Verify
              </button>
            </div>
            {builderSummary ? (
              <p className="mt-1 text-[10px] text-muted">{builderSummary}</p>
            ) : null}
          </div>
        </WorkspaceDetailsDialog>
      ) : null}
      {removing ? (
        <div className="mx-1 mb-2 rounded-lg border border-line-strong bg-surface p-3 text-xs">
          <p className="font-medium text-fg">
            从列表移除「{workspace.name}」？
          </p>
          <p className="mt-1 leading-relaxed text-muted">
            文件和会话不会删除；以后重新打开同一Agent即可继续。
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2 py-1">
      <span className="text-faint">{label}</span>
      <span className="break-all text-fg">{value}</span>
    </div>
  );
}

function componentSummary(workspace: WorkspaceInfo): string {
  const components =
    workspace.agentSpace?.components
      .filter((component) => component.enabled)
      .map((component) =>
        component.componentId === "worker" && component.role
          ? component.role
          : component.componentId,
      ) ?? [];
  return components.length > 0 ? components.join(" · ") : "AgentSpace";
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
  onPickSession,
  onRename,
  onDelete,
}: {
  session: ListedSession;
  active: boolean;
  project?: WorkspaceInfo;
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
  const messageTime =
    messageDate.toLocaleDateString() === new Date().toLocaleDateString()
      ? messageDate.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : messageDate.toLocaleDateString("zh-CN", {
          month: "numeric",
          day: "numeric",
        });
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
    <li className="group relative flex items-center">
      <button
        type="button"
        disabled={Boolean(unsupported)}
        title={unsupported ? whyUnsupported(unsupported) : undefined}
        className={`entity-main conversation-main flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left text-sm ${
          unsupported
            ? "cursor-not-allowed text-faint"
            : active
              ? "bg-raised text-fg"
              : "text-muted hover:bg-sidebar-hover hover:text-fg"
        }`}
        onClick={() => onPickSession(session.id)}
      >
        <SessionStateIcon session={session} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-base font-medium">
              {title(session)}
              <span className="ml-2 text-xs font-normal text-muted">
                · {project?.name ?? "Agent"}
              </span>
            </span>
            <time
              dateTime={messageDate.toISOString()}
              className="shrink-0 text-xs text-faint"
            >
              {messageTime}
            </time>
          </span>
          <span className="entity-secondary block truncate text-xs text-muted">
            {draftText
              ? `[草稿] ${draftText}`
              : (session.messagePreview?.text ?? "")}{" "}
            · {managedReadOnly ? "受管 · 只读" : session.agentId}
            {unsupported ? " · 需升级" : ""}
          </span>
        </span>
      </button>

      <button
        type="button"
        aria-label={`${title(session)} 的更多操作`}
        aria-expanded={menu !== "shut"}
        // Always there on a touch screen: hover is the one interaction a phone
        // cannot perform, and hiding the only way to delete a conversation
        // behind it is how this ended up missing entirely.
        className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-sidebar-hover hover:text-fg md:h-7 md:w-6 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
        onClick={() => setMenu((state) => (state === "shut" ? "open" : "shut"))}
      >
        <span aria-hidden>⋯</span>
      </button>

      {menu === "shut" ? null : (
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

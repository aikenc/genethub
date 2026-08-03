import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Endpoint, Host, Target } from "../host";
import { useWorkbench } from "../session/store";
import { OpenProject } from "../workspace/OpenProject";
import type { ExtraTab } from "./tabs";
import { TargetSwitcher } from "./TargetSwitcher";

/**
 * The left edge of the workbench.
 *
 * Projects, and the conversations inside each. It used to be a `<select>` for
 * the project and one flat list of the current project's sessions, which meant
 * the two questions someone actually arrives with — what am I working on, and
 * where is that thing I was doing yesterday — both needed the dropdown opened
 * first. Everything is on screen now, because the daemon hands back every
 * workspace's sessions in one call.
 *
 * On a phone this is a drawer over the conversation, not a panel above it. It
 * used to be a 16rem-tall strip that pushed the chat down, which gave the list
 * four visible rows and the chat the rest of a screen it no longer fitted.
 *
 * Settings lives at the bottom as chrome, not as a fifth "mode" competing with
 * the chat.
 */
export function Sidebar({
  host,
  open,
  hidden = false,
  extraTabs = [],
  endpoint = null,
  onPickTarget,
  onNavigate,
}: {
  host: Host;
  /** The phone's drawer. Covers the conversation, so it starts shut. */
  open: boolean;
  /** Someone on a desktop asking for the room back (the 视图 menu). */
  hidden?: boolean;
  extraTabs?: ExtraTab[];
  /** Which machine everything below is coming from. */
  endpoint?: Endpoint | null;
  onPickTarget?(target: Target, endpoint: Endpoint): void;
  onNavigate(): void;
}) {
  const {
    sessions,
    activeSessionId,
    selectSession,
    workspaces,
    activeWorkspaceId,
    selectWorkspace,
    renameWorkspace,
    newSession,
    renameSession,
    deleteSession,
    openTab,
    connection,
  } = useWorkbench();

  const [grouping, setGrouping] = useState<Grouping>(() => recall(GROUPING_KEY, "project"));
  const [collapsed, setCollapsed] = useState<string[]>(() => recall(COLLAPSED_KEY, []));
  const [query, setQuery] = useState("");

  const workspace = workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];

  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () => (needle ? sessions.filter((session) => title(session).toLowerCase().includes(needle)) : sessions),
    [sessions, needle],
  );

  const go = (sessionId: string) => {
    void selectSession(sessionId);
    onNavigate();
  };

  const actions = {
    onRename: (sessionId: string, name: string) => void renameSession(sessionId, name),
    onDelete: (sessionId: string) => void deleteSession(sessionId),
  };

  const toggle = (workspaceId: string) =>
    setCollapsed((current) => {
      const next = current.includes(workspaceId)
        ? current.filter((id) => id !== workspaceId)
        : [...current, workspaceId];
      remember(COLLAPSED_KEY, next);
      return next;
    });

  return (
    <>
      {/* Tapping beside the drawer shuts it, which is what every phone app
          trains people to try first. Only on phones: on a desktop the sidebar
          is part of the layout and has nothing beside it to tap. */}
      {open ? (
        <button
          type="button"
          aria-label="关闭会话列表"
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onNavigate}
        />
      ) : null}

      <aside
        // `invisible` and not just a transform: an off-screen drawer is still
        // in the document, and a keyboard or a screen reader would otherwise
        // walk straight into a list nobody can see.
        className={`fixed inset-y-0 left-0 z-40 flex w-[84%] max-w-xs flex-col border-r border-line bg-sidebar transition-transform duration-200 md:visible md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 md:transition-none ${
          open ? "visible translate-x-0" : "invisible -translate-x-full"
        } ${hidden ? "md:hidden" : "md:flex"}`}
      >
        <div
          className="flex flex-col gap-2 border-b border-line px-3 pb-3"
          // The drawer runs to the top of the screen on a phone, so its first
          // control would otherwise sit under the notch.
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          {onPickTarget ? (
            <TargetSwitcher
              host={host}
              current={endpoint}
              onPick={onPickTarget}
              onNavigate={onNavigate}
            />
          ) : null}
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-medium text-white disabled:opacity-40 md:min-h-0 md:rounded-md md:py-1.5 md:text-xs"
            disabled={!workspace}
            // No agent named: the store keeps whichever one is in front of the
            // user, and falls back to the built-in when there is none.
            onClick={() => {
              newSession(workspace?.id ?? null, null);
              onNavigate();
            }}
          >
            <span aria-hidden>+</span>
            新建会话
          </button>
          {sessions.length > 0 ? (
            <input
              type="search"
              aria-label="搜索会话"
              placeholder="搜索会话"
              className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:min-h-0 md:rounded-md md:px-2 md:py-1.5 md:text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
        </div>

        {/* Nothing to group by until there is a project, and a lone "按状态"
            above an empty list is a control for a list that does not exist. */}
        <div
          className={`${
            workspaces.length > 0 ? "flex" : "hidden"
          } items-center justify-between px-3 pt-2 text-[10px] uppercase tracking-wide text-faint`}
        >
          <span>{grouping === "project" ? "工作区" : "状态"}</span>
          <button
            type="button"
            // Kept, because the two questions are different: "what is running
            // right now" cuts across projects, and answering it used to be the
            // only thing this list did.
            className="rounded px-2 py-1.5 normal-case tracking-normal hover:bg-sidebar-hover hover:text-fg md:px-1.5 md:py-0.5"
            onClick={() => {
              const next = grouping === "project" ? "status" : "project";
              remember(GROUPING_KEY, next);
              setGrouping(next);
            }}
          >
            {grouping === "project" ? "按状态" : "按项目"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-2">
          {grouping === "project" ? (
            <Projects
              workspaces={workspaces}
              sessions={matching}
              // While searching, a collapsed project would hide the very thing
              // that was found — and a search that silently finds nothing is
              // indistinguishable from one that found nothing.
              collapsed={needle ? [] : collapsed}
              activeSessionId={activeSessionId}
              activeWorkspaceId={workspace?.id ?? null}
              deviceName={endpoint?.label ?? "当前设备"}
              onToggle={toggle}
              onPickWorkspace={(id) => {
                void selectWorkspace(id);
                onNavigate();
              }}
              onRenameWorkspace={(id, name) => void renameWorkspace(id, name)}
              onPickSession={go}
              {...actions}
            />
          ) : (
            <Statuses
              sessions={matching}
              workspaces={workspaces}
              activeSessionId={activeSessionId}
              onPickSession={go}
              {...actions}
            />
          )}

          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-xs text-faint">还没有会话。</p>
          ) : matching.length === 0 ? (
            <p className="px-2 py-3 text-xs text-faint">没有匹配「{query.trim()}」的会话。</p>
          ) : null}
        </div>

        <div className="border-t border-line px-3 py-2">
          <OpenProject host={host} compact onOpened={onNavigate} />
        </div>

        <div
          className="hidden items-center gap-1 border-t border-line px-2 py-2 md:flex"
          style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          <StatusDot connection={connection} />
          <Entry label="文件" onClick={() => openTab("files")} onNavigate={onNavigate} />
          <Entry label="终端" onClick={() => openTab("terminal")} onNavigate={onNavigate} />
          <Entry label="设备" onClick={() => openTab("devices")} onNavigate={onNavigate} />
          {extraTabs.map((tab) => (
            <Entry
              key={tab.id}
              label={tab.label}
              onClick={() => openTab(`extra:${tab.id}`, tab.label)}
              onNavigate={onNavigate}
            />
          ))}
          <button
            type="button"
            aria-label="设置"
            className="ml-auto flex h-11 w-11 items-center justify-center rounded-lg text-base text-muted hover:bg-sidebar-hover hover:text-fg md:h-auto md:w-auto md:px-2 md:py-1 md:text-xs"
            onClick={() => {
              openTab("settings");
              onNavigate();
            }}
          >
            ⚙
          </button>
        </div>
      </aside>
    </>
  );
}

function Entry({
  label,
  onClick,
  onNavigate,
}: {
  label: string;
  onClick(): void;
  onNavigate(): void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-11 items-center rounded-lg px-3 text-sm text-muted hover:bg-sidebar-hover hover:text-fg md:min-h-0 md:rounded md:px-2 md:py-1 md:text-xs"
      onClick={() => {
        onClick();
        onNavigate();
      }}
    >
      {label}
    </button>
  );
}

/** What every list of conversations needs to be able to do to one. */
interface RowActions {
  onPickSession(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onDelete(sessionId: string): void;
}

/** Every project, with its conversations under it. */
function Projects({
  workspaces,
  sessions,
  collapsed,
  activeSessionId,
  activeWorkspaceId,
  deviceName,
  onToggle,
  onPickWorkspace,
  onRenameWorkspace,
  ...actions
}: {
  workspaces: WorkspaceInfo[];
  sessions: SessionSummary[];
  collapsed: string[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  deviceName: string;
  onToggle(workspaceId: string): void;
  onPickWorkspace(workspaceId: string): void;
  onRenameWorkspace(workspaceId: string, name: string): void;
} & RowActions) {
  return (
    <ul aria-label="工作区">
      {workspaces.map((workspace) => {
        const mine = sessions.filter((session) => session.workspaceId === workspace.id);
        const running = mine.filter((session) => session.status === "running").length;
        const shut = collapsed.includes(workspace.id);
        const rename = (name: string) => {
          if (name !== workspace.name) onRenameWorkspace(workspace.id, name);
        };
        return (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            running={running}
            shut={shut}
            active={workspace.id === activeWorkspaceId}
            deviceName={deviceName}
            onToggle={() => onToggle(workspace.id)}
            onPick={() => onPickWorkspace(workspace.id)}
            onRename={rename}
          >
            {shut ? null : mine.length > 0 ? (
              <ul className="ml-3 border-l border-line pl-1">
                {mine.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    {...actions}
                  />
                ))}
              </ul>
            ) : (
              <p className="ml-4 py-1 pl-2 text-[11px] text-faint">还没有会话</p>
            )}
          </WorkspaceRow>
        );
      })}
    </ul>
  );
}

function WorkspaceRow({
  workspace,
  running,
  shut,
  active,
  deviceName,
  onToggle,
  onPick,
  onRename,
  children,
}: {
  workspace: WorkspaceInfo;
  running: number;
  shut: boolean;
  active: boolean;
  deviceName: string;
  onToggle(): void;
  onPick(): void;
  onRename(name: string): void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  return (
    <li className="group relative mb-1">
      {editing ? (
        <Rename
          initial={workspace.name}
          label="工作区名称"
          onCommit={(name) => {
            setEditing(false);
            onRename(name);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          className={`flex w-full items-center gap-1 rounded-md pr-1 text-sm md:text-xs ${active ? "text-fg" : "text-muted"}`}
        >
          <button
            type="button"
            aria-label={shut ? `展开 ${workspace.name}` : `折叠 ${workspace.name}`}
            aria-expanded={!shut}
            className="flex h-10 w-8 shrink-0 items-center justify-center rounded text-faint hover:bg-sidebar-hover hover:text-fg md:h-auto md:w-auto md:px-1 md:py-1"
            onClick={onToggle}
          >
            <span aria-hidden>{shut ? "▸" : "▾"}</span>
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 truncate py-2 text-left font-medium hover:text-fg md:py-1"
            title={workspace.root}
            onClick={onPick}
          >
            {workspace.name}
          </button>
          {running > 0 ? (
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
              {running}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`${workspace.name} 的目录操作`}
            aria-expanded={menu}
            className="flex h-10 w-8 shrink-0 items-center justify-center rounded text-faint hover:bg-sidebar-hover hover:text-fg md:h-7 md:w-6 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            onClick={() => setMenu((open) => !open)}
          >
            <span aria-hidden>⋯</span>
          </button>
        </div>
      )}
      {menu ? (
        <>
          <button
            type="button"
            aria-label="收起目录操作"
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
          </div>
        </>
      ) : null}
      {details ? (
        <div className="mx-1 mb-2 rounded-lg border border-line bg-surface p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-fg">目录详情</span>
            <button
              type="button"
              aria-label="关闭目录详情"
              className="rounded px-2 py-1 text-faint hover:bg-raised hover:text-fg"
              onClick={() => setDetails(false)}
            >
              ×
            </button>
          </div>
          <Detail label="名称" value={workspace.name} />
          <Detail label="完整路径" value={workspace.root} />
          <Detail label="所属设备" value={deviceName} />
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

/**
 * The other question: what is running, across every project.
 *
 * Each row says which project it belongs to, because without the tree around it
 * a title on its own does not say where the work is happening.
 */
function Statuses({
  sessions,
  workspaces,
  activeSessionId,
  ...actions
}: {
  sessions: SessionSummary[];
  workspaces: WorkspaceInfo[];
  activeSessionId: string | null;
} & RowActions) {
  const working = sessions.filter((session) => session.status === "running");
  const idle = sessions.filter((session) => session.status !== "running");
  const named = (session: SessionSummary) =>
    workspaces.find((entry) => entry.id === session.workspaceId)?.name;

  return (
    <>
      {[
        { label: "Working", rows: working },
        { label: working.length > 0 ? "Ready" : "Sessions", rows: idle },
      ].map(({ label, rows }) =>
        rows.length === 0 ? null : (
          <div key={label} className="mb-3">
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-faint">
              {label}
            </div>
            <ul className="space-y-0.5">
              {rows.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  project={named(session)}
                  {...actions}
                />
              ))}
            </ul>
          </div>
        ),
      )}
    </>
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
  session: SessionSummary;
  active: boolean;
  project?: string;
} & RowActions) {
  const [menu, setMenu] = useState<"shut" | "open" | "confirming">("shut");
  const [editing, setEditing] = useState(false);

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
        className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm md:min-h-0 md:rounded-md md:py-1.5 md:text-xs ${
          active ? "bg-raised text-fg" : "text-muted hover:bg-sidebar-hover hover:text-fg"
        }`}
        onClick={() => onPickSession(session.id)}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            session.status === "running" ? "bg-ok" : "bg-faint"
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{title(session)}</span>
        {project ? <span className="shrink-0 text-[10px] text-faint">{project}</span> : null}
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
          onRename={() => {
            setMenu("shut");
            setEditing(true);
          }}
          onAskDelete={() => setMenu("confirming")}
          onDelete={() => {
            setMenu("shut");
            onDelete(session.id);
          }}
          onDismiss={() => setMenu("shut")}
        />
      )}
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
  confirming,
  onRename,
  onAskDelete,
  onDelete,
  onDismiss,
}: {
  confirming: boolean;
  onRename(): void;
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
        {confirming ? (
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
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={onRename}
            >
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center px-3 text-left text-sm text-danger hover:bg-raised md:min-h-0 md:py-1.5 md:text-xs"
              onClick={onAskDelete}
            >
              删除
            </button>
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

function StatusDot({ connection }: { connection: string }) {
  const ready = connection === "ready";
  return (
    <span
      className={`mx-1 h-1.5 w-1.5 rounded-full ${ready ? "bg-ok" : "bg-faint"}`}
      title={ready ? "已连接" : "未连接"}
      aria-label={ready ? "已连接" : "未连接"}
    />
  );
}

/** The daemon names a session from its first message; until then this stands in. */
const title = (session: SessionSummary) => session.title || "新会话";

type Grouping = "project" | "status";

const GROUPING_KEY = "genehub.sidebar.grouping";
const COLLAPSED_KEY = "genehub.sidebar.collapsed";

/*
 * Which projects are folded shut, and which of the two lists is showing.
 *
 * Local, like the paired machines next door (`devices/machines.ts`): this is
 * how one person arranged one window, and pushing it to the daemon would make
 * a phone rearrange the laptop.
 */
function recall<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked. The arrangement lasts as long as the tab, which is
    // better than refusing to fold a project.
  }
}

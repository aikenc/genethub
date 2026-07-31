import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { useMemo, useState } from "react";

import type { Host } from "../host";
import { useWorkbench } from "../session/store";
import { OpenProject } from "../workspace/OpenProject";
import type { ExtraTab } from "./tabs";

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
 * Settings lives at the bottom as chrome, not as a fifth "mode" competing with
 * the chat.
 */
export function Sidebar({
  host,
  open,
  hidden = false,
  extraTabs = [],
  onNavigate,
}: {
  host: Host;
  /** The phone's drawer. Covers the conversation, so it starts shut. */
  open: boolean;
  /** Someone on a desktop asking for the room back (the 视图 menu). */
  hidden?: boolean;
  extraTabs?: ExtraTab[];
  onNavigate(): void;
}) {
  const {
    sessions,
    activeSessionId,
    selectSession,
    workspaces,
    activeWorkspaceId,
    selectWorkspace,
    agents,
    createSession,
    openTab,
    connection,
  } = useWorkbench();

  const [grouping, setGrouping] = useState<Grouping>(() => recall(GROUPING_KEY, "project"));
  const [collapsed, setCollapsed] = useState<string[]>(() => recall(COLLAPSED_KEY, []));
  const [query, setQuery] = useState("");

  const workspace = workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];

  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () => (needle ? sessions.filter((session) => title(session).toLowerCase().includes(needle)) : sessions),
    [sessions, needle],
  );

  const go = (sessionId: string) => {
    void selectSession(sessionId);
    onNavigate();
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
    <aside
      className={`${open ? "flex" : "hidden"} ${
        hidden ? "md:hidden" : "md:flex"
      } max-h-64 w-full shrink-0 flex-col border-b border-line bg-sidebar md:max-h-none md:w-64 md:border-b-0 md:border-r`}
    >
      <div className="flex flex-col gap-2 border-b border-line px-3 py-3">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
          disabled={!workspace || !builtin}
          onClick={() => {
            if (workspace && builtin) void createSession(workspace.id, builtin.id);
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
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:text-xs"
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
          className="rounded px-1.5 py-0.5 normal-case tracking-normal hover:bg-sidebar-hover hover:text-fg"
          onClick={() => {
            const next = grouping === "project" ? "status" : "project";
            remember(GROUPING_KEY, next);
            setGrouping(next);
          }}
        >
          {grouping === "project" ? "按状态" : "按项目"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
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
            onToggle={toggle}
            onPickWorkspace={(id) => {
              void selectWorkspace(id);
              onNavigate();
            }}
            onPickSession={go}
          />
        ) : (
          <Statuses
            sessions={matching}
            workspaces={workspaces}
            activeSessionId={activeSessionId}
            onPickSession={go}
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

      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
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
          className="ml-auto rounded px-2 py-1 text-xs text-muted hover:bg-sidebar-hover hover:text-fg"
          onClick={() => {
            openTab("settings");
            onNavigate();
          }}
        >
          ⚙
        </button>
      </div>
    </aside>
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
      className="rounded px-2 py-1 text-xs text-muted hover:bg-sidebar-hover hover:text-fg"
      onClick={() => {
        onClick();
        onNavigate();
      }}
    >
      {label}
    </button>
  );
}

/** Every project, with its conversations under it. */
function Projects({
  workspaces,
  sessions,
  collapsed,
  activeSessionId,
  activeWorkspaceId,
  onToggle,
  onPickWorkspace,
  onPickSession,
}: {
  workspaces: WorkspaceInfo[];
  sessions: SessionSummary[];
  collapsed: string[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  onToggle(workspaceId: string): void;
  onPickWorkspace(workspaceId: string): void;
  onPickSession(sessionId: string): void;
}) {
  return (
    <ul aria-label="工作区">
      {workspaces.map((workspace) => {
        const mine = sessions.filter((session) => session.workspaceId === workspace.id);
        const running = mine.filter((session) => session.status === "running").length;
        const shut = collapsed.includes(workspace.id);
        return (
          <li key={workspace.id} className="mb-1">
            <div
              className={`flex w-full items-center gap-1 rounded-md pr-1 text-xs ${
                workspace.id === activeWorkspaceId ? "text-fg" : "text-muted"
              }`}
            >
              <button
                type="button"
                aria-label={shut ? `展开 ${workspace.name}` : `折叠 ${workspace.name}`}
                aria-expanded={!shut}
                className="shrink-0 rounded px-1 py-1 text-faint hover:bg-sidebar-hover hover:text-fg"
                onClick={() => onToggle(workspace.id)}
              >
                <span aria-hidden>{shut ? "▸" : "▾"}</span>
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-1 text-left font-medium hover:text-fg"
                title={workspace.root}
                onClick={() => onPickWorkspace(workspace.id)}
              >
                {workspace.name}
              </button>
              {/* A count only where there is something to count: a "0" next to
                  every idle project is noise on the one screen that has to be
                  scannable. */}
              {running > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-ok">
                  <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
                  {running}
                </span>
              ) : null}
            </div>

            {shut ? null : mine.length > 0 ? (
              <ul className="ml-3 border-l border-line pl-1">
                {mine.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    onSelect={onPickSession}
                  />
                ))}
              </ul>
            ) : (
              <p className="ml-4 py-1 pl-2 text-[11px] text-faint">还没有会话</p>
            )}
          </li>
        );
      })}
    </ul>
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
  onPickSession,
}: {
  sessions: SessionSummary[];
  workspaces: WorkspaceInfo[];
  activeSessionId: string | null;
  onPickSession(sessionId: string): void;
}) {
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
                  onSelect={onPickSession}
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
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  project?: string;
  onSelect(sessionId: string): void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
          active ? "bg-raised text-fg" : "text-muted hover:bg-sidebar-hover hover:text-fg"
        }`}
        onClick={() => onSelect(session.id)}
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
    </li>
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

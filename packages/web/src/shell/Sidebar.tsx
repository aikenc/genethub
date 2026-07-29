import type { Host } from "../host";
import { useWorkbench } from "../session/store";
import { OpenProject } from "../workspace/OpenProject";

/**
 * The left edge of the workbench.
 *
 * Project first, then the sessions that belong to it. Settings lives at the
 * bottom as chrome, not as a fifth "mode" competing with the chat.
 */
export function Sidebar({
  host,
  open,
  onNavigate,
}: {
  host: Host;
  open: boolean;
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
  const workspace = workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];
  const working = sessions.filter((session) => session.status === "running");
  const idle = sessions.filter((session) => session.status !== "running");

  return (
    <aside
      className={`${
        open ? "flex" : "hidden"
      } max-h-64 w-full shrink-0 flex-col border-b border-line bg-sidebar md:flex md:max-h-none md:w-60 md:border-b-0 md:border-r`}
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
        {workspaces.length > 0 ? (
          <select
            aria-label="项目"
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg outline-none"
            value={workspace?.id ?? ""}
            onChange={(event) => void selectWorkspace(event.target.value)}
          >
            {workspaces.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : null}
        <OpenProject host={host} compact onOpened={onNavigate} />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {working.length > 0 ? (
          <SessionGroup
            label="Working"
            sessions={working}
            activeId={activeSessionId}
            onSelect={(id) => {
              void selectSession(id);
              onNavigate();
            }}
          />
        ) : null}
        <SessionGroup
          label={working.length > 0 ? "Ready" : "Sessions"}
          sessions={idle}
          activeId={activeSessionId}
          onSelect={(id) => {
            void selectSession(id);
            onNavigate();
          }}
        />
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs text-faint">还没有会话。</p>
        ) : null}
      </div>

      <div className="mt-auto flex items-center gap-1 border-t border-line px-2 py-2">
        <StatusDot connection={connection} />
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-muted hover:bg-sidebar-hover hover:text-fg"
          onClick={() => {
            openTab("files");
            onNavigate();
          }}
        >
          文件
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-muted hover:bg-sidebar-hover hover:text-fg"
          onClick={() => {
            openTab("terminal");
            onNavigate();
          }}
        >
          终端
        </button>
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

function SessionGroup({
  label,
  sessions,
  activeId,
  onSelect,
}: {
  label: string;
  sessions: Array<{ id: string; title: string; status: string }>;
  activeId: string | null;
  onSelect(id: string): void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-faint">
        {label}
      </div>
      <ul className="space-y-0.5">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                session.id === activeId
                  ? "bg-raised text-fg"
                  : "text-muted hover:bg-sidebar-hover hover:text-fg"
              }`}
              onClick={() => onSelect(session.id)}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  session.status === "running" ? "bg-ok" : "bg-faint"
                }`}
                aria-hidden
              />
              <span className="truncate">{session.title || "新会话"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
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

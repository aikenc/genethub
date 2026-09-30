import type { AgentInfo, SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { useMemo, useState } from "react";

import { resolveAgentPresentation } from "../presentation/catalog/resolve";
import { RecentSessions } from "../shell/ConversationRows";
import { SessionStatusIcon } from "../shell/SessionStatusIcon";
import { ListSearch } from "../ui/ListLayout";
import { WorkspaceAffordance } from "../workspace/WorkspaceAffordance";
import { formatClock } from "./selectionCopy";

/**
 * One session row with everything needed to tell it apart from its neighbours:
 * status, title, Agent and time, and the workspace it lives in. Shared by
 * session-picking surfaces so "which conversation" always looks like the
 * sidebar's answer to the same question.
 */
export function SessionListItem({
  session,
  relatedSessions,
  agent,
  workspace,
  workspaceLabel,
  selected,
  onSelect,
}: {
  session: SessionSummary;
  relatedSessions?: readonly SessionSummary[];
  agent?: AgentInfo;
  /** Resolved from the session's own machine; absent only when it is gone. */
  workspace?: WorkspaceInfo;
  workspaceLabel?: string;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
        selected ? "bg-accent/10 text-fg" : "text-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-fg">{session.title || "新会话"}</span>
        <span className="block text-[11px]"><SessionStatusIcon session={session} sessions={relatedSessions} showLabel /></span>
        <span className="block truncate text-[10px] text-faint">
          {agent ? resolveAgentPresentation(agent).label : session.agentId} ·{" "}
          {formatClock(session.updatedAtMs)}
          {session.managed ? ` · 受管 ${session.managed.role}` : ""}
        </span>
      </span>
      {workspace ? <WorkspaceAffordance workspace={workspace} label={workspaceLabel} /> : null}
    </button>
  );
}

/**
 * A pick-one-session list that mirrors the sidebar's rows (status icon, title,
 * Agent, time, workspace) without its navigation duties: choosing a row is a
 * selection, not a jump. Used wherever a session is an input — forwarding, and
 * anything else that asks "which conversation".
 */
export function SessionPicker({
  sessions,
  workspaces,
  selectedId,
  onSelect,
  loading = false,
  emptyHint,
  excludeId,
}: {
  sessions: SessionSummary[];
  /** Workspace roster of the machine the sessions came from, same source. */
  workspaces: WorkspaceInfo[];
  selectedId: string | null;
  onSelect(sessionId: string): void;
  loading?: boolean;
  emptyHint: string;
  /** The session being forwarded from is not a destination for itself. */
  excludeId?: string;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((session) => session.id !== excludeId && !session.archived)
      .filter((session) => {
        if (!needle) return true;
        const project = workspaces.find((workspace) => workspace.id === session.workspaceId);
        return `${session.title ?? ""} ${project?.name ?? ""}`.toLowerCase().includes(needle);
      })
      .slice(0, 50)
      .map((session) => ({ ...session, unread: false }));
  }, [sessions, workspaces, excludeId, query]);

  return (
    <div>
      {sessions.length > 8 && !searchOpen ? (
        <button
          type="button"
          aria-label="搜索会话"
          aria-expanded={false}
          className="mb-2 flex min-h-10 items-center text-sm text-muted"
          onClick={() => setSearchOpen(true)}
        >
          搜索会话
        </button>
      ) : null}
      {searchOpen ? (
        <div className="mb-2">
          <ListSearch
            label="搜索会话"
            value={query}
            onChange={setQuery}
            onClose={() => {
              setSearchOpen(false);
              setQuery("");
            }}
          />
        </div>
      ) : null}
      {loading ? (
        <p className="mt-2 text-xs text-faint">正在读取目标机器的会话…</p>
      ) : listed.length > 0 ? (
        <div>
          <RecentSessions
            pick
            listLabel="目标会话"
            density="compact"
            sessions={listed}
            workspaces={workspaces}
            activeSessionId={selectedId}
            onPickSession={onSelect}
            onRename={() => undefined}
            onDelete={() => undefined}
          />
        </div>
      ) : (
        <p className="mt-2 rounded-xl border border-line bg-raised/50 px-3 py-2 text-xs text-muted">
          {query ? "没有标题匹配的会话。" : emptyHint}
        </p>
      )}
    </div>
  );
}

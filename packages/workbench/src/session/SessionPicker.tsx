import type { AgentInfo, SessionSummary } from "@genehub/proto";
import { useMemo, useState } from "react";

import { resolveAgentPresentation } from "../presentation/catalog/resolve";
import { SessionStatusIcon } from "../shell/SessionStatusIcon";
import { formatClock } from "./selectionCopy";

/**
 * A pick-one-session list that mirrors the sidebar's rows (status icon, title,
 * Agent and time) without its navigation duties: choosing a row is a selection,
 * not a jump. Used wherever a session is an input — forwarding, and anything
 * else that asks "which conversation".
 */
export function SessionPicker({
  sessions,
  agents,
  selectedId,
  onSelect,
  loading = false,
  emptyHint,
  excludeId,
}: {
  sessions: SessionSummary[];
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect(sessionId: string): void;
  loading?: boolean;
  emptyHint: string;
  /** The session being forwarded from is not a destination for itself. */
  excludeId?: string;
}) {
  const [query, setQuery] = useState("");

  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((session) => session.id !== excludeId && !session.archived)
      .filter(
        (session) =>
          !needle || (session.title ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, 50);
  }, [sessions, excludeId, query]);

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索会话标题…"
        aria-label="搜索会话标题"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-faint"
      />
      {loading ? (
        <p className="mt-2 text-xs text-faint">正在读取目标机器的会话…</p>
      ) : listed.length > 0 ? (
        <div
          role="listbox"
          aria-label="目标会话"
          className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line p-1"
        >
          {listed.map((session) => {
            const selected = session.id === selectedId;
            const agent = agents.find((entry) => entry.id === session.agentId);
            return (
              <button
                key={session.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(session.id)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                  selected ? "bg-accent/10 text-fg" : "text-muted hover:bg-raised hover:text-fg"
                }`}
              >
                <SessionStatusIcon status={session.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {session.title || "新会话"}
                  </span>
                  <span className="block truncate text-[10px] text-faint">
                    {agent ? resolveAgentPresentation(agent).label : session.agentId} ·{" "}
                    {formatClock(session.updatedAtMs)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 rounded-xl border border-line bg-raised/50 px-3 py-2 text-xs text-muted">
          {query ? "没有标题匹配的会话。" : emptyHint}
        </p>
      )}
    </div>
  );
}

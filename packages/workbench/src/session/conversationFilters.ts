import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
/** Mirrors the daemon's SESSION_STARTED_LABEL. */
export const SYSTEM_STARTED_LABEL = "系统发起";
export type ConversationFilter = {
  ownership: "primary" | "children" | "all";
  state: "all" | "blocked";
  archived: boolean;
};
export const defaultConversationFilter: ConversationFilter = {
  ownership: "primary",
  state: "all",
  archived: false,
};
export function matchesConversation(
  session: SessionSummary,
  workspaces: WorkspaceInfo[],
  filter: ConversationFilter,
): boolean {
  const workspace = workspaces.find((w) => w.id === session.workspaceId);
  // A missing parent catalogue entry does not turn an internal conversation into a primary one.
  // A session another session started carries SYSTEM_STARTED_LABEL and is internal too.
  const child = Boolean(
    session.managed ||
    workspace?.agentSpace?.parentWorkspaceId ||
    session.labels?.includes(SYSTEM_STARTED_LABEL),
  );
  const needsAttention = ["waiting", "failed"].includes(session.status);
  // Primary scope preserves actionable internal sessions; explicit child scope still selects children only.
  const owned =
    filter.ownership === "all" ||
    (filter.ownership === "children"
      ? child
      : (Boolean(workspace) && !child) || needsAttention);
  return (
    owned &&
    (Boolean(session.archived) === filter.archived ||
      (!filter.archived && (needsAttention || session.status === "running"))) &&
    (filter.state !== "blocked" || needsAttention)
  );
}

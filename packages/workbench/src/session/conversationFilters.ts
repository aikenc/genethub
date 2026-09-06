import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
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
  // Missing/dangling parent records stay visible, rather than disappearing from navigation.
  const child = Boolean(
    session.managed ||
    (workspace?.agentSpace?.parentWorkspaceId &&
      workspaces.some((w) => w.id === workspace.agentSpace!.parentWorkspaceId)),
  );
  return (
    (filter.ownership === "all" ||
      (filter.ownership === "children" ? child : !child)) &&
    Boolean(session.archived) === filter.archived &&
    (filter.state !== "blocked" ||
      ["waiting", "failed"].includes(session.status))
  );
}

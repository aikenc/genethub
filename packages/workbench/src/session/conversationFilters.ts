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
  // A missing parent catalogue entry does not turn an internal conversation into a primary one.
  const child = Boolean(
    session.managed ||
    workspace?.agentSpace?.parentWorkspaceId,
  );
  return (
    (filter.ownership === "all" ||
      (filter.ownership === "children" ? child : Boolean(workspace) && !child)) &&
    Boolean(session.archived) === filter.archived &&
    (filter.state !== "blocked" ||
      ["waiting", "failed"].includes(session.status))
  );
}

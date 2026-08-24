import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";

import type { TabKind, WorkbenchTab } from "../session/store";

const SURFACE_TITLES: Partial<Record<TabKind, string>> = {
  files: "文件",
  terminal: "终端",
  processes: "后台进程",
};

/** Menu and tab titles for workspace surfaces — short, no「工作区」prefix. */
export function tabDisplayTitle(tab: Pick<WorkbenchTab, "kind" | "title">): string {
  return SURFACE_TITLES[tab.kind] ?? tab.title;
}

export function workspaceForTab(
  tab: Pick<WorkbenchTab, "kind" | "sessionId">,
  ctx: {
    sessions: SessionSummary[];
    workspaces: WorkspaceInfo[];
    activeWorkspaceId: string | null;
    draftWorkspaceId?: string | null;
  },
): WorkspaceInfo | undefined {
  if (tab.kind === "chat") {
    if (tab.sessionId) {
      const session = ctx.sessions.find((entry) => entry.id === tab.sessionId);
      return ctx.workspaces.find((entry) => entry.id === session?.workspaceId);
    }
    const draftId = ctx.draftWorkspaceId ?? ctx.activeWorkspaceId;
    return ctx.workspaces.find((entry) => entry.id === draftId) ?? ctx.workspaces[0];
  }
  if (tab.kind === "files" || tab.kind === "terminal" || tab.kind === "processes") {
    return ctx.workspaces.find((entry) => entry.id === ctx.activeWorkspaceId) ?? ctx.workspaces[0];
  }
  return undefined;
}

import { useEffect } from "react";

import { PRODUCT } from "../channel";
import { useWorkbench } from "../session/store";
import type { AddressScope } from "./workbench";

/**
 * Browser tab / bookmark title for the current workbench address.
 *
 * The product name is only the last fallback. A bookmarked machine home should
 * read as that machine; a workspace home as the workspace and the machine; a
 * conversation as the conversation and its workspace.
 */
export function workbenchDocumentTitle(input: {
  scope: AddressScope;
  machineName: string | null;
  workspaceName: string | null;
  sessionTitle: string | null;
  fallback?: string;
}): string {
  const machine = visibleName(input.machineName);
  const workspace = visibleName(input.workspaceName);
  const session = visibleName(input.sessionTitle);
  const fallback = visibleName(input.fallback) ?? PRODUCT;
  if (input.scope === "session") {
    if (session && workspace) return `${session} · ${workspace}`;
    return session ?? workspace ?? machine ?? fallback;
  }
  if (input.scope === "workspace") {
    if (workspace && machine) return `${workspace} · ${machine}`;
    return workspace ?? machine ?? fallback;
  }
  return machine ?? fallback;
}

export function useWorkbenchDocumentTitle(machineName: string | null): void {
  const scope = useWorkbench((state) => state.addressScope);
  const workspaceName = useWorkbench((state) => {
    const workspaceId = state.draft?.workspaceId ?? state.activeWorkspaceId;
    return state.workspaces.find((entry) => entry.id === workspaceId)?.name ?? null;
  });
  const sessionTitle = useWorkbench((state) => {
    if (state.draft) return "新会话";
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
    return session?.title || (session ? "新会话" : null);
  });

  useEffect(() => {
    document.title = workbenchDocumentTitle({
      scope,
      machineName,
      workspaceName,
      sessionTitle,
    });
  }, [scope, machineName, workspaceName, sessionTitle]);
}

function visibleName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

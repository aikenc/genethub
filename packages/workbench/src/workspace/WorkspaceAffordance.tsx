import type { WorkspaceInfo } from "@genehub/proto";

import { WorkspaceIcon } from "./WorkspaceIcon";

/**
 * The compact workspace mark used on session rows and title bars.
 *
 * Name on the right, icon beside it, faint and truncated so a long workspace
 * does not crowd out the title it is annotating. It is a label: pointer events
 * fall through to the tab or row that owns it, so a tap on the name still
 * activates that surface.
 */
export function WorkspaceAffordance({
  workspace,
  className = "max-w-[5.5rem]",
}: {
  workspace: Pick<WorkspaceInfo, "name" | "kind" | "workspaceFile">;
  className?: string;
}) {
  return (
    <span
      data-workspace-affordance={workspace.name}
      title={workspace.name}
      aria-hidden
      className={`pointer-events-none flex min-w-0 shrink-0 items-center gap-0.5 text-[10px] text-faint ${className}`}
    >
      <WorkspaceIcon workspace={workspace} className="h-3 w-3" />
      <span className="min-w-0 truncate">{workspace.name}</span>
    </span>
  );
}

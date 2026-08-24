import type { WorkspaceInfo } from "@genehub/proto";

export type WorkspaceKind = "folder" | "workspace";
/** @deprecated Use {@link WorkspaceKind}. */
export type ProjectKind = WorkspaceKind;

/** A compact, theme-coloured distinction between a folder and a multi-folder workspace. */
export function WorkspaceKindIcon({
  kind,
  className = "h-3.5 w-3.5",
}: {
  kind: WorkspaceKind;
  className?: string;
}) {
  if (kind === "workspace") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        className={`shrink-0 text-accent ${className}`}
        data-workspace-icon="workspace"
        aria-hidden="true"
      >
        <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1.25" />
        <path d="M6.25 12.25h5.5a2 2 0 0 0 2-2v-5.5" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className={`shrink-0 text-muted ${className}`}
      data-workspace-icon="folder"
      aria-hidden="true"
    >
      <path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.4 1.5H13A1.25 1.25 0 0 1 14.25 5.75v6A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25z" />
    </svg>
  );
}

/** @deprecated Use {@link WorkspaceKindIcon}. */
export const ProjectIcon = WorkspaceKindIcon;

export function WorkspaceIcon({
  workspace,
  className,
}: {
  workspace: Pick<WorkspaceInfo, "workspaceFile">;
  className?: string;
}) {
  return (
    <WorkspaceKindIcon
      kind={workspace.workspaceFile ? "workspace" : "folder"}
      className={className}
    />
  );
}

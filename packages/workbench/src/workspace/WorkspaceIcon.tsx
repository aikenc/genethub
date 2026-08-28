import type { WorkspaceInfo } from "@genehub/proto";

/**
 * `workspace` is the legacy picker-only name for an arbitrary
 * `.code-workspace`. Durable workspaces use the three protocol kinds.
 */
export type WorkspaceKind = "folder" | "workspace" | "pipeSpace" | "agentSpace";
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
  if (kind === "agentSpace") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`shrink-0 text-accent ${className}`}
        data-workspace-icon="agent-space"
        aria-hidden="true"
      >
        <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.25" />
        <circle cx="5.25" cy="8" r="1" />
        <circle cx="10.75" cy="5.25" r="1" />
        <circle cx="10.75" cy="10.75" r="1" />
        <path d="m6.15 7.55 3.7-1.85M6.15 8.45l3.7 1.85" />
      </svg>
    );
  }
  if (kind === "workspace" || kind === "pipeSpace") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        className={`shrink-0 text-accent ${className}`}
        data-workspace-icon={kind === "pipeSpace" ? "pipe-space" : "workspace"}
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
  workspace: Pick<WorkspaceInfo, "kind" | "workspaceFile">;
  className?: string;
}) {
  const kind =
    workspace.kind === "agentSpace" || workspace.kind === "pipeSpace"
      ? workspace.kind
      : workspace.workspaceFile
        ? "workspace"
        : "folder";
  return (
    <WorkspaceKindIcon kind={kind} className={className} />
  );
}

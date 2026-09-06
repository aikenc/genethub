import { useMemo, useState, type ReactNode } from "react";
import type { WorkspaceInfo, SessionSummary } from "@genehub/proto";
import { WorkspaceRow } from "../shell/ConversationRows";
import {
  buildAgentSpaceTree,
  type AgentSpaceTreeNode,
} from "./agent-space-tree";
import { useAgentActivities } from "./useAgentActivity";
import { useWorkbench } from "../session/store";

export type ListDensity = "auto" | "comfortable" | "compact";
/** Shared contact list and new-conversation picker. Expanding never selects an Agent. */
export function AgentList({
  workspaces,
  sessions = [],
  selectedId,
  onPick,
  query = "",
  density = "auto",
  actions = true,
  deviceName = "",
  rootIds,
  memberIds,
}: {
  rootIds?: string[];
  memberIds?: string[];
  workspaces: WorkspaceInfo[];
  sessions?: SessionSummary[];
  selectedId?: string | null;
  onPick(id: string): void;
  query?: string;
  density?: ListDensity;
  actions?: boolean;
  deviceName?: string;
}) {
  const tree = useMemo(() => buildAgentSpaceTree(workspaces), [workspaces]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const wb = useWorkbench();
  const activity = useAgentActivities();
  const recent = (id: string) => activity.agents?.get(id)?.recent ?? sessions.reduce((at, s) => s.workspaceId === id ? Math.max(at, s.messagePreview?.atMs ?? s.updatedAtMs) : at, 0);
  const sorted = (nodes: AgentSpaceTreeNode[]) => [...nodes].sort((a, b) => recent(b.workspace.id) - recent(a.workspace.id) || a.workspace.name.localeCompare(b.workspace.name, "zh-CN") || a.workspace.id.localeCompare(b.workspace.id));
  const matching = (node: AgentSpaceTreeNode): AgentSpaceTreeNode[] => [
    node,
    ...node.children.flatMap(matching),
  ];
  const allRoots = [...tree.roots, ...tree.anomalies];
  const roots = rootIds
    ? allRoots
        .flatMap(matching)
        .filter((node) => rootIds.includes(node.workspace.id))
    : allRoots;
  const visible = query.trim() || memberIds
    ? roots
        .flatMap(matching)
        .filter((n) => (!memberIds || memberIds.includes(n.workspace.id)) &&
          `${n.workspace.name} ${n.breadcrumb}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
    : roots;
  const row = (node: AgentSpaceTreeNode, depth: number): ReactNode => (
    <WorkspaceRow
      key={node.workspace.id}
      workspace={node.workspace}
      workspaces={workspaces}
      breadcrumb={node.breadcrumb}
      projectWorkspaceId={
        tree.projectRootById[node.workspace.id] ?? node.workspace.id
      }
      relationAnomaly={tree.anomalies.includes(node)}
      running={
        sessions.filter(
          (s) =>
            s.workspaceId === node.workspace.id &&
            ["running", "waiting"].includes(s.status),
        ).length
      }
      shut
      browse
      active={selectedId === node.workspace.id}
      deviceName={deviceName}
      onToggle={() => onPick(node.workspace.id)}
      onPick={() => onPick(node.workspace.id)}
      onRename={(name) => void wb.renameWorkspace(node.workspace.id, name)}
      onRemove={() => wb.removeWorkspace(node.workspace.id)}
      density={density}
      actions={actions}
      childCount={query || memberIds ? 0 : node.children.length}
      expanded={expanded.has(node.workspace.id)}
      onExpand={() =>
        setExpanded((old) => {
          const next = new Set(old);
          next.has(node.workspace.id)
            ? next.delete(node.workspace.id)
            : next.add(node.workspace.id);
          return next;
        })
      }
    >
      {!query && !memberIds && expanded.has(node.workspace.id) && (
        <ul className="agent-children ml-3 border-l border-line pl-2">
          {sorted(node.children).map((child) => row(child, depth + 1))}
        </ul>
      )}
    </WorkspaceRow>
  );
  return (
    <ul
      data-density={density}
      className="entity-list agent-list space-y-1"
      aria-label="Agent 列表"
    >
      {sorted(visible).map((node) => row(node, 0))}
      {!visible.length && (
        <li className="px-4 py-8 text-sm text-muted">没有匹配的 Agent</li>
      )}
    </ul>
  );
}

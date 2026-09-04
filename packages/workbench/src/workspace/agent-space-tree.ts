import type { WorkspaceInfo } from "@genehub/proto";

export interface AgentSpaceTreeNode {
  workspace: WorkspaceInfo;
  children: AgentSpaceTreeNode[];
  breadcrumb: string;
}

export interface AgentSpaceTree {
  roots: AgentSpaceTreeNode[];
  /** Corrupt/missing relationships are visible but never mixed into a valid tree. */
  anomalies: AgentSpaceTreeNode[];
  breadcrumbById: Record<string, string>;
  projectRootById: Record<string, string>;
}

const byName = (left: WorkspaceInfo, right: WorkspaceInfo) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });

/**
 * The one defensive Parent projection shared by every Workspace picker.
 *
 * Kernel writes reject missing parents and cycles. Stored data can still come
 * from an older/corrupt build, so UI readers isolate those nodes instead of
 * recursing forever or pretending they are healthy project roots.
 */
export function buildAgentSpaceTree(workspaces: WorkspaceInfo[]): AgentSpaceTree {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const inputIndex = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  const validity = new Map<string, boolean>();
  const visiting: string[] = [];

  const valid = (workspaceId: string): boolean => {
    const known = validity.get(workspaceId);
    if (known !== undefined) return known;
    const cycleAt = visiting.indexOf(workspaceId);
    if (cycleAt >= 0) {
      for (const member of visiting.slice(cycleAt)) validity.set(member, false);
      return false;
    }
    const workspace = byId.get(workspaceId);
    if (!workspace) return false;
    const parent = workspace.agentSpace?.parentWorkspaceId;
    if (!parent) {
      validity.set(workspaceId, true);
      return true;
    }
    if (!byId.has(parent)) {
      validity.set(workspaceId, false);
      return false;
    }
    visiting.push(workspaceId);
    const answer = valid(parent);
    visiting.pop();
    validity.set(workspaceId, answer && validity.get(workspaceId) !== false);
    return validity.get(workspaceId) === true;
  };

  for (const workspace of workspaces) valid(workspace.id);

  const childIds = new Map<string, string[]>();
  for (const workspace of workspaces) {
    if (!validity.get(workspace.id)) continue;
    const parent = workspace.agentSpace?.parentWorkspaceId;
    if (!parent) continue;
    childIds.set(parent, [...(childIds.get(parent) ?? []), workspace.id]);
  }

  const breadcrumbById: Record<string, string> = {};
  const projectRootById: Record<string, string> = {};
  const subtreePriority = (workspaceId: string): number =>
    Math.min(
      inputIndex.get(workspaceId) ?? Number.MAX_SAFE_INTEGER,
      ...(childIds.get(workspaceId) ?? []).map(subtreePriority),
    );
  const makeNode = (
    workspace: WorkspaceInfo,
    names: string[],
    projectRootId: string,
  ): AgentSpaceTreeNode => {
    const path = [...names, workspace.name];
    breadcrumbById[workspace.id] = path.join(" / ");
    projectRootById[workspace.id] = projectRootId;
    const children = (childIds.get(workspace.id) ?? [])
      .map((id) => byId.get(id))
      .filter((candidate): candidate is WorkspaceInfo => Boolean(candidate))
      .sort(byName)
      .map((child) => makeNode(child, path, projectRootId));
    return { workspace, children, breadcrumb: path.join(" / ") };
  };

  const roots = workspaces
    .filter(
      (workspace) =>
        validity.get(workspace.id) && !workspace.agentSpace?.parentWorkspaceId,
    )
    // Callers already know activity priority (the new-session page passes
    // recent-first order). Rank a project by the earliest member of its whole
    // subtree so selecting a recently used Coder also keeps that project near
    // the top. Children still use one stable name order in every surface.
    .sort((left, right) => subtreePriority(left.id) - subtreePriority(right.id))
    .map((workspace) => makeNode(workspace, [], workspace.id));
  const anomalies = workspaces
    .filter((workspace) => !validity.get(workspace.id))
    .sort(byName)
    .map((workspace) => {
      breadcrumbById[workspace.id] = `关系异常 / ${workspace.name}`;
      projectRootById[workspace.id] = workspace.id;
      return {
        workspace,
        children: [],
        breadcrumb: `关系异常 / ${workspace.name}`,
      };
    });
  return { roots, anomalies, breadcrumbById, projectRootById };
}

export function flattenAgentSpaceTree(tree: AgentSpaceTree): WorkspaceInfo[] {
  const out: WorkspaceInfo[] = [];
  const visit = (node: AgentSpaceTreeNode) => {
    out.push(node.workspace);
    node.children.forEach(visit);
  };
  tree.roots.forEach(visit);
  tree.anomalies.forEach(visit);
  return out;
}

export function isDescendant(
  workspaces: WorkspaceInfo[],
  possibleDescendantId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const seen = new Set<string>();
  let cursor = byId.get(possibleDescendantId);
  while (cursor?.agentSpace?.parentWorkspaceId) {
    const parent = cursor.agentSpace.parentWorkspaceId;
    if (parent === ancestorId) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    cursor = byId.get(parent);
  }
  return false;
}

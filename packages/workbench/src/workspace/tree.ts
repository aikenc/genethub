import type { WorkspaceInfo } from "@genehub/proto";

export interface WorkspaceTreeNode {
  workspace: WorkspaceInfo;
  parentWorkspaceId: string | null;
  children: WorkspaceTreeNode[];
}

/**
 * Build the visible hierarchy from daemon-projected relationships only.
 * Filesystem paths deliberately have no presentation meaning here.
 */
export function buildWorkspaceTree(workspaces: WorkspaceInfo[]): WorkspaceTreeNode[] {
  const sourceIndex = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const nodes = new Map<string, WorkspaceTreeNode>(
    workspaces.map((workspace) => [
      workspace.id,
      { workspace, parentWorkspaceId: null, children: [] } as WorkspaceTreeNode,
    ]),
  );

  const validParent = (workspace: WorkspaceInfo): string | null => {
    const parentId = workspace.parentWorkspaceId;
    if (!parentId || parentId === workspace.id || !byId.has(parentId)) return null;
    const visited = new Set([workspace.id]);
    let current: string | undefined = parentId;
    while (current) {
      if (visited.has(current)) return null;
      visited.add(current);
      current = byId.get(current)?.parentWorkspaceId;
    }
    return parentId;
  };

  const roots: WorkspaceTreeNode[] = [];
  for (const workspace of workspaces) {
    const node = nodes.get(workspace.id)!;
    const parentId = validParent(workspace);
    const parent = parentId ? nodes.get(parentId) : undefined;
    node.parentWorkspaceId = parent ? parentId : null;
    (parent?.children ?? roots).push(node);
  }

  const sort = (items: WorkspaceTreeNode[]) => {
    items.sort((left, right) => {
      const byOrder = (left.workspace.layoutOrder ?? 0) - (right.workspace.layoutOrder ?? 0);
      return byOrder || sourceIndex.get(left.workspace.id)! - sourceIndex.get(right.workspace.id)!;
    });
    for (const item of items) sort(item.children);
  };
  sort(roots);
  return roots;
}

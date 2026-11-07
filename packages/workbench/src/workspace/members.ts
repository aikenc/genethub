import { expandLocator } from "../location/locator";
import type { WorkspaceInfo } from "@genehub/proto";
import type { Target } from "../protocol/target";
import type { MachineSummary } from "../protocol/summary-directory";
import { buildAgentSpaceTree } from "./agent-space-tree";

export const spaceKey = (machine: Target, id: string) => JSON.stringify([machine.deviceHandle ?? machine.id, id]);
export interface DirectorySpace {
  key: string; workspaceId: string; name: string; machine: string;
  row?: MachineSummary; workspace?: WorkspaceInfo;
}
export function memberSource(sources: MachineSummary[], machineId: string) {
  const exact = sources.find(row => row.target.deviceHandle === machineId || row.target.id === machineId);
  if (exact) return exact;
  const handle = expandLocator(machineId,sources.map(row => row.target.deviceHandle ?? row.target.id));
  return handle ? sources.find(row => (row.target.deviceHandle ?? row.target.id) === handle) : undefined;
}
/** Display and navigation share the same machine-qualified relationships. */
export function workspaceMembers(sources: MachineSummary[], row: MachineSummary, workspace: WorkspaceInfo, descendants = true): DirectorySpace[] {
  const tree = buildAgentSpaceTree(row.workspaces);
  const local = row.workspaces.filter(w => w.id !== workspace.id && (descendants
    ? tree.projectRootById[w.id] === workspace.id : w.agentSpace?.parentWorkspaceId === workspace.id))
    .map(w => ({key:spaceKey(row.target,w.id),workspaceId:w.id,name:w.name,machine:row.target.label,row,workspace:w}));
  const remote = (workspace.agentSpace?.members ?? []).map(member => {
    const owner = memberSource(sources,member.machineId), child = owner?.workspaces.find(w => w.id === member.workspaceId);
    return {key:owner ? spaceKey(owner.target,member.workspaceId) : JSON.stringify([member.machineId,member.workspaceId]),
      workspaceId:member.workspaceId,name:child?.name ?? member.name ?? "Space",machine:owner?.target.label ?? "未连接的机器",row:owner,workspace:child};
  });
  return [...new Map([...local,...remote].filter(child => child.key !== spaceKey(row.target,workspace.id)).map(child => [child.key,child])).values()];
}

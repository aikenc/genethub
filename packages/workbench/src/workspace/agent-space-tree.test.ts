import type { WorkspaceInfo } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { buildAgentSpaceTree, flattenAgentSpaceTree, isDescendant } from "./agent-space-tree";

const workspace = (id: string, parentWorkspaceId?: string): WorkspaceInfo => ({
  id,
  name: id,
  root: `/${id}`,
  isGitRepo: true,
  folders: [],
  agentSpace: {
    parentWorkspaceId,
    revision: 1,
    lifecycle: "persistent",
    builderLockDigest: `digest-${id}`,
    components: [],
    guidance: [],
  },
});

describe("AgentSpace Parent projection", () => {
  it("shows every child exactly once below its logical parent", () => {
    const tree = buildAgentSpaceTree([
      workspace("reviewer", "executor"),
      workspace("project"),
      workspace("executor", "project"),
      workspace("coder", "executor"),
    ]);
    expect(flattenAgentSpaceTree(tree).map(({ id }) => id)).toEqual([
      "project",
      "executor",
      "coder",
      "reviewer",
    ]);
    expect(tree.breadcrumbById.coder).toBe("project / executor / coder");
    expect(tree.projectRootById.coder).toBe("project");
  });

  it("isolates missing parents and cycles instead of recursing", () => {
    const tree = buildAgentSpaceTree([
      workspace("healthy"),
      workspace("orphan", "missing"),
      workspace("cycle-a", "cycle-b"),
      workspace("cycle-b", "cycle-a"),
    ]);
    expect(tree.roots.map(({ workspace }) => workspace.id)).toEqual(["healthy"]);
    expect(tree.anomalies.map(({ workspace }) => workspace.id)).toEqual([
      "cycle-a",
      "cycle-b",
      "orphan",
    ]);
  });

  it("preserves caller priority for project roots while sorting children", () => {
    const tree = buildAgentSpaceTree([
      workspace("recent"),
      workspace("z-child", "recent"),
      workspace("a-child", "recent"),
      workspace("older"),
    ]);
    expect(tree.roots.map(({ workspace }) => workspace.id)).toEqual(["recent", "older"]);
    expect(tree.roots[0]?.children.map(({ workspace }) => workspace.id)).toEqual([
      "a-child",
      "z-child",
    ]);
  });

  it("lifts a recently ordered child together with its project root", () => {
    const tree = buildAgentSpaceTree([
      workspace("recent-coder", "recent-project"),
      workspace("older-project"),
      workspace("recent-project"),
    ]);
    expect(tree.roots.map(({ workspace }) => workspace.id)).toEqual([
      "recent-project",
      "older-project",
    ]);
  });

  it("identifies descendants for a safe reparent picker", () => {
    const spaces = [workspace("project"), workspace("executor", "project"), workspace("coder", "executor")];
    expect(isDescendant(spaces, "coder", "project")).toBe(true);
    expect(isDescendant(spaces, "project", "coder")).toBe(false);
  });
});

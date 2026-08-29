import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@genehub/proto";
import { buildWorkspaceTree } from "./tree";

const workspace = (
  id: string,
  parentWorkspaceId?: string,
  layoutOrder = 0,
): WorkspaceInfo => ({
  id,
  name: id,
  root: `/same/path/${id}`,
  isGitRepo: false,
  folders: [],
  parentWorkspaceId,
  layoutOrder,
  layoutManaged: false,
});

describe("buildWorkspaceTree", () => {
  it("uses only explicit relationships and never infers them from paths", () => {
    const parent = workspace("parent");
    const child = { ...workspace("child"), root: `${parent.root}/nested` };
    const tree = buildWorkspaceTree([parent, child]);

    expect(tree.map((node) => node.workspace.id)).toEqual(["parent", "child"]);
    expect(tree[0]!.children).toEqual([]);
  });

  it("nests ordinary and PM-managed workspaces from the daemon projection", () => {
    const tree = buildWorkspaceTree([
      workspace("project"),
      workspace("feature", "project", 1),
      { ...workspace("agent", "project", 0), kind: "agentSpace", layoutManaged: true },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.children.map((node) => node.workspace.id)).toEqual(["agent", "feature"]);
  });

  it("keeps dangling and cyclic declarations visible at the root", () => {
    const tree = buildWorkspaceTree([
      workspace("dangling", "missing"),
      workspace("a", "b"),
      workspace("b", "a"),
    ]);

    expect(tree.map((node) => node.workspace.id)).toEqual(["dangling", "a", "b"]);
  });

  it("sorts roots and siblings by explicit order with stable input fallback", () => {
    const tree = buildWorkspaceTree([
      workspace("second", undefined, 2),
      workspace("first", undefined, 1),
      workspace("same-a", undefined, 3),
      workspace("same-b", undefined, 3),
    ]);

    expect(tree.map((node) => node.workspace.id)).toEqual([
      "first",
      "second",
      "same-a",
      "same-b",
    ]);
  });
});

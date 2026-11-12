import type { SessionSummary } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { initialListViews, patchListView, projectFrontTime, projectSearchMatches } from "./project-view";

const session = (id: string, at: number) => ({
  id, workspaceId: "team", agentId: "genet", status: "idle", updatedAtMs: at,
  messagePreview: { itemId: `i-${id}`, text: id, atMs: at },
}) as unknown as SessionSummary;

const project = {
  name: "XWorld-hy",
  root: "/data/teams/hy",
  memberNames: ["actor", "qa", "team-reflect"],
  sessionTexts: ["第三人称玩家控制器模块", "地图试玩第一轮"],
};

describe("project view search", () => {
  it("finds a project by its own name", () => {
    expect(projectSearchMatches("xworld", project)).toBe(true);
  });

  it("finds a project by a session title", () => {
    expect(projectSearchMatches("第三人称玩家控制器模块", project)).toBe(true);
  });

  it("finds a project by a member Space name", () => {
    expect(projectSearchMatches("qa", project)).toBe(true);
  });

  it("returns no rows for an unrelated query", () => {
    expect(projectSearchMatches("不存在的会话", project)).toBe(false);
  });

  it("does not filter when the query is empty", () => {
    expect(projectSearchMatches("", project)).toBe(true);
  });
});

describe("project view ordering", () => {
  it("uses only front sessions for the project time", () => {
    const front = [session("f1", 1_000), session("f2", 2_000)];
    expect(projectFrontTime(front)).toBe(2_000);
    expect(projectFrontTime([])).toBe(0);
  });

  it("ignores internal activity when the caller passes only front sessions", () => {
    const front = [session("f1", 1_000)];
    const internal = session("i1", 99_000);
    expect(projectFrontTime(front)).toBeLessThan(projectFrontTime([...front, internal]));
  });
});

describe("per-section list state", () => {
  it("starts both sections with no filters", () => {
    const views = initialListViews();
    expect(views.sessions).toEqual({ query: "", filter: "all", includeArchived: false });
    expect(views.projects).toEqual({ query: "", filter: "all", includeArchived: false });
  });

  it("an unread filter in sessions does not leak into projects", () => {
    const views = patchListView(initialListViews(), "sessions", { filter: "unread" });
    expect(views.sessions.filter).toBe("unread");
    expect(views.projects.filter).toBe("all");
  });

  it("archived mode in sessions does not leak into projects", () => {
    const views = patchListView(initialListViews(), "sessions", { includeArchived: true });
    expect(views.sessions.includeArchived).toBe(true);
    expect(views.projects.includeArchived).toBe(false);
  });

  it("a query in one section does not leak into the other", () => {
    const views = patchListView(patchListView(initialListViews(), "projects", { query: "qa" }), "sessions", { query: "地图" });
    expect(views.projects.query).toBe("qa");
    expect(views.sessions.query).toBe("地图");
  });
});

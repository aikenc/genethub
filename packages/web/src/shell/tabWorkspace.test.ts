import { describe, expect, it } from "vitest";

import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";

import { tabDisplayTitle, workspaceForTab } from "./tabWorkspace";

const workspace = (id: string, name: string): WorkspaceInfo => ({
  id,
  name,
  root: `/${name}`,
  isGitRepo: true,
  folders: [{ name, root: `/${name}`, rootHandle: id }],
});

const session = (id: string, workspaceId: string): SessionSummary => ({
  id,
  workspaceId,
  agentId: "genet",
  title: id,
  createdAtMs: 0,
  updatedAtMs: 0,
  archived: false,
  status: "idle",
});

describe("tabDisplayTitle", () => {
  it("keeps workspace surface names short", () => {
    expect(tabDisplayTitle({ kind: "files", title: "工作区文件" })).toBe("文件");
    expect(tabDisplayTitle({ kind: "terminal", title: "终端" })).toBe("终端");
    expect(tabDisplayTitle({ kind: "processes", title: "工作区后台进程" })).toBe("后台进程");
    expect(tabDisplayTitle({ kind: "chat", title: "改进UI体验" })).toBe("改进UI体验");
    expect(tabDisplayTitle({ kind: "settings", title: "设置" })).toBe("设置");
  });
});

describe("workspaceForTab", () => {
  const workspaces = [workspace("w1", "dev-ui"), workspace("w2", "paseo")];
  const sessions = [session("s1", "w1"), session("s2", "w2")];

  it("follows the session for a chat tab", () => {
    expect(
      workspaceForTab(
        { kind: "chat", sessionId: "s2" },
        { sessions, workspaces, activeWorkspaceId: "w1" },
      )?.name,
    ).toBe("paseo");
  });

  it("uses the draft workspace for an unstarted chat", () => {
    expect(
      workspaceForTab(
        { kind: "chat" },
        { sessions, workspaces, activeWorkspaceId: "w1", draftWorkspaceId: "w2" },
      )?.name,
    ).toBe("paseo");
  });

  it("uses the active workspace for files, terminal and processes", () => {
    expect(
      workspaceForTab(
        { kind: "files" },
        { sessions, workspaces, activeWorkspaceId: "w2" },
      )?.name,
    ).toBe("paseo");
  });

  it("leaves settings and devices unmarked", () => {
    expect(
      workspaceForTab(
        { kind: "settings" },
        { sessions, workspaces, activeWorkspaceId: "w1" },
      ),
    ).toBeUndefined();
  });
});

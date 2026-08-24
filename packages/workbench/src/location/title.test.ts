import { describe, expect, it } from "vitest";

import { workbenchDocumentTitle } from "./title";

describe("workbench document title", () => {
  it("names a machine home after the machine, not the product", () => {
    expect(
      workbenchDocumentTitle({
        scope: "machine",
        machineName: "办公机",
        workspaceName: "genethub",
        sessionTitle: "新会话",
      }),
    ).toBe("办公机");
  });

  it("names a workspace home as the workspace and the machine", () => {
    expect(
      workbenchDocumentTitle({
        scope: "workspace",
        machineName: "办公机",
        workspaceName: "genethub",
        sessionTitle: "新会话",
      }),
    ).toBe("genethub · 办公机");
  });

  it("names a conversation as the session and its workspace", () => {
    expect(
      workbenchDocumentTitle({
        scope: "session",
        machineName: "办公机",
        workspaceName: "genethub",
        sessionTitle: "修登录跳转",
      }),
    ).toBe("修登录跳转 · genethub");
  });

  it("falls back without inventing GeneHub when a name is still missing", () => {
    expect(
      workbenchDocumentTitle({
        scope: "machine",
        machineName: null,
        workspaceName: null,
        sessionTitle: null,
        fallback: "本机",
      }),
    ).toBe("本机");
  });
});

import type { SessionSummary } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionListItem } from "./SessionPicker";

describe("historical sessions and team tree", () => {
  it("keeps retired execution history readable in the session picker", () => {
    const session: SessionSummary = {
      id: "s_worker",
      workspaceId: "w_project",
      agentId: "genet",
      title: "修复按钮 · worker",
      status: "running",
      createdAtMs: 1,
      updatedAtMs: 2,
      archived: false,
      historyOnly: true,
    };

    render(
      <SessionListItem
        session={session}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: /修复按钮/ })).toBeInTheDocument();
    expect(screen.getByText(/历史/)).toBeInTheDocument();
  });

  it("shows the AgentSpace breadcrumb when a session is picked across the tree", () => {
    const session: SessionSummary = {
      id: "s_coder",
      workspaceId: "w_coder",
      agentId: "genet",
      title: "实现玩法",
      status: "idle",
      createdAtMs: 1,
      updatedAtMs: 2,
      archived: false,
    };
    render(
      <SessionListItem
        session={session}
        workspace={{
          id: "w_coder",
          name: "Coder",
          root: "/project/spaces/coder",
          isGitRepo: true,
          folders: [],
        }}
        workspaceLabel="小游戏 / Executor / Coder"
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTitle("小游戏 / Executor / Coder")).toHaveTextContent(
      "小游戏 / Executor / Coder",
    );
  });
});

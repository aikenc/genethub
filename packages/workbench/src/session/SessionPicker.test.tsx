import type { SessionSummary } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionListItem } from "./SessionPicker";

describe("managed ordinary sessions", () => {
  it("keeps the ordinary session row and makes its Workflow binding visible", () => {
    const session: SessionSummary = {
      id: "s_worker",
      workspaceId: "w_project",
      agentId: "genet",
      title: "修复按钮 · worker",
      status: "running",
      createdAtMs: 1,
      updatedAtMs: 2,
      archived: false,
      managed: {
        parentSessionId: "s_root",
        workflowRunId: "wr_1",
        workflowId: "direct-change",
        nodeId: "implement",
        role: "worker",
        userInteraction: "readOnly",
      },
    };

    render(
      <SessionListItem
        session={session}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: /修复按钮/ })).toBeInTheDocument();
    expect(screen.getByText(/受管 worker/)).toBeInTheDocument();
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PmProjectStatus, SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { ProjectPanel } from "./ProjectPanel";

afterEach(cleanup);

describe("ProjectPanel", () => {
  it("shows the demand, node-bound team, exception path and dispatches a user decision", async () => {
    const status = projectStatus();
    const call = vi.fn(async (_request: { type: string }) => ({ type: "projectStatus", data: status }));
    const open = vi.fn();
    const openWorkspace = vi.fn();
    render(<ProjectPanel
      client={{ call } as unknown as Client}
      session={pmSession()}
      workspaces={workspaces()}
      onOpenSession={open}
      onOpenWorkspace={openWorkspace}
    />);

    expect(await screen.findByText("交付可玩的 H5 游戏")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText(/等待资源/)).toBeInTheDocument();
    expect(screen.getByText("实现战斗循环")).toBeInTheDocument();
    fireEvent.click(screen.getByText("实现战斗循环"));
    expect(open).toHaveBeenCalledWith("s_work");

    fireEvent.change(screen.getByPlaceholderText("补充条件事实，逗号分隔"), {
      target: { value: "diagnosis.retryApproved" },
    });
    fireEvent.click(screen.getByText("决策"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({
      type: "pm.workflow.transition",
      payload: {
        workspaceId: "w_project",
        sessionId: "s_pm",
        edgeId: "retry",
        facts: ["diagnosis.retryApproved"],
      },
    }));
  });
});

function pmSession(): SessionSummary {
  return {
    id: "s_pm", workspaceId: "w_pm", agentId: "genet", kind: "pm",
    status: "idle", createdAtMs: 1, updatedAtMs: 1, archived: false,
  };
}

function workspaces(): WorkspaceInfo[] {
  const base = { rootHandle: "root", isGitRepo: true, folders: [] };
  return [
    { id: "w_project", name: "Game", root: "/game", ...base },
    { id: "w_pm", name: "PM", root: "/game/spaces/pm", kind: "agentSpace", parentWorkspaceId: "w_project", ...base },
  ];
}

function projectStatus(): PmProjectStatus {
  return {
    workspaceId: "w_project", controllerSessionId: "s_pm", phase: "active", lifecycle: "active",
    revision: 3, updatedAtMs: 3,
    intent: { revision: 1, outcome: "交付可玩的 H5 游戏", acceptance: ["可玩"], constraints: [], outOfScope: [] },
    workPackages: [{
      id: "combat", title: "战斗", outcome: "实现战斗循环", status: "blocked", dependencies: [],
      agentSpace: "implementation-1", branch: "work/combat", workflowRunId: "run-s_pm",
      nodeInstanceId: "implement-1", workSessionId: "s_work", blockReason: "等待资源",
    }],
    agentSpaces: [{
      name: "implementation-1", purpose: "实现", workspaceId: "w_impl", sourceCommit: "a".repeat(40),
      builderLockDigest: "b".repeat(64), role: "implementation", active: true,
      resourceState: "quarantined", resourceRevision: 2, workPackageId: "combat", workSessionId: "s_work",
    }],
    workflowCatalog: { recommended: "feature", workflows: [{
      id: "feature", version: 1, entry: "intake",
      nodes: [{ id: "intake", kind: "activity" }, { id: "implement", kind: "activity" }, { id: "diagnose", kind: "activity" }],
      edges: [{ id: "retry", from: "diagnose", to: "implement", condition: "diagnosis.retryApproved", chooseBy: "user" }],
    }] },
    workflowRuns: [{
      id: "run-s_pm", controllerSessionId: "s_pm", graphId: "feature", graphVersion: 1, status: "active",
      definition: null,
      activeNodes: ["diagnose"], facts: [], revision: 3,
      nodeInstances: [{ id: "implement-1", nodeId: "implement", iteration: 1, status: "blocked" }, { id: "diagnose-1", nodeId: "diagnose", iteration: 1, status: "active" }],
      teamSlots: [{ id: "slot-combat", nodeInstanceId: "implement-1", workPackageId: "combat", responsibility: "实现战斗循环", workSessionId: "s_work", status: "blocked" }],
      availableEdges: [{ id: "retry", from: "diagnose", to: "implement", condition: "diagnosis.retryApproved", chooseBy: "user", satisfied: false }],
    }],
    improvementCandidates: [],
    supervisor: {
      mode: "eventDriven",
      wakePending: false,
      wakeDispatchCount: 0,
      wakeFailedCount: 0,
      coalescedEventCount: 0,
    },
  };
}

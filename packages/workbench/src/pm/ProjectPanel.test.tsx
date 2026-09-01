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
    expect(screen.getByText("0/1")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText("可分配 0/4 · 已占 1")).toBeInTheDocument();
    expect(screen.getByText("执行预算剩余 9:00")).toBeInTheDocument();
    expect(screen.getByText("并发会话 1/4 · 累计会话 2/16")).toBeInTheDocument();
    expect(screen.getByText("LLM 请求 20/96 · 剩余 76 · 用户等待 0:05")).toBeInTheDocument();
    expect(screen.getByText("独立 Reviewer findings")).toBeInTheDocument();
    expect(screen.getByText("存档迁移丢失 v1 字段")).toBeInTheDocument();
    expect(screen.getByText("预计 2 次请求")).toBeInTheDocument();
    expect(screen.getByText(/PM 不复查代码/)).toBeInTheDocument();
    expect(screen.getByText(/合并冲突/)).toBeInTheDocument();
    expect(screen.getByText("实现战斗循环")).toBeInTheDocument();
    expect(screen.getByText("由 PM 根据证据选择")).toBeInTheDocument();
    expect(screen.getByText("由 Coordinator 根据证据推进")).toBeInTheDocument();
    expect(screen.getByText("采用修正方案重试")).toBeInTheDocument();
    expect(screen.getByText(/Workflow 解释器需要人工介入/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("实现战斗循环"));
    expect(open).toHaveBeenCalledWith("s_work");

    expect(screen.queryByText("diagnosis.retryApproved")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("采用修正方案重试"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({
      type: "pm.workflow.transition",
      payload: {
        workspaceId: "w_project",
        sessionId: "s_pm",
        edgeId: "retry",
        facts: [],
      },
    }));
  });

  it("shows that user decision waiting pauses the task execution clock", async () => {
    const status = projectStatus();
    const run = status.workflowRuns[0];
    if (!run?.budget) throw new Error("fixture Run budget is required");
    run.budget.userWaitStartedAtMs = 500_000;
    const call = vi.fn(async (_request: { type: string }) => ({ type: "projectStatus", data: status }));

    render(<ProjectPanel
      client={{ call } as unknown as Client}
      session={pmSession()}
      workspaces={workspaces()}
      onOpenSession={vi.fn()}
      onOpenWorkspace={vi.fn()}
    />);

    expect(await screen.findByText("等待用户决定（执行计时已暂停）")).toBeInTheDocument();
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
    intent: { revision: 9, outcome: "另一条需求", acceptance: ["不应展示"], constraints: [], outOfScope: [] },
    workPackages: [{
      id: "combat", title: "战斗", outcome: "实现战斗循环", status: "blocked", dependencies: [],
      controllerSessionId: "s_pm",
      requiredSpaceTags: ["gameplay"],
      agentSpace: "implementation-1", repository: "game", branch: "work/combat", workflowRunId: "run-s_pm",
      nodeInstanceId: "implement-1", workSessionId: "s_work", blockReason: "等待资源", integrationError: "合并冲突",
      reviewVerdict: "fail",
      reviewFindings: [{
        severity: "high",
        title: "存档迁移丢失 v1 字段",
        acceptanceImpact: "违反 v1/v2 兼容验收标准",
        recommendedAction: "保留旧字段并增加回归测试",
        estimatedRequests: 2,
      }],
    }, {
      id: "other", title: "其他", outcome: "另一会话的工作", status: "accepted", dependencies: [],
      controllerSessionId: "s_other",
      requiredSpaceTags: [],
      agentSpace: "implementation-2", repository: "game", branch: "work/other", workflowRunId: "run-s_other",
      nodeInstanceId: "implement-1",
    }],
    agentSpaces: [{
      name: "implementation-1", purpose: "实现", workspaceId: "w_impl", sourceCommit: "a".repeat(40),
      builderLockDigest: "b".repeat(64), role: "implementation", tags: ["implementation"], active: true,
      resourceState: "quarantined", resourceRevision: 2, workPackageId: "combat", workSessionId: "s_work",
    }],
    workflowCatalog: { recommended: "feature", workflows: [{
      id: "feature", version: 1, entry: "intake",
      executionBudget: { wallClockMs: 600_000, maxWorkSessions: 16, maxConcurrentWorkSessions: 4, maxLlmRequests: 96 },
      nodes: [{ id: "intake", kind: "activity" }, { id: "implement", kind: "activity" }, { id: "diagnose", kind: "activity" }, { id: "delivered", kind: "terminal" }],
      edges: [
        { id: "retry", label: "采用修正方案重试", description: "保留验收目标并重新执行。", from: "diagnose", to: "implement", condition: "diagnosis.retryApproved", chooseBy: "user" },
        { id: "alternative", from: "diagnose", to: "implement", condition: "diagnosis.alternativeReady", chooseBy: "pm" },
        { id: "finish", from: "diagnose", to: "delivered", condition: "diagnosis.resolved" },
      ],
    }] },
    workflowRuns: [{
      id: "run-s_pm", controllerSessionId: "s_pm", graphId: "feature", graphVersion: 1, status: "active",
      definition: null,
      interpreterError: "automatic transition limit exceeded",
      budget: {
        wallClockMs: 600_000,
        maxWorkSessions: 16,
        maxConcurrentWorkSessions: 4,
        maxLlmRequests: 96,
        startedAtMs: 1,
        deadlineAtMs: 600_001,
        remainingMs: 540_000,
        userWaitMs: 5_000,
        workSessionsStarted: 2,
        activeWorkSessions: 1,
        llmRequestsObserved: 20,
        llmRequestsRemaining: 76,
      },
      activeNodes: ["diagnose"], facts: [], revision: 3,
      intent: { revision: 1, outcome: "交付可玩的 H5 游戏", acceptance: ["可玩"], constraints: [], outOfScope: [] },
      supervisor: supervisor(),
      nodeInstances: [
        { id: "implement-1", nodeId: "implement", iteration: 1, status: "blocked", cohortId: "root-1", fanoutSource: "plan.workstreams", fanoutSealed: true },
        { id: "diagnose-1", nodeId: "diagnose", iteration: 1, status: "active", cohortId: "root-1", fanoutSealed: false },
      ],
      resourceCapacities: [
        { nodeId: "implement", spaceTags: ["implementation"], maxItems: 4, allocatedItems: 1, matchingSpaces: 2, availableSpaces: 1, availableSlots: 0 },
      ],
      teamSlots: [{ id: "slot-combat", nodeInstanceId: "implement-1", workPackageId: "combat", responsibility: "实现战斗循环", workSessionId: "s_work", status: "blocked" }],
      availableEdges: [
        { id: "retry", label: "采用修正方案重试", description: "保留验收目标并重新执行。", from: "diagnose", to: "implement", condition: "diagnosis.retryApproved", chooseBy: "user", satisfied: true },
        { id: "alternative", from: "diagnose", to: "implement", condition: "diagnosis.alternativeReady", chooseBy: "pm", satisfied: true },
        { id: "finish", from: "diagnose", to: "delivered", condition: "diagnosis.resolved", satisfied: true },
      ],
    }],
    improvementCandidates: [],
    supervisor: supervisor(),
  };
}

function supervisor() {
  return {
    mode: "idle",
    wakePending: false,
    wakeDispatchCount: 0,
    wakeFailedCount: 0,
    coalescedEventCount: 0,
  };
}

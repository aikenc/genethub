import type {
  AgentInfo,
  AgentSelectionPreferences,
  WorkspaceInfo,
} from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ForkDialog, type ForkMachineOption } from "./ForkDialog";

function agent(id: string, label: string, fork: boolean, ready = true): AgentInfo {
  return {
    id,
    label,
    builtin: false,
    probe: ready ? { state: "ready" } : { state: "notInstalled" },
    capabilities: {
      interrupt: false,
      setModel: false,
      setEffort: false,
      setFast: false,
      setMode: false,
      permissions: false,
      resume: false,
      fork,
      attachments: false,
    },
    catalog: {
      models: [{ id: "model", label: "Model", contextWindow: 100_000, reasoning: true, efforts: [], supportsFast: false }],
      modes: [],
      commands: [],
    },
  };
}

function workspace(id: string, name: string, workspaceFile?: string): WorkspaceInfo {
  return {
    id,
    name,
    root: `/work/${id}`,
    isGitRepo: true,
    folders: [],
    ...(workspaceFile ? { workspaceFile } : {}),
  };
}

function preferences(
  selectedTags: string[],
  profiles: Array<{ agentId: string; tags: string[]; cost?: "low" | "medium" | "high" }> ,
): AgentSelectionPreferences {
  return {
    selectedTags,
    modelProfiles: profiles.map((profile) => ({
      agentId: profile.agentId,
      modelId: "model",
      tags: profile.tags,
      cost: profile.cost ?? "medium",
    })),
    runtimes: {},
  };
}

const sourceMachine: ForkMachineOption = {
  id: "machine-source",
  routeId: "local",
  label: "开发机",
  kind: "local",
  online: true,
};

describe("ForkDialog", () => {
  it("locks historical media tags and selects a model that can reconstruct them", () => {
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="codex"
        sourceModelId="model"
        sourceTags={["Pro"]}
        sourceMediaTags={["图片理解"]}
        sourceCatalog={{
          agents: [agent("codex", "Codex", true), agent("claude", "Claude Code", false)],
          workspaces: [workspace("w1", "GeneHub")],
          agentPreferences: preferences(["Pro"], [
            { agentId: "codex", tags: ["Pro"], cost: "low" },
            { agentId: "claude", tags: ["Pro", "图片理解"] },
          ]),
        }}
        hasNativeCheckpoint
        onClose={vi.fn()}
        onConfirm={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole("button", { name: "图片理解 · 自动" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: /Codex · Model/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Claude · Model.*当前/ })).toBeInTheDocument();
    expect(screen.getByText("重建会话")).toBeInTheDocument();
  });

  it("keeps the same-Agent native contract and reconstructs after switching tags", async () => {
    const onConfirm = vi.fn(async () => true);
    const onClose = vi.fn();
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="codex"
        sourceModelId="model"
        sourceTags={["Pro"]}
        sourceCatalog={{
          agents: [
            agent("codex", "Codex", true),
            agent("claude", "Claude Code", false),
            agent("cursor", "Cursor", false, false),
          ],
          workspaces: [workspace("w1", "GeneHub")],
          agentPreferences: preferences(["Pro"], [
            { agentId: "codex", tags: ["Pro"], cost: "low" },
            { agentId: "claude", tags: ["Flush"] },
            { agentId: "cursor", tags: ["Max"] },
          ]),
        }}
        hasNativeCheckpoint
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("button", { name: "Pro" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: /Codex · Model.*当前/ })).toBeInTheDocument();
    expect(screen.getByText("原生分支")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Flush" }));
    expect(screen.getByRole("option", { name: /Claude · Model/ })).toBeInTheDocument();
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    expect(screen.getByText(/上下文窗口的 35%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      machine: sourceMachine,
      workspaceId: "w1",
      target: {
        agentId: "claude",
        workspaceId: "w1",
        modelId: "model",
        runtimeValues: {},
      },
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("reconstructs onto the original Agent when native Fork is unavailable", async () => {
    const onConfirm = vi.fn(async () => true);
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="cursor"
        sourceModelId="model"
        sourceTags={["Flush"]}
        sourceCatalog={{
          agents: [agent("cursor", "Cursor", false), agent("codex", "Codex", true)],
          workspaces: [workspace("w1", "GeneHub"), workspace("w2", "Suite", "/work/suite.code-workspace")],
          agentPreferences: preferences(["Flush"], [
            { agentId: "cursor", tags: ["Flush"], cost: "low" },
            { agentId: "codex", tags: ["Pro"] },
          ]),
        }}
        hasNativeCheckpoint={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("button", { name: "Flush" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: /Cursor · Model.*当前/ })).toBeInTheDocument();
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建到所选目标" })).toBeEnabled();
    expect(screen.getByRole("option", { name: /GeneHub/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /GeneHub/ }).querySelector("[data-workspace-icon=folder]")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Suite/ }).querySelector("[data-workspace-icon=workspace]")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      machine: sourceMachine,
      workspaceId: "w1",
      target: {
        agentId: "cursor",
        workspaceId: "w1",
        modelId: "model",
        runtimeValues: {},
      },
    }));
  });

  it("keeps the workspace list open while the machine roster finishes loading", async () => {
    let release: (machines: ForkMachineOption[]) => void = () => {};
    const pending = new Promise<ForkMachineOption[]>((resolve) => {
      release = resolve;
    });
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="cursor"
        sourceModelId="model"
        sourceTags={["Flush"]}
        sourceCatalog={{
          agents: [agent("cursor", "Cursor", false)],
          workspaces: [workspace("w1", "GeneHub"), workspace("w2", "Destination")],
          agentPreferences: preferences(["Flush"], [
            { agentId: "cursor", tags: ["Flush"] },
          ]),
        }}
        hasNativeCheckpoint={false}
        listMachines={() => pending}
        onClose={vi.fn()}
        onConfirm={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole("option", { name: /Destination/ })).toBeInTheDocument();
    release([sourceMachine]);
    await waitFor(() => expect(screen.queryByText("正在读取机器列表…")).not.toBeInTheDocument());
    expect(screen.getByRole("option", { name: /Destination/ })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "目标项目" })).toBeInTheDocument();
  });

  it("loads the selected machine's workspaces and machine-global tag routes", async () => {
    const remote: ForkMachineOption = {
      id: "machine-remote",
      routeId: "hub-row-7",
      label: "GPU 工作站",
      kind: "remote",
      online: true,
    };
    const offline: ForkMachineOption = {
      id: "machine-offline",
      routeId: "hub-row-8",
      label: "离线机器",
      kind: "remote",
      online: false,
    };
    const onConfirm = vi.fn(async () => true);
    const loadCatalog = vi.fn(async () => ({
      agents: [agent("claude", "Claude Code", false)],
      workspaces: [workspace("remote-w", "模型仓库")],
      agentPreferences: preferences(["Flush"], [
        { agentId: "claude", tags: ["Flush"] },
      ]),
    }));
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="codex"
        sourceModelId="model"
        sourceTags={["Pro"]}
        sourceCatalog={{
          agents: [agent("codex", "Codex", true)],
          workspaces: [workspace("w1", "GeneHub")],
          agentPreferences: preferences(["Pro"], [
            { agentId: "codex", tags: ["Pro"] },
          ]),
        }}
        hasNativeCheckpoint
        listMachines={async () => [sourceMachine, remote, offline]}
        loadCatalog={loadCatalog}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(await screen.findByRole("radio", { name: "GPU 工作站" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "离线机器 离线" })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "GPU 工作站" }));

    expect(await screen.findByRole("option", { name: /模型仓库/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Flush" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: /Claude · Model/ })).toBeInTheDocument();
    expect(loadCatalog).toHaveBeenCalledWith(remote);
    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      machine: remote,
      workspaceId: "remote-w",
      target: {
        agentId: "claude",
        workspaceId: "remote-w",
        modelId: "model",
        runtimeValues: {},
      },
    }));
  });
});

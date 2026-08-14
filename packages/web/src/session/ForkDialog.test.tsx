import type { AgentInfo, WorkspaceInfo } from "@genehub/proto";
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
      setMode: false,
      permissions: false,
      resume: false,
      fork,
      attachments: false,
    },
    catalog: {
      models: [{ id: "model", label: "Model", contextWindow: 100_000, reasoning: true, efforts: [] }],
      modes: [],
      commands: [],
    },
  };
}

function workspace(id: string, name: string): WorkspaceInfo {
  return { id, name, root: `/work/${id}`, isGitRepo: true, folders: [] };
}

const sourceMachine: ForkMachineOption = {
  id: "machine-source",
  routeId: "local",
  label: "开发机",
  kind: "local",
  online: true,
};

describe("ForkDialog", () => {
  it("defaults to an unchanged native target and reconstructs after switching Agent", async () => {
    const onConfirm = vi.fn(async () => true);
    const onClose = vi.fn();
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="codex"
        sourceCatalog={{
          agents: [
            agent("codex", "Codex", true),
            agent("claude", "Claude Code", false),
            agent("cursor", "Cursor", false, false),
          ],
          workspaces: [workspace("w1", "GeneHub")],
        }}
        hasNativeCheckpoint
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("radio", { name: "Codex" })).toBeChecked();
    expect(screen.getByText("原生分支")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Cursor 未安装" })).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "Claude Code" }));
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    expect(screen.getByText(/上下文窗口的 35%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      machine: sourceMachine,
      workspaceId: "w1",
      agentId: "claude",
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("allows a same-Agent reconstruction only after the workspace changes", async () => {
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="codex"
        sourceCatalog={{
          agents: [agent("codex", "Codex", true)],
          workspaces: [workspace("w1", "Source"), workspace("w2", "Destination")],
        }}
        hasNativeCheckpoint={false}
        onClose={vi.fn()}
        onConfirm={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText("当前回合不可原生 Fork")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建到所选目标" })).toBeDisabled();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "目标工作区" }), "w2");
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建到所选目标" })).toBeEnabled();
  });

  it("loads only the selected machine's existing workspaces and Agents", async () => {
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
    }));
    render(
      <ForkDialog
        sourceMachine={sourceMachine}
        sourceWorkspaceId="w1"
        sourceAgentId="codex"
        sourceCatalog={{
          agents: [agent("codex", "Codex", true)],
          workspaces: [workspace("w1", "GeneHub")],
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
    expect(screen.getByRole("radio", { name: "Claude Code" })).toBeChecked();
    expect(loadCatalog).toHaveBeenCalledWith(remote);
    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      machine: remote,
      workspaceId: "remote-w",
      agentId: "claude",
    }));
  });
});

import type { AgentInfo } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ForkDialog } from "./ForkDialog";

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

describe("ForkDialog", () => {
  it("defaults to the current Agent's native checkpoint and explains cross-Agent reconstruction", async () => {
    const onConfirm = vi.fn(async () => true);
    const onClose = vi.fn();
    render(
      <ForkDialog
        agents={[
          agent("codex", "Codex", true),
          agent("claude", "Claude Code", false),
          agent("cursor", "Cursor", false, false),
        ]}
        sourceAgentId="codex"
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
    await userEvent.click(screen.getByRole("button", { name: "用 Claude Code 重建" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("claude"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("never falls back to a history capsule for the unchanged Agent", () => {
    render(
      <ForkDialog
        agents={[agent("codex", "Codex", true)]}
        sourceAgentId="codex"
        hasNativeCheckpoint={false}
        onClose={vi.fn()}
        onConfirm={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText("当前回合不可原生 Fork")).toBeInTheDocument();
    expect(screen.queryByText(/上下文窗口的 35%/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "无法原生 Fork" })).toBeDisabled();
  });
});

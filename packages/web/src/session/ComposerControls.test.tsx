import type { AgentInfo } from "@genehub/proto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComposerControls, resolveRuntimeSelection } from "./ComposerControls";

const AGENTS: AgentInfo[] = [
  {
    id: "genet",
    label: "GeneHub Agent",
    builtin: true,
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: true,
      setEffort: true,
      setMode: false,
      permissions: false,
      resume: true,
      fork: false,
      attachments: false,
    },
    catalog: {
      models: [
        {
          id: "deepseek/v4-long-name",
          label: "DeepSeek V4 Long",
          contextWindow: 128_000,
          reasoning: true,
          efforts: ["low", "medium", "high"],
        },
      ],
      modes: [],
      commands: [],
      defaultModel: "deepseek/v4-long-name",
      defaultMode: undefined,
      defaultEffort: "medium",
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    builtin: false,
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: false,
      setEffort: false,
      setMode: true,
      permissions: true,
      resume: true,
      fork: false,
      attachments: true,
    },
    catalog: {
      models: [],
      modes: [
        { id: "default", label: "Default", description: "Ask before tools run" },
        { id: "bypassPermissions", label: "Bypass", description: "Run without asking" },
      ],
      commands: [],
      defaultModel: undefined,
      defaultMode: "default",
      defaultEffort: undefined,
    },
  },
];

function controls(overrides: Partial<Parameters<typeof ComposerControls>[0]> = {}) {
  const callbacks = {
    onPickAgent: vi.fn(),
    onPickModel: vi.fn(),
    onPickMode: vi.fn(),
    onPickEffort: vi.fn(),
  };
  render(
    <ComposerControls
      agents={AGENTS}
      agentId="genet"
      modelId={null}
      modeId={null}
      effortId={null}
      {...callbacks}
      {...overrides}
    />,
  );
  return callbacks;
}

async function openSettings(name: RegExp = /Agent：/) {
  const trigger = screen.getByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Agent 与运行设置" }) };
}

describe("the compact runtime summary", () => {
  it("keeps full accessible values while shortening the visible model", () => {
    controls();
    expect(
      screen.getByRole("button", {
        name: "Agent：GeneHub Agent；模型：DeepSeek V4 Long；思考强度：中",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("DeepSeek…")).toBeInTheDocument();
    expect(screen.getByText("中")).toBeInTheDocument();
  });

  it("uses the scoped friendly name for a known Codex model", () => {
    const codex: AgentInfo = {
      ...AGENTS[0]!,
      id: "codex",
      label: "Codex",
      builtin: false,
      catalog: {
        ...AGENTS[0]!.catalog,
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoning: true, efforts: ["low"] }],
        defaultModel: "gpt-5.6-sol",
        defaultEffort: "low",
      },
    };
    controls({ agents: [codex], agentId: "codex" });
    expect(screen.getByText("5.6 Sol")).toBeInTheDocument();
  });

  it("does not advertise effort or mode axes when their catalogs are empty", () => {
    const emptyAxes: AgentInfo = {
      ...AGENTS[0]!,
      capabilities: { ...AGENTS[0]!.capabilities, setMode: true },
      catalog: {
        ...AGENTS[0]!.catalog,
        models: [{ ...AGENTS[0]!.catalog.models[0]!, efforts: [] }],
        modes: [],
        defaultEffort: undefined,
      },
    };
    controls({ agents: [emptyAxes] });
    const summary = screen.getByRole("button", { name: /Agent：GeneHub Agent/ });
    expect(summary).not.toHaveAccessibleName(/思考强度|权限|模式/);
  });
});

describe("the rich runtime settings panel", () => {
  it("opens as a dialog and restores focus when closed", async () => {
    controls();
    const { trigger, dialog } = await openSettings();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText("128K 上下文")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "关闭运行设置" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("gives visually hidden radio controls a visible keyboard focus ring", async () => {
    controls();
    const { dialog } = await openSettings();
    const agent = within(dialog).getByRole("radio", { name: "GeneHub Agent" });
    const effort = within(dialog).getByRole("radio", { name: /高/ });
    await waitFor(() => expect(agent).toHaveFocus());
    expect(agent.closest("label")).toHaveClass("has-[:focus-visible]:outline-2");
    expect(effort.closest("label")).toHaveClass("has-[:focus-visible]:outline-2");
  });

  it("locks only the Agent choice once a conversation has history", async () => {
    controls({ agentLocked: true });
    const { dialog } = await openSettings();
    expect(within(dialog).getByText(/当前会话已有内容/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "GeneHub Agent" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /高/ })).toBeEnabled();
  });

  it("keeps an unavailable bound Agent visible without pretending it is Codex", async () => {
    const unavailable = {
      ...AGENTS[0]!,
      probe: { state: "unavailable", reason: "请先登录" } as const,
    };
    const codex = { ...AGENTS[1]!, id: "codex", label: "Codex" };
    const onPickAgent = vi.fn();
    controls({ agents: [unavailable, codex], onPickAgent });
    const { dialog } = await openSettings(/Agent：GeneHub Agent（不可用：请先登录）/);

    expect(
      within(dialog).getByRole("radio", { name: "GeneHub Agent 不可用：请先登录" }),
    ).toBeChecked();
    expect(within(dialog).getByText("不可用：请先登录")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Codex" }));
    expect(onPickAgent).toHaveBeenCalledWith("codex");
  });

  it("selects model ids and effort ids without changing their wire values", async () => {
    const second = {
      id: "provider/a-very-long-model-id",
      label: "A very long model label",
      reasoning: true,
      efforts: ["low", "high"],
    };
    const agents = [
      {
        ...AGENTS[0]!,
        catalog: { ...AGENTS[0]!.catalog, models: [...AGENTS[0]!.catalog.models, second] },
      },
    ];
    const callbacks = controls({ agents });
    const { dialog } = await openSettings();

    await userEvent.click(within(dialog).getByRole("radio", { name: /A very long model label/ }));
    expect(callbacks.onPickModel).toHaveBeenCalledWith("provider/a-very-long-model-id");
    await userEvent.click(within(dialog).getByRole("radio", { name: /高/ }));
    expect(callbacks.onPickEffort).toHaveBeenCalledWith("high");
  });

  it("keeps permission descriptions and maps unrestricted access to an unlock badge", async () => {
    const onPickMode = vi.fn();
    controls({ agentId: "claude", onPickMode });
    expect(screen.getByRole("button", { name: /权限：执行前确认/ })).toBeInTheDocument();
    const { dialog } = await openSettings(/Agent：Claude Code/);
    expect(within(dialog).getByText("Run without asking")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Bypass/ }));
    expect(onPickMode).toHaveBeenCalledWith("bypassPermissions");
  });

  it("shows a vanished model as unavailable instead of replacing it with the default", async () => {
    controls({ modelId: "provider/removed-model" });
    expect(screen.getByRole("button", { name: /模型：provider\/removed-model/ })).toBeInTheDocument();
    const { dialog } = await openSettings();
    const stale = within(dialog).getByRole("radio", { name: /provider\/removed-model/ });
    expect(stale).toBeChecked();
    expect(stale).toBeDisabled();
    expect(within(dialog).getByText("当前目录已不再提供")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    controls();
    await openSettings();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("runtime selection", () => {
  it("uses the same ready default Agent as a new draft", () => {
    const unavailable = { ...AGENTS[0]!, probe: { state: "notInstalled" } as const };
    expect(
      resolveRuntimeSelection({
        agents: [unavailable, AGENTS[1]!],
        agentId: null,
        modelId: null,
        modeId: null,
        effortId: null,
      }).current?.id,
    ).toBe("claude");
  });
});

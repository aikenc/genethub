import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComposerControls } from "./ComposerControls";

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
      attachments: true,
    },
    catalog: {
      models: [
        {
          id: "deepseek/v4",
          label: "DeepSeek V4",
          contextWindow: 128_000,
          reasoning: true,
          efforts: ["low", "medium", "high"],
          inputModalities: [],
        },
        {
          id: "vision",
          label: "Vision",
          reasoning: true,
          efforts: ["medium", "high"],
          inputModalities: ["image"],
        },
        {
          id: "omni",
          label: "Omni",
          reasoning: true,
          efforts: ["medium", "high"],
          inputModalities: ["image", "video"],
        },
      ],
      modes: [],
      commands: [],
      defaultModel: "deepseek/v4",
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
      setModel: true,
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
        { id: "default", label: "Default", description: "Ask first" },
        { id: "bypassPermissions", label: "Bypass", description: "Run freely" },
      ],
      commands: [],
      defaultModel: undefined,
      defaultMode: "default",
      defaultEffort: undefined,
    },
  },
];

const PREFERENCES: AgentSelectionPreferences = {
  capabilities: {
    planning: [{ agentId: "genet", modelId: "deepseek/v4" }],
    coding: [{ agentId: "claude" }],
    multimodal: [],
  },
  selectedCapability: "planning",
  runtimes: {
    genet: { effortId: "high", runtimeValues: {} },
    claude: { modeId: "bypassPermissions", runtimeValues: {} },
  },
};

function controls(overrides: Partial<Parameters<typeof ComposerControls>[0]> = {}) {
  const callbacks = {
    onPickCapability: vi.fn(),
    onSavePreferences: vi.fn(async (_preferences: AgentSelectionPreferences) => {}),
    onPickMode: vi.fn(),
    onPickEffort: vi.fn(),
    onPickRuntimeAxis: vi.fn(),
    onRefreshAgents: vi.fn(),
  };
  render(
    <ComposerControls
      agents={AGENTS}
      preferences={PREFERENCES}
      capability="planning"
      agentId="genet"
      modelId="deepseek/v4"
      modeId={null}
      effortId="high"
      {...callbacks}
      {...overrides}
    />,
  );
  return callbacks;
}

async function openSettings(name: RegExp = /能力：规划/) {
  const trigger = screen.getByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "能力与运行设置" }) };
}

describe("the capability-first composer control", () => {
  it("shows capability and compact runtime state without exposing Agent selection", () => {
    controls();
    expect(
      screen.getByRole("button", { name: "能力：规划；思考强度：高" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("规划")).toBeInTheDocument();
    expect(screen.queryByText("GeneHub Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("DeepSeek V4")).not.toBeInTheDocument();
  });

  it("offers exactly the three built-in capabilities and disables an empty route", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    expect(within(dialog).getByRole("radio", { name: /规划/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /多模态理解/ })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole("radio", { name: /编码/ }));
    expect(callbacks.onPickCapability).toHaveBeenCalledWith("coding");
  });

  it("does not substitute a default Agent when the selected capability has no route", async () => {
    controls({
      capability: "multimodal",
      agentId: null,
      modelId: null,
      modeId: null,
      effortId: null,
    });
    const { dialog } = await openSettings(/能力：多模态理解/);
    expect(within(dialog).queryByLabelText("思考强度")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/没有可用的 Agent 与模型/)).toBeInTheDocument();
  });

  it("keeps thinking and permission in compact selects", async () => {
    const planning = controls();
    let opened = await openSettings();
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("思考强度"), "medium");
    expect(planning.onPickEffort).toHaveBeenCalledWith("medium");
    await userEvent.click(within(opened.dialog).getByRole("button", { name: "关闭能力设置" }));

    const coding = controls({
      capability: "coding",
      agentId: "claude",
      modelId: null,
      modeId: "bypassPermissions",
      effortId: null,
    });
    opened = await openSettings(/能力：编码；权限：完全访问/);
    expect(within(opened.dialog).getByLabelText("权限")).toHaveValue("bypassPermissions");
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("权限"), "default");
    expect(coding.onPickMode).toHaveBeenCalledWith("default");
  });

  it("opens the ordered Agent + model editor and saves the whole machine value", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    await userEvent.click(within(dialog).getByRole("button", { name: "编辑能力首选项" }));

    expect(screen.getByRole("dialog", { name: "能力首选 Agent" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "内置能力" })).toBeInTheDocument();
    expect(screen.getByLabelText("第 1 项 Agent")).toHaveValue("genet");
    expect(screen.getByLabelText("第 1 项模型")).toHaveValue("deepseek/v4");
    expect(screen.getByRole("button", { name: "保存到这台机器" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "添加首选项" }));
    expect(screen.getByLabelText("第 2 项 Agent")).toHaveValue("genet");
    expect(screen.getByLabelText("第 2 项模型")).toHaveValue("vision");
    expect(
      within(screen.getByLabelText("第 2 项模型")).getByRole("option", {
        name: /DeepSeek V4（已配置）/,
      }),
    ).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("第 2 项模型"), "omni");
    await userEvent.click(screen.getByRole("button", { name: "上移第 2 项" }));
    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));
    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    expect(callbacks.onSavePreferences.mock.calls[0]?.[0].capabilities.planning).toEqual([
      { agentId: "genet", modelId: "omni" },
      { agentId: "genet", modelId: "deepseek/v4" },
    ]);
  });

  it("marks image and video support on every model choice", async () => {
    controls();
    const { dialog } = await openSettings();
    await userEvent.click(within(dialog).getByRole("button", { name: "编辑能力首选项" }));

    const model = screen.getByLabelText("第 1 项模型");
    expect(within(model).getByRole("option", { name: /DeepSeek V4 · 图片— · 视频—/ })).toBeInTheDocument();
    expect(within(model).getByRole("option", { name: /Vision · 图片✓ · 视频—/ })).toBeInTheDocument();
    expect(within(model).getByRole("option", { name: /Omni · 图片✓ · 视频✓/ })).toBeInTheDocument();
    expect(screen.getByLabelText("第 1 项媒体输入支持")).toHaveTextContent("图片 —视频 —");

    await userEvent.selectOptions(model, "omni");
    expect(screen.getByLabelText("第 1 项媒体输入支持")).toHaveTextContent("图片 ✓视频 ✓");
  });

  it("locks capability switching after history but leaves runtime controls usable", async () => {
    controls({ agentLocked: true });
    const { dialog } = await openSettings();
    expect(within(dialog).getByRole("radio", { name: /规划/ })).toBeDisabled();
    expect(within(dialog).getByLabelText("思考强度")).toBeEnabled();
    expect(within(dialog).getByText(/当前会话已有内容/)).toBeInTheDocument();
  });

  it("restores focus and closes on Escape", async () => {
    controls();
    const { trigger } = await openSettings();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

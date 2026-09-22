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
  capabilities: { planning: [], coding: [], multimodal: [] },
  selectedCapability: "planning",
  selectedTags: ["Pro"],
  modelProfiles: [
    { agentId: "genet", modelId: "deepseek/v4", tags: ["Pro"], cost: "medium" },
    { agentId: "genet", modelId: "vision", tags: ["Pro", "图片理解"], cost: "high" },
    {
      agentId: "genet",
      modelId: "omni",
      tags: ["Pro", "图片理解", "视频理解"],
      cost: "veryHigh",
    },
    { agentId: "claude", tags: ["Flush"], cost: "low" },
  ],
  runtimes: {
    genet: { effortId: "high", runtimeValues: {} },
    claude: { modeId: "bypassPermissions", runtimeValues: {} },
  },
};

function controls(overrides: Partial<Parameters<typeof ComposerControls>[0]> = {}) {
  const callbacks = {
    onPickTags: vi.fn(),
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
      tags={["Pro"]}
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

async function openSettings(name: RegExp = /路由：GeneHub Agent/) {
  const trigger = screen.getByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "标签与运行设置" }) };
}

describe("the tag-routed composer control", () => {
  it("shows the resolved Agent and model in the compact trigger", () => {
    controls();
    const trigger = screen.getByRole("button", {
      name: /路由：GeneHub Agent · DeepSeek.*标签：Pro.*思考强度：高/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent(/GeneHub Agent · DeepSeek/);
  });

  it("selects multiple tags with AND semantics", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    expect(within(dialog).getByRole("button", { name: "Pro" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Max" }));
    expect(callbacks.onPickTags).toHaveBeenCalledWith(["Pro", "Max"]);
  });

  it("shows media tags as automatic and prevents removing them", async () => {
    controls({ mediaTags: ["图片理解"] });
    const { dialog } = await openSettings();
    const image = within(dialog).getByRole("button", { name: /图片理解 · 自动/ });
    expect(image).toBeDisabled();
    expect(image).toHaveAttribute("aria-pressed", "true");
  });

  it("does not substitute an Agent when no row matches every tag", async () => {
    controls({ tags: ["Max"], agentId: null, modelId: null, effortId: null });
    const { dialog } = await openSettings(/路由：未匹配 Agent/);
    expect(within(dialog).getByText(/没有 Agent 与模型同时匹配全部标签/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("思考强度")).not.toBeInTheDocument();
  });

  it("keeps thinking and permission in compact selects", async () => {
    const planning = controls();
    let opened = await openSettings();
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("思考强度"), "medium");
    expect(planning.onPickEffort).toHaveBeenCalledWith("medium");
    await userEvent.click(within(opened.dialog).getByRole("button", { name: "关闭设置" }));

    const coding = controls({
      tags: ["Flush"],
      agentId: "claude",
      modelId: null,
      modeId: "bypassPermissions",
      effortId: null,
    });
    opened = await openSettings(/路由：Claude Code/);
    expect(within(opened.dialog).getByLabelText("权限")).toHaveValue("bypassPermissions");
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("权限"), "default");
    expect(coding.onPickMode).toHaveBeenCalledWith("default");
  });

  it("edits cost and one-to-four tags for every exact Agent + model row", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    await userEvent.click(within(dialog).getByRole("button", { name: "Agent 配置" }));

    expect(screen.getByRole("dialog", { name: "Agent 配置" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    const cost = screen.getByLabelText("GeneHub Agent DeepSeek V4 成本");
    await userEvent.selectOptions(cost, "veryHigh");
    await userEvent.click(screen.getAllByRole("button", { name: "Max" })[0]!);
    const custom = screen.getByLabelText("GeneHub Agent DeepSeek V4 自定义标签");
    await userEvent.type(custom, "私有{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    const saved = callbacks.onSavePreferences.mock.calls[0]![0];
    expect(saved.modelProfiles?.find((row) => row.modelId === "deepseek/v4")).toMatchObject({
      agentId: "genet",
      cost: "veryHigh",
      tags: ["Pro", "Max", "私有"],
    });
  });

  it("restores focus and closes on Escape", async () => {
    controls();
    const { trigger } = await openSettings();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

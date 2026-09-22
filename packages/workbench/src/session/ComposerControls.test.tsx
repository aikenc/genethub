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
        { id: "auto", label: "Auto", reasoning: true, efforts: [], inputModalities: [] },
        { id: "extra", label: "Extra", reasoning: true, efforts: ["high"], inputModalities: [] },
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
    onPickTarget: vi.fn(async () => {}),
    onSavePreferences: vi.fn(async (_preferences: AgentSelectionPreferences) => {}),
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

async function openSettings(name: RegExp = /模型：GeneHub Agent/) {
  const trigger = screen.getByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "模型选择" }) };
}

describe("the exact model composer control", () => {
  it("shows the resolved Agent and model in the compact trigger", () => {
    controls();
    const trigger = screen.getByRole("button", {
      name: /模型：GeneHub Agent · DeepSeek.*筛选：Pro.*思考强度：高/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent(/GeneHub Agent · DeepSeek/);
  });

  it("keeps Max, Pro and Flush mutually exclusive while filtering", async () => {
    controls();
    const { dialog } = await openSettings();
    expect(within(dialog).getByRole("button", { name: "Pro" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Max" }));
    expect(within(dialog).getByRole("button", { name: "Max" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Pro" })).toHaveAttribute("aria-pressed", "false");
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
    const { dialog } = await openSettings(/模型：未匹配 Agent/);
    expect(within(dialog).getByText(/没有 Agent 与模型匹配全部筛选条件/)).toBeInTheDocument();
  });

  it("keeps thinking and permission in compact selects", async () => {
    const planning = controls();
    let opened = await openSettings();
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("思考强度"), "medium");
    await userEvent.click(within(opened.dialog).getByRole("button", { name: "使用此模型" }));
    expect(planning.onPickTarget).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "genet", modelId: "deepseek/v4", effortId: "medium" }),
      ["Pro"],
    );

    const coding = controls({
      tags: ["Flush"],
      agentId: "claude",
      modelId: null,
      modeId: "bypassPermissions",
      effortId: null,
    });
    opened = await openSettings(/模型：Claude Code/);
    expect(within(opened.dialog).getByLabelText("权限")).toHaveValue("bypassPermissions");
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("权限"), "default");
    await userEvent.click(within(opened.dialog).getByRole("button", { name: "使用此模型" }));
    expect(coding.onPickTarget).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude", modeId: "default" }),
      ["Flush"],
    );
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
    await userEvent.click(screen.getByText("标签组"));
    await userEvent.type(screen.getByLabelText("新标签组名称"), "偏好");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await userEvent.selectOptions(
      screen.getByLabelText("私有 标签组"),
      screen.getByRole("option", { name: "偏好" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    const saved = callbacks.onSavePreferences.mock.calls[0]![0];
    expect(saved.modelProfiles?.find((row) => row.modelId === "deepseek/v4")).toMatchObject({
      agentId: "genet",
      cost: "veryHigh",
      tags: ["Max", "私有"],
    });
    expect(saved.tagGroups).toEqual([
      expect.objectContaining({ label: "偏好", tags: ["私有"] }),
    ]);
  });

  it("hides auto and adds later catalog models on demand", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    await userEvent.click(within(dialog).getByRole("button", { name: "Agent 配置" }));

    expect(screen.queryByText("Auto")).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "添加模型" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Extra" }));
    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    const saved = callbacks.onSavePreferences.mock.calls[0]![0];
    expect(saved.modelProfiles?.some((row) => row.agentId === "genet" && row.modelId === "extra"))
      .toBe(true);
    expect(saved.modelProfiles?.some((row) => row.modelId === "auto")).toBe(false);
  });

  it("keeps unsaved model edits across a structurally identical Agent refresh", async () => {
    const callbacks = {
      onPickTarget: vi.fn(async () => {}),
      onSavePreferences: vi.fn(async (_preferences: AgentSelectionPreferences) => {}),
      onRefreshAgents: vi.fn(),
    };
    const props = {
      preferences: PREFERENCES,
      tags: ["Pro"],
      agentId: "genet",
      modelId: "deepseek/v4",
      modeId: null,
      effortId: "high",
      ...callbacks,
    };
    const rendered = render(<ComposerControls agents={AGENTS} {...props} />);
    await openSettings();
    await userEvent.click(screen.getByRole("button", { name: "Agent 配置" }));
    await userEvent.click(screen.getByRole("button", { name: "移除 GeneHub Agent Omni" }));
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));
    await userEvent.click(screen.getByRole("button", { name: "Extra" }));

    const refreshedAgents = AGENTS.map((agent) => ({
      ...agent,
      catalog: {
        ...agent.catalog,
        models: agent.catalog.models.map((model) => ({ ...model })),
      },
    }));
    const refreshedPreferences: AgentSelectionPreferences = {
      ...PREFERENCES,
      modelProfiles: PREFERENCES.modelProfiles?.map((profile) => ({
        ...profile,
        tags: [...profile.tags],
      })),
      runtimes: { ...PREFERENCES.runtimes },
    };
    rendered.rerender(
      <ComposerControls
        agents={refreshedAgents}
        {...props}
        preferences={refreshedPreferences}
      />,
    );

    expect(screen.queryByRole("button", { name: "移除 GeneHub Agent Omni" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 GeneHub Agent Extra" })).toBeInTheDocument();
    const group = screen.getAllByRole("group", { name: "智能档位" })[0]!;
    expect(within(group).getByText("Max")).toBeInTheDocument();
    expect(within(group).getByText("Pro")).toBeInTheDocument();
    expect(within(group).getByText("Flush")).toBeInTheDocument();
  });

  it("does not show models for an inactive Agent", async () => {
    const inactive: AgentInfo = {
      ...AGENTS[0]!,
      id: "inactive",
      label: "Inactive Agent",
      probe: { state: "notInstalled" },
    };
    controls({ agents: [...AGENTS, inactive] });
    const { dialog } = await openSettings();
    await userEvent.click(within(dialog).getByRole("button", { name: "Agent 配置" }));

    expect(screen.queryByText("Inactive Agent")).not.toBeInTheDocument();
  });

  it("restores focus and closes on Escape", async () => {
    controls();
    const { trigger } = await openSettings();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

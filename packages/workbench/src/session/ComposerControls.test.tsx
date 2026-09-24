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
      setFast: true,
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
          supportsFast: false,
        },
        {
          id: "vision",
          label: "Vision",
          reasoning: true,
          efforts: ["medium", "high"],
          inputModalities: ["image"],
          supportsFast: false,
        },
        {
          id: "omni",
          label: "Omni",
          reasoning: true,
          efforts: ["medium", "high"],
          inputModalities: ["image", "video"],
          supportsFast: false,
        },
        { id: "auto", label: "Auto", reasoning: true, efforts: [], inputModalities: [], supportsFast: false },
        { id: "extra", label: "Extra", reasoning: true, efforts: ["high"], inputModalities: [], supportsFast: true },
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
      setFast: false,
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

async function openSettings(name: RegExp = /模型：Genet/) {
  const trigger = screen.getByRole("button", { name });
  await userEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "模型选择" }) };
}

describe("the exact model composer control", () => {
  it("shows the resolved Agent and model in the compact trigger", () => {
    controls();
    const trigger = screen.getByRole("button", {
      name: /模型：Genet · DeepSeek.*筛选：Pro.*思考强度：高/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent(/Genet · DeepSeek/);
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
    opened = await openSettings(/模型：Claude/);
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
    expect(dialog).toHaveClass("h-[min(88dvh,52rem)]");
    await userEvent.click(within(dialog).getByRole("button", { name: "Agent 配置" }));

    expect(screen.getByRole("dialog", { name: "Agent 配置" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    const cost = screen.getByLabelText("Genet DeepSeek V4 成本");
    const row = cost.closest("article")!;
    const proBefore = within(row).getByRole("button", { name: "Pro" });
    const selectedClass = proBefore.className;
    await userEvent.click(within(row).getByRole("button", { name: "图片理解" }));
    expect(within(row).getByRole("button", { name: "Pro" }).className).toBe(selectedClass);
    await userEvent.click(within(row).getByRole("button", { name: "图片理解" }));
    await userEvent.selectOptions(cost, "veryHigh");
    await userEvent.click(screen.getAllByRole("button", { name: "Max" })[0]!);
    const custom = screen.getByLabelText("Genet DeepSeek V4 自定义标签");
    await userEvent.type(custom, "私有{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "重命名 Genet DeepSeek V4" }));
    const rename = screen.getByLabelText("Genet DeepSeek V4 新名称");
    await userEvent.clear(rename);
    await userEvent.type(rename, "主模型{Enter}");
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
      displayName: "主模型",
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
    await userEvent.click(screen.getByRole("button", { name: "移除 Genet Omni" }));
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

    expect(screen.queryByRole("button", { name: "移除 Genet Omni" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 Genet Extra" })).toBeInTheDocument();
    const group = screen.getAllByRole("group", { name: "智能档位" })[0]!;
    expect(within(group).getByText("Max")).toBeInTheDocument();
    expect(within(group).getByText("Pro")).toBeInTheDocument();
    expect(within(group).getByText("Flush")).toBeInTheDocument();
  });

  it("allows removing the last model to disable an Agent", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    await userEvent.click(within(dialog).getByRole("button", { name: "Agent 配置" }));

    await userEvent.click(screen.getByRole("button", { name: "移除 Claude Agent 默认" }));
    expect(screen.queryByRole("button", { name: "移除 Claude Agent 默认" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    const saved = callbacks.onSavePreferences.mock.calls[0]![0];
    expect(saved.disabledAgentIds).toContain("claude");
    expect(saved.modelProfiles?.some((profile) => profile.agentId === "claude")).toBe(false);
  });

  it("shows a custom model name in the picker", async () => {
    controls({
      preferences: {
        ...PREFERENCES,
        modelProfiles: PREFERENCES.modelProfiles?.map((profile) =>
          profile.modelId === "deepseek/v4"
            ? { ...profile, displayName: "主模型" }
            : profile,
        ),
      },
    });
    const { dialog } = await openSettings(/模型：Genet · 主模型/);
    expect(within(dialog).getByRole("option", { name: /Genet · 主模型/ })).toBeInTheDocument();
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

  it("keeps same-Agent runtime picks live while a turn runs", async () => {
    const callbacks = controls({ busy: true });
    const { dialog } = await openSettings();

    expect(within(dialog).getByRole("option", { name: /Genet · Vision/ })).toBeEnabled();
    expect(within(dialog).getByText("会话进行中：修改将在下一轮生效")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("option", { name: /Genet · Vision/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "使用此模型" }));
    expect(callbacks.onPickTarget).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "genet", modelId: "vision" }),
      ["Pro"],
    );
  });

  it("locks cross-Agent routes while a turn runs and explains why", async () => {
    controls({
      busy: true,
      preferences: {
        ...PREFERENCES,
        modelProfiles: [
          ...PREFERENCES.modelProfiles!,
          { agentId: "claude", tags: ["Pro"], cost: "low" },
        ],
      },
    });
    const { dialog } = await openSettings();

    const claudeRoute = within(dialog).getByRole("option", { name: /Claude · Agent 默认/ });
    expect(claudeRoute).toBeDisabled();
    expect(claudeRoute).toHaveAttribute("title", "会话进行中，本轮结束后才能切换 Agent");
    expect(within(dialog).getByRole("option", { name: /Genet · DeepSeek/ })).toBeEnabled();
  });

  it("offers every Agent again once the turn has finished", async () => {
    controls({
      busy: false,
      preferences: {
        ...PREFERENCES,
        modelProfiles: [
          ...PREFERENCES.modelProfiles!,
          { agentId: "claude", tags: ["Pro"], cost: "low" },
        ],
      },
    });
    const { dialog } = await openSettings();

    expect(within(dialog).getByRole("option", { name: /Claude · Agent 默认/ })).toBeEnabled();
    expect(within(dialog).queryByText(/会话进行中/)).not.toBeInTheDocument();
  });

  it("restores focus and closes on Escape", async () => {
    controls();
    const { trigger } = await openSettings();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("renders the ⚡ Fast badge when fast mode is enabled", () => {
    controls({ fast: true, modelId: "extra" });
    expect(screen.getByTitle("极速模式（⚡ Fast）：已开启")).toBeInTheDocument();
  });
});

import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigDialog } from "../agents/AgentConfigDialog";
import { ComposerControls } from "./ComposerControls";
import { useWorkbench } from "./store";

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
    id: "codex",
    label: "Codex",
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
    { agentId: "codex", tags: ["Flash"], cost: "low" },
  ],
  runtimes: {
    genet: { effortId: "high", runtimeValues: {} },
    codex: { modeId: "bypassPermissions", runtimeValues: {} },
  },
};

/**
 * The model panel's "模型与 Agent" opens the app-wide dialog, so these tests
 * mount it next to the controls and let it save through the store the way the
 * app does.
 */
function seedStore(
  agents: AgentInfo[],
  preferences: AgentSelectionPreferences,
  callbacks: {
    onSavePreferences(preferences: AgentSelectionPreferences): Promise<boolean>;
    onRefreshAgents(): void;
  },
) {
  useWorkbench.setState({
    agents,
    settings: { agentPreferences: preferences } as never,
    agentConfig: null,
    setAgentPreferences: callbacks.onSavePreferences,
    refreshAgents: async () => callbacks.onRefreshAgents(),
  });
}

async function openAgentConfig(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("button", { name: "模型与 Agent" }));
  await screen.findByRole("dialog", { name: "模型与 Agent" });
}

function controls(overrides: Partial<Parameters<typeof ComposerControls>[0]> = {}) {
  const callbacks = {
    onPickTarget: vi.fn(async () => {}),
    onSavePreferences: vi.fn(async (_preferences: AgentSelectionPreferences) => true),
    onRefreshAgents: vi.fn(),
  };
  seedStore(overrides.agents ?? AGENTS, overrides.preferences ?? PREFERENCES, callbacks);
  render(
    <>
    <AgentConfigDialog />
    <ComposerControls
      agents={AGENTS}
      preferences={PREFERENCES}
      tags={["Pro"]}
      agentId="genet"
      modelId="deepseek/v4"
      modeId={null}
      effortId="high"
      onPickTarget={callbacks.onPickTarget}
      {...overrides}
    />
    </>,
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

  it("keeps Max, Pro and Flash mutually exclusive while filtering", async () => {
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
      tags: ["Flash"],
      agentId: "codex",
      modelId: null,
      modeId: "bypassPermissions",
      effortId: null,
    });
    opened = await openSettings(/模型：Codex/);
    expect(within(opened.dialog).getByLabelText("权限")).toHaveValue("bypassPermissions");
    await userEvent.selectOptions(within(opened.dialog).getByLabelText("权限"), "default");
    await userEvent.click(within(opened.dialog).getByRole("button", { name: "使用此模型" }));
    expect(coding.onPickTarget).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", modeId: "default" }),
      ["Flash"],
    );
  });

  it("edits cost and one-to-four tags for every exact Agent + model row", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    expect(dialog).toHaveClass("h-[min(88dvh,52rem)]");
    await openAgentConfig(dialog);

    expect(screen.getByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    const cost = screen.getByLabelText("Genet DeepSeek V4 成本");
    const row = cost.closest("article")!;
    const proBefore = within(row).getByRole("button", { name: "Pro" });
    const selectedClass = proBefore.className;
    await userEvent.click(within(row).getByRole("button", { name: "图片理解" }));
    expect(within(row).getByRole("button", { name: "Pro" }).className).toBe(selectedClass);
    await userEvent.click(within(row).getByRole("button", { name: "图片理解" }));
    await userEvent.selectOptions(cost, "veryHigh");
    // The model picker's own filter buttons sit underneath; this is the editor's.
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "模型与 Agent" })).getAllByRole("button", { name: "Max" })[0]!,
    );
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
    await openAgentConfig(dialog);

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

  it("closes the 模型与 Agent window once the machine has stored the edits", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    await openAgentConfig(dialog);

    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "模型与 Agent" })).not.toBeInTheDocument(),
    );
    // What was underneath is still there.
    expect(screen.getByRole("dialog", { name: "模型选择" })).toBeInTheDocument();
  });

  it("keeps the window open, edits intact, when the machine refuses the save", async () => {
    const callbacks = controls();
    callbacks.onSavePreferences.mockResolvedValueOnce(false);
    const { dialog } = await openSettings();
    await openAgentConfig(dialog);

    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存到这台机器" })).toBeEnabled());
  });

  it("keeps unsaved model edits across a structurally identical Agent refresh", async () => {
    controls();
    const { dialog } = await openSettings();
    await openAgentConfig(dialog);
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
    // The daemon answers a refresh with equal data in new objects.
    act(() => {
      useWorkbench.setState({
        agents: refreshedAgents,
        settings: { agentPreferences: refreshedPreferences } as never,
      });
    });

    expect(screen.queryByRole("button", { name: "移除 Genet Omni" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 Genet Extra" })).toBeInTheDocument();
    const group = screen.getAllByRole("group", { name: "智能档位" })[0]!;
    expect(within(group).getByText("Ultra")).toBeInTheDocument();
    expect(within(group).getByText("Max")).toBeInTheDocument();
    expect(within(group).getByText("Pro")).toBeInTheDocument();
    expect(within(group).getByText("Flash")).toBeInTheDocument();
    expect(within(group).getByText("Mini")).toBeInTheDocument();
  });

  it("allows removing the last model to disable an Agent", async () => {
    const callbacks = controls();
    const { dialog } = await openSettings();
    await openAgentConfig(dialog);

    await userEvent.click(screen.getByRole("button", { name: "移除 Codex Agent 默认" }));
    expect(screen.queryByRole("button", { name: "移除 Codex Agent 默认" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存到这台机器" }));

    await waitFor(() => expect(callbacks.onSavePreferences).toHaveBeenCalledOnce());
    const saved = callbacks.onSavePreferences.mock.calls[0]![0];
    expect(saved.disabledAgentIds).toContain("codex");
    expect(saved.modelProfiles?.some((profile) => profile.agentId === "codex")).toBe(false);
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
    await openAgentConfig(dialog);

    // It has no models to edit; it is listed with what it needs instead.
    expect(screen.queryByRole("heading", { name: "Inactive Agent" })).not.toBeInTheDocument();
    const waiting = within(screen.getByRole("region", { name: "还不能用的 Agent" }));
    expect(waiting.getByText("Inactive Agent")).toBeInTheDocument();
    expect(waiting.getByText("未安装")).toBeInTheDocument();
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
          { agentId: "codex", tags: ["Pro"], cost: "low" },
        ],
      },
    });
    const { dialog } = await openSettings();

    const codexRoute = within(dialog).getByRole("option", { name: /Codex · Agent 默认/ });
    expect(codexRoute).toBeDisabled();
    expect(codexRoute).toHaveAttribute("title", "会话进行中，本轮结束后才能切换 Agent");
    expect(within(dialog).getByRole("option", { name: /Genet · DeepSeek/ })).toBeEnabled();
  });

  it("offers every Agent again once the turn has finished", async () => {
    controls({
      busy: false,
      preferences: {
        ...PREFERENCES,
        modelProfiles: [
          ...PREFERENCES.modelProfiles!,
          { agentId: "codex", tags: ["Pro"], cost: "low" },
        ],
      },
    });
    const { dialog } = await openSettings();

    expect(within(dialog).getByRole("option", { name: /Codex · Agent 默认/ })).toBeEnabled();
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

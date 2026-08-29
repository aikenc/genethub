import type { AgentInfo } from "@genehub/proto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComposerControls } from "./ComposerControls";
import { resolveRuntimeSelection } from "./runtime-selection";

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
      setModel: true,
      setEffort: true,
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
    onRefreshAgents: vi.fn(),
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
    expect(screen.getByText("中")).toHaveAttribute("aria-hidden");
  });

  it.each([
    ["low", "低"],
    ["medium", "中"],
    ["high", "高"],
  ])("names the %s thinking level beside its dial", (effortId, label) => {
    controls({ effortId });
    expect(screen.getByText(label)).toHaveAttribute("aria-hidden");
    expect(
      screen.getByRole("button", { name: new RegExp(`思考强度：${label}`) }),
    ).toBeInTheDocument();
  });

  it("keeps a responsive Agent glyph in the runtime row", () => {
    controls({ agentId: "claude" });
    expect(screen.getByText("✱")).toHaveClass("text-[18px]", "md:text-[14px]", "leading-none");
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
    expect(within(dialog).getByRole("radio", { name: /DeepSeek V4 Long/ })).toBeChecked();

    await userEvent.click(within(dialog).getByRole("button", { name: "关闭运行设置" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens on the current Agent's tab and rings visually hidden radios on focus", async () => {
    controls();
    const { dialog } = await openSettings();
    const agent = within(dialog).getByRole("tab", { name: "GeneHub Agent" });
    const effort = within(dialog).getByRole("radio", { name: /高/ });
    await waitFor(() => expect(agent).toHaveFocus());
    expect(agent).toHaveAttribute("aria-selected", "true");
    expect(effort.closest("label")).toHaveClass("has-[:focus-visible]:outline-2");
  });

  it("locks only the Agent choice once a conversation has history", async () => {
    controls({ agentLocked: true });
    const { dialog } = await openSettings();
    expect(within(dialog).getByText(/当前会话已有内容/)).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "GeneHub Agent" })).toBeDisabled();
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

    const bound = within(dialog).getByRole("tab", { name: "GeneHub Agent 不可用：请先登录" });
    expect(bound).toHaveAttribute("aria-selected", "true");
    expect(bound).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("tab", { name: "Codex" }));
    expect(onPickAgent).toHaveBeenCalledWith("codex");
  });

  it("keeps a removed custom Agent as an unavailable tombstone", async () => {
    controls({ agents: [AGENTS[0]!], agentId: "acp:retired" });
    const { dialog } = await openSettings(
      /Agent：acp:retired（不可用：已从当前 Agent 配置中移除）/,
    );
    expect(
      within(dialog).getByRole("tab", {
        name: "acp:retired 不可用：已从当前 Agent 配置中移除",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tab", { name: "GeneHub Agent" })).toBeEnabled();
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

  it("renders Agent-declared Fast as a generic multi-level axis", async () => {
    const cursor: AgentInfo = {
      ...AGENTS[0]!,
      id: "cursor",
      label: "Cursor",
      catalog: {
        ...AGENTS[0]!.catalog,
        runtimeAxes: [
          {
            id: "fast",
            label: "Fast",
            values: [
              { id: "standard", label: "标准" },
              { id: "fast", label: "快速" },
              { id: "max", label: "极速" },
            ],
            defaultValue: "standard",
          },
        ],
      },
    };
    const onPickRuntimeAxis = vi.fn();
    controls({
      agents: [cursor],
      agentId: "cursor",
      runtimeValues: { fast: "fast" },
      onPickRuntimeAxis,
    });
    expect(screen.getByRole("button", { name: /Fast：快速/ })).toBeInTheDocument();
    const { dialog } = await openSettings(/Agent：Cursor/);
    expect(within(dialog).getByRole("radio", { name: "快速" })).toBeChecked();

    await userEvent.click(within(dialog).getByRole("radio", { name: "极速" }));
    expect(onPickRuntimeAxis).toHaveBeenCalledWith("fast", "max");
  });

  /**
   * The permission axis is three short chips on one line. Each one's sentence
   * of explanation is a click away rather than printed underneath, which is
   * what made three choices take a third of the panel.
   */
  it("keeps permission descriptions one click away and maps unrestricted access to an unlock badge", async () => {
    const onPickMode = vi.fn();
    controls({ agentId: "claude", onPickMode });
    expect(screen.getByRole("button", { name: /权限：执行前确认/ })).toBeInTheDocument();
    const { dialog } = await openSettings(/Agent：Claude Code/);
    expect(within(dialog).queryByText("Run without asking")).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Bypass 说明" }));
    expect(within(dialog).getByText("Run without asking")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("radio", { name: /Bypass/ }));
    expect(onPickMode).toHaveBeenCalledWith("bypassPermissions");
  });

  it("calls Cursor's agent/plan/ask axis a mode instead of a permission policy", async () => {
    const cursor: AgentInfo = {
      ...AGENTS[1]!,
      id: "cursor",
      label: "Cursor",
      capabilities: {
        ...AGENTS[1]!.capabilities,
        setEffort: false,
      },
      catalog: {
        ...AGENTS[1]!.catalog,
        modes: [
          { id: "agent", label: "Agent", description: "Work autonomously" },
          { id: "plan", label: "Plan", description: "Plan before editing" },
        ],
        defaultMode: "agent",
      },
    };
    controls({ agents: [cursor], agentId: "cursor" });
    expect(screen.getByRole("button", { name: /模式：Agent/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /权限：Agent/ })).not.toBeInTheDocument();
    const { dialog } = await openSettings(/Agent：Cursor/);
    expect(within(dialog).getByText("模式")).toBeInTheDocument();
    expect(within(dialog).getAllByText("⚙️")).toHaveLength(2);
  });

  /**
   * Daemon configuration order puts an uninstalled Agent wherever it happens to
   * be declared, which used to be the row's first position — where a reader
   * looks first for something they can actually pick.
   */
  it("offers the startable Agents first and folds the rest behind one button", async () => {
    const variants: AgentInfo[] = [
      AGENTS[0]!,
      { ...AGENTS[0]!, id: "opencode", label: "OpenCode", probe: { state: "notInstalled" } },
      AGENTS[1]!,
      { ...AGENTS[1]!, id: "codex", label: "Codex" },
      { ...AGENTS[1]!, id: "cursor", label: "Cursor" },
      { ...AGENTS[1]!, id: "acp", label: "ACP agent", probe: { state: "notInstalled" } },
    ];
    controls({ agents: variants });
    const { dialog } = await openSettings();
    const labels = () =>
      within(dialog)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label"));
    expect(labels()).toEqual(["GeneHub Agent", "Claude Code", "Codex", "Cursor"]);

    await userEvent.click(within(dialog).getByRole("button", { name: "更多 2" }));
    expect(labels()).toEqual([
      "GeneHub Agent",
      "Claude Code",
      "Codex",
      "Cursor",
      "OpenCode 未安装",
      "ACP agent 未安装",
    ]);
    expect(within(dialog).getByRole("tab", { name: "OpenCode 未安装" })).toBeDisabled();
    expect(within(dialog).getByRole("tab", { name: "ACP agent 未安装" })).toBeDisabled();
    expect(within(dialog).getAllByText("未安装")).toHaveLength(2);

    await userEvent.click(within(dialog).getByRole("button", { name: "收起" }));
    expect(labels()).toHaveLength(4);
  });

  it("re-probes when the picker opens and when 重新检测 is pressed", async () => {
    const onRefreshAgents = vi.fn();
    const variants: AgentInfo[] = [
      AGENTS[0]!,
      { ...AGENTS[0]!, id: "cursor", label: "Cursor", probe: { state: "notInstalled" } },
    ];
    controls({ agents: variants, onRefreshAgents });
    expect(onRefreshAgents).not.toHaveBeenCalled();
    const { dialog } = await openSettings();
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: "重新检测" })).toBeInTheDocument();
    expect(within(dialog).getByText("未安装")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "重新检测" }));
    expect(onRefreshAgents).toHaveBeenCalledTimes(2);
  });

  /** A tab with no bundled brand mark still needs somewhere to look. */
  it("gives an Agent without a bundled icon its initial instead of a gap", async () => {
    controls({ agents: [{ ...AGENTS[1]!, id: "codex", label: "Codex" }], agentId: "codex" });
    const { dialog } = await openSettings(/Agent：Codex/);
    expect(within(dialog).getByRole("tab", { name: "Codex" })).toHaveTextContent("CCodex");
  });

  it("folds a long model catalog down to four rows, keeping the chosen one", async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      id: `provider/model-${index}`,
      label: `Model ${index}`,
      reasoning: false,
      efforts: [],
    }));
    const agents = [
      { ...AGENTS[0]!, catalog: { ...AGENTS[0]!.catalog, models: many, defaultModel: many[6]!.id } },
    ];
    controls({ agents, modelId: "provider/model-6" });
    const { dialog } = await openSettings(/模型：Model 6/);

    const shown = () =>
      within(dialog)
        .getAllByRole("radio", { name: /^Model / })
        .map((radio) => radio.getAttribute("value"));
    expect(shown()).toEqual([
      "provider/model-0",
      "provider/model-1",
      "provider/model-2",
      "provider/model-6",
    ]);

    await userEvent.click(within(dialog).getByRole("button", { name: "更多 3" }));
    expect(shown()).toHaveLength(7);
    await userEvent.click(within(dialog).getByRole("button", { name: "收起" }));
    expect(shown()).toHaveLength(4);
  });

  it("marks a model's reasoning and vision on the row rather than under it", async () => {
    const agents = [
      {
        ...AGENTS[0]!,
        catalog: {
          ...AGENTS[0]!.catalog,
          models: [
            { id: "anthropic/sonnet-4", label: "Sonnet 4", reasoning: true, efforts: [] },
            { id: "deepseek/v4-chat", label: "DeepSeek V4 Chat", reasoning: false, efforts: [] },
          ],
          defaultModel: "anthropic/sonnet-4",
        },
      },
    ];
    controls({ agents });
    const { dialog } = await openSettings(/模型：Sonnet 4/);
    expect(
      within(dialog).getByRole("radio", { name: "Sonnet 4 推理 多模态" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "DeepSeek V4 Chat" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/上下文/)).not.toBeInTheDocument();
  });

  it("explains an empty ready catalog instead of looking unfinished", async () => {
    const cursor: AgentInfo = {
      ...AGENTS[1]!,
      id: "cursor",
      label: "Cursor",
      catalog: {
        models: [],
        modes: [],
        commands: [],
        defaultModel: undefined,
        defaultMode: undefined,
        defaultEffort: undefined,
      },
    };
    controls({ agents: [cursor], agentId: "cursor" });
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    const { dialog } = await openSettings(/Agent：Cursor/);
    expect(within(dialog).getByText(/将使用它自身的默认配置/)).toBeInTheDocument();
  });

  it("marks Genet as needing model setup when its required catalog is empty", async () => {
    const genet: AgentInfo = {
      ...AGENTS[0]!,
      catalog: {
        models: [],
        modes: [],
        commands: [],
        defaultModel: undefined,
        defaultMode: undefined,
        defaultEffort: "medium",
      },
    };
    controls({ agents: [genet] });
    const { dialog } = await openSettings(/Agent：GeneHub Agent（待配置：请先配置模型服务）/);
    expect(
      within(dialog).getByRole("tab", {
        name: "GeneHub Agent 待配置：请先配置模型服务",
      }),
    ).toBeDisabled();
    expect(within(dialog).getByText(/当前没有可用模型/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/自身的默认配置/)).not.toBeInTheDocument();
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

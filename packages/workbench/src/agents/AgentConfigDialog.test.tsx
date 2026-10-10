import type { AgentInfo, ProviderInfo, Reply, Request } from "@genehub/proto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { Client } from "../protocol/client";
import { SettingsPanel } from "../settings/SettingsPanel";
import { browserHost } from "../host";
import { PROVIDERS_TARGET, useWorkbench } from "../session/store";
import { AgentConfigDialog } from "./AgentConfigDialog";
import { AgentConfigEntry } from "./AgentConfigEntry";
import { agentConfigSummary, agentStatus, groupAgentActions, isDestructiveAction } from "./agentConfig";

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    label: id,
    builtin: false,
    source: "builtin",
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: true,
      setEffort: false,
      setMode: false,
      permissions: false,
      resume: true,
      fork: false,
      attachments: true,
    },
    catalog: { models: [{ id: "m1", label: "M1" }], modes: [], commands: [] },
    ...extra,
  } as AgentInfo;
}

const READY = agent("codex", { label: "Codex", actions: [{ id: "logout", label: "退出登录", primary: false, group: "account" }] });
const NEEDS_LOGIN = agent("claude", {
  label: "Claude Code",
  probe: { state: "unavailable", reason: "找到了 Claude Code，但它还没登录" },
  message: "找到了 Claude Code，但它还没登录：点「登录」，或者用 API Key 登录。",
  actions: [
    { id: "login", label: "登录", primary: true, group: "account" },
    { id: "login-api-key", label: "用 API Key 登录", primary: false, group: "account" },
  ],
});
const NOT_INSTALLED = agent("codebuddy", {
  label: "CodeBuddy",
  probe: { state: "notInstalled" },
  message: "未安装 CodeBuddy",
  actions: [{ id: "install", label: "安装", primary: true, group: "install" }],
});

/** What the daemon ships an address for (`settings.presets`). */
const SHIPPED = [
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", dialect: "openai" },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", dialect: "openai" },
  { id: "qwen", label: "千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", dialect: "openai" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", dialect: "openai" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", dialect: "openai" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", dialect: "anthropic" },
];

function stub(providers: ProviderInfo[] = []) {
  const calls: Request[] = [];
  const client = {
    identity: { machineId: "m_test" },
    onStateChange: () => () => {},
    onNotice: () => () => {},
    onUpdateDownload: () => () => {},
    onBackgroundProcesses: () => () => {},
    onAgents: () => () => {},
    onAgentRequest: () => () => {},
    onAgentRequestClosed: () => () => {},
    call: async (request: Request): Promise<Reply | undefined> => {
      calls.push(request);
      if (request.type === "settings.get") {
        return { type: "settings", data: { lanEnabled: false, presets: SHIPPED, providers } } as Reply;
      }
      return undefined;
    },
  } as unknown as Client;
  return { client, calls };
}

function provider(over: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return {
    hasApiKey: true,
    label: over.id,
    dialect: "openai",
    custom: false,
    models: [],
    modelInputs: {},
    ...over,
  } as ProviderInfo;
}

function open(agents: AgentInfo[], target?: string | null, providers: ProviderInfo[] = []) {
  const { client, calls } = stub(providers);
  useWorkbench.setState({ client, agents, settings: null, agentConfig: null });
  useWorkbench.getState().openAgentConfig(target);
  render(<AgentConfigDialog />);
  return calls;
}

beforeEach(() => {
  useWorkbench.setState({ client: null, agents: [], settings: null, agentConfig: null });
});

describe("the 模型与 Agent dialog", () => {
  it("is a model list: usable Agents' models first, what cannot be used yet below, no cards", async () => {
    open([NOT_INSTALLED, NEEDS_LOGIN, READY]);
    const dialog = screen.getByRole("dialog", { name: "模型与 Agent" });

    // The usable Agent is a heading with its models, and the way into its window.
    expect(within(dialog).getByRole("button", { name: "配置 Codex" })).toBeInTheDocument();
    const waiting = within(within(dialog).getByRole("region", { name: "还不能用的 Agent" })).getAllByRole("listitem");
    expect(waiting.map((row) => row.getAttribute("data-agent-id"))).toEqual(["codebuddy", "claude"]); // as the machine listed them
    expect(within(waiting[0]!).getByText("未安装")).toBeInTheDocument();
    expect(within(waiting[1]!).getByText("需要登录")).toBeInTheDocument();
    // The Agent's own buttons are one window down, not on the list.
    expect(within(dialog).queryByRole("button", { name: "Claude Code 登录" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Codex 退出登录" })).toBeNull();
  });

  it("says what to do when no model can be used yet", async () => {
    open([NEEDS_LOGIN]);
    expect(screen.getByText("还没有可用的模型。登录或安装下面的 Agent，或者添加一个模型 provider。")).toBeInTheDocument();
  });

  it("opens an Agent's window with the buttons it declared and runs them on the daemon", async () => {
    const calls = open([NEEDS_LOGIN]);
    await userEvent.click(screen.getByRole("button", { name: "配置 Claude Code" }));
    const window = screen.getByRole("dialog", { name: "Claude Code" });
    expect(within(window).getByText("需要登录")).toBeInTheDocument();

    await userEvent.click(within(window).getByRole("button", { name: "Claude Code 登录" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        type: "agent.action",
        payload: { agentId: "claude", actionId: "login" },
      }),
    );
    // The API-key door is next to it, not hidden behind a terminal.
    expect(within(window).getByRole("button", { name: "Claude Code 用 API Key 登录" })).toBeInTheDocument();
  });

  it("asks before logging out and does nothing when declined", async () => {
    const calls = open([READY]);
    await userEvent.click(screen.getByRole("button", { name: "配置 Codex" }));
    await userEvent.click(screen.getByRole("button", { name: "Codex 退出登录" }));

    expect(screen.getByText("确认退出？")).toBeInTheDocument();
    expect(calls.some((call) => call.type === "agent.action")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Codex 取消退出登录" }));
    expect(screen.queryByText("确认退出？")).toBeNull();
    expect(calls.some((call) => call.type === "agent.action")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Codex 退出登录" }));
    await userEvent.click(screen.getByRole("button", { name: "Codex 确认退出登录" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ type: "agent.action", payload: { agentId: "codex", actionId: "logout" } }),
    );
  });

  it("keeps the own-space choice folded under 高级 and leaves the confirmation to the Agent", async () => {
    const calls = open([
      agent("claude", {
        label: "Claude Code",
        actions: [
          { id: "logout", label: "退出登录", primary: false, group: "account" },
          { id: "space-own", label: "使用独立空间", primary: false, group: "advanced" },
        ],
      }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "配置 Claude Code" }));
    const window = screen.getByRole("dialog", { name: "Claude Code" });
    const advanced = within(window).getByText("高级").closest("details")!;
    expect(advanced).not.toHaveAttribute("open");
    expect(advanced).toContainElement(within(window).getByRole("button", { name: "Claude Code 使用独立空间", hidden: true }));

    advanced.setAttribute("open", "");
    await userEvent.click(within(window).getByRole("button", { name: "Claude Code 使用独立空间" }));
    // No second confirmation here: the Agent asks, in its own card, what the switch does.
    await waitFor(() =>
      expect(calls).toContainEqual({ type: "agent.action", payload: { agentId: "claude", actionId: "space-own" } }),
    );
  });

  it("does not call a key green that nobody could check", () => {
    const unchecked = { ...READY, statusLabel: "可用（Key 未核对）" };
    expect(agentStatus(unchecked)).toEqual({ kind: "ready", label: "可用（Key 未核对）" });
    expect(agentStatus(READY).label).toBe("可用");
  });

  it("re-checks the machine when it opens, and again on request", async () => {
    const calls = open([READY]);
    await waitFor(() => expect(calls.filter((call) => call.type === "agent.refresh")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "重新检查所有 Agent" }));
    await waitFor(() => expect(calls.filter((call) => call.type === "agent.refresh")).toHaveLength(2));
  });

  it("opens straight into the providers window when asked to", () => {
    open([READY], PROVIDERS_TARGET);
    expect(screen.getByRole("dialog", { name: "模型 provider" })).toBeInTheDocument();
  });

  it("opens straight into an Agent's window when asked to", () => {
    open([READY], "codex");
    expect(screen.getByRole("dialog", { name: "Codex" })).toBeInTheDocument();
  });

  it("closes the window on Escape first, then the list, and returns to the list on ×", async () => {
    open([]);
    await userEvent.click(screen.getByRole("button", { name: "添加 provider" }));
    expect(screen.getByRole("dialog", { name: "模型 provider" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭模型 provider" }));
    expect(screen.queryByRole("dialog", { name: "模型 provider" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "添加 provider" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "模型 provider" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "模型与 Agent" })).toBeNull();

    useWorkbench.getState().openAgentConfig();
    expect(await screen.findByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭模型与 Agent" }));
    expect(screen.queryByRole("dialog", { name: "模型与 Agent" })).toBeNull();
  });

  it("does not take focus away from a box someone is already typing in", async () => {
    open([READY], PROVIDERS_TARGET);
    const field = await screen.findByLabelText("provider API Key");
    field.focus();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(field).toHaveFocus();
  });
});

describe("model providers", () => {
  it("lists only the providers that are set up", async () => {
    open([READY], PROVIDERS_TARGET, [
      provider({ id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"] }),
      // A shipped provider whose key was cleared is not "set up".
      provider({ id: "kimi", label: "Kimi", hasApiKey: false }),
      provider({ id: "inhouse", label: "公司网关", custom: true, hasApiKey: false }),
    ]);
    const list = await screen.findByRole("list", { name: "已配置的 provider" });
    expect(within(list).getAllByRole("listitem").map((row) => row.getAttribute("data-provider-id"))).toEqual([
      "deepseek",
      "inhouse",
    ]);
    expect(screen.queryByLabelText("OpenAI API Key")).toBeNull();
  });

  it("offers the shipped providers only under 添加 provider, where they fill in the form", async () => {
    const calls = open([READY], PROVIDERS_TARGET, [provider({ id: "deepseek", label: "DeepSeek" })]);
    await userEvent.click(await screen.findByRole("button", { name: "添加 provider" }));
    const form = screen.getByRole("group", { name: "添加 provider" });

    const choices = within(form).getAllByRole("radio").map((radio) => radio.textContent);
    // DeepSeek is already set up; everything else we ship is on offer, then 自定义.
    expect(choices).toEqual(["Kimi", "MiniMax", "千问", "OpenAI", "Anthropic", "自定义"]);

    await userEvent.click(within(form).getByRole("radio", { name: "Anthropic" }));
    expect(within(form).getByLabelText("provider id")).toHaveValue("anthropic");
    expect(within(form).getByLabelText("provider 接口地址")).toHaveValue("https://api.anthropic.com");
    expect(within(form).getByLabelText("接口协议")).toHaveValue("anthropic");

    // Nothing to save without a key: a shipped provider with none would not even be listed.
    expect(within(form).getByTestId("add-provider")).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("provider API Key"), "sk-ant-1");
    await userEvent.click(within(form).getByTestId("add-provider"));
    await waitFor(() =>
      expect(calls.find((call) => call.type === "settings.setProvider")?.payload).toMatchObject({
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com",
        dialect: "anthropic",
        apiKey: "sk-ant-1",
      }),
    );
  });

  it("removes a custom provider, and only empties the key of a shipped one, after asking", async () => {
    const calls = open([READY], PROVIDERS_TARGET, [
      provider({ id: "deepseek", label: "DeepSeek" }),
      provider({ id: "inhouse", label: "公司网关", custom: true }),
    ]);
    await userEvent.click(await screen.findByRole("button", { name: "移除 DeepSeek" }));
    await userEvent.click(screen.getByRole("button", { name: "取消移除 DeepSeek" }));
    expect(calls.some((call) => call.type === "settings.setProvider" || call.type === "settings.forgetProvider")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "移除 DeepSeek" }));
    await userEvent.click(screen.getByRole("button", { name: "确认移除 DeepSeek" }));
    await waitFor(() =>
      expect(calls.find((call) => call.type === "settings.setProvider")?.payload).toMatchObject({
        providerId: "deepseek",
        apiKey: "",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "移除 公司网关" }));
    await userEvent.click(screen.getByRole("button", { name: "确认移除 公司网关" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ type: "settings.forgetProvider", payload: { providerId: "inhouse" } }),
    );
  });
});

describe("the two doors into 模型与 Agent", () => {
  it("system settings has one row that opens the same dialog", async () => {
    const { client } = stub();
    useWorkbench.setState({ client, agents: [READY, NEEDS_LOGIN], settings: null, agentConfig: null });
    render(
      <>
        <SettingsPanel host={browserHost()} />
        <AgentConfigDialog />
      </>,
    );

    const doors = screen.getAllByRole("button", { name: "模型与 Agent" });
    expect(doors).toHaveLength(1);
    expect(doors[0]).toHaveTextContent("1 个可用 · 1 个需要登录");
    // Nothing of the old per-Agent or key forms is left on the settings page.
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();

    await userEvent.click(doors[0]!);
    expect(await screen.findByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();
  });

  it("the link variant opens it too", async () => {
    useWorkbench.setState({ agents: [READY], agentConfig: null });
    render(
      <>
        <AgentConfigEntry variant="link" />
        <AgentConfigDialog />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "模型与 Agent" }));
    expect(await screen.findByRole("dialog", { name: "模型与 Agent" })).toBeInTheDocument();
  });
});

describe("模型与 Agent presentation rules", () => {
  it("never names a terminal: an install or login problem only ever offers buttons", () => {
    for (const entry of [NEEDS_LOGIN, NOT_INSTALLED]) {
      const text = `${entry.message ?? ""} ${(entry.actions ?? []).map((action) => action.label).join(" ")}`;
      expect(text).not.toMatch(/终端|命令行|命令提示符|terminal|shell|powershell|\bcmd\b/i);
    }
  });

  it("classifies and groups by what the Agent says, without knowing its name", () => {
    expect(agentStatus(READY).kind).toBe("ready");
    expect(agentStatus(NEEDS_LOGIN).kind).toBe("needsLogin");
    expect(agentStatus(NOT_INSTALLED).kind).toBe("notInstalled");
    expect(agentStatus({ ...READY, job: { id: "j", action: "login", done: false } as never }).kind).toBe("busy");
    expect(agentConfigSummary([])).toBe("还没有可配置的 Agent");
    expect(agentConfigSummary([READY, NEEDS_LOGIN, NOT_INSTALLED])).toBe("1 个可用 · 1 个需要登录 · 1 个需要处理");

    const groups = groupAgentActions([
      { id: "space-own", label: "使用独立空间", primary: false, group: "advanced" },
      { id: "update", label: "更新", primary: false, group: "install" },
      { id: "login-api-key", label: "用 API Key 登录", primary: false, group: "account" },
      { id: "login", label: "登录", primary: true, group: "account" },
      { id: "mystery", label: "别的", primary: false },
      { id: "elsewhere", label: "另一处", primary: false, group: "not-a-group" },
    ]);
    expect(groups.map((group) => [group.id, group.actions.map((action) => action.id)])).toEqual([
      ["account", ["login", "login-api-key"]],
      ["install", ["update"]],
      ["other", ["mystery", "elsewhere"]],
      ["advanced", ["space-own"]],
    ]);
    // The group, not the name, decides: an Agent's own words for signing in work.
    const SIGN_IN = { ...NEEDS_LOGIN, actions: [{ id: "enter-with-account", label: "用账号进入", primary: true, group: "account" }] };
    expect(agentStatus(SIGN_IN).kind).toBe("needsLogin");
    expect(agentStatus({ ...READY, statusLabel: "可用（连着自选 provider）" }).label).toBe("可用（连着自选 provider）");
    expect(isDestructiveAction({ id: "logout", label: "退出登录" })).toBe(true);
    expect(isDestructiveAction({ id: "login", label: "登录" })).toBe(false);
  });
});

import type { AgentInfo, Reply, Request } from "@genehub/proto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { Client } from "../protocol/client";
import { SettingsPanel } from "../settings/SettingsPanel";
import { browserHost } from "../host";
import { useWorkbench } from "../session/store";
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

const READY = agent("codex", { label: "Codex", actions: [{ id: "logout", label: "退出登录", primary: false }] });
const NEEDS_LOGIN = agent("claude", {
  label: "Claude Code",
  probe: { state: "unavailable", reason: "找到了 Claude Code，但它还没登录" },
  message: "找到了 Claude Code，但它还没登录：点「登录」，或者用 API Key 登录。",
  actions: [
    { id: "login", label: "登录", primary: true },
    { id: "login-api-key", label: "用 API Key 登录", primary: false },
  ],
});
const NOT_INSTALLED = agent("codebuddy", {
  label: "CodeBuddy",
  probe: { state: "notInstalled" },
  message: "未安装 CodeBuddy",
  actions: [{ id: "install", label: "安装", primary: true }],
});

function stub() {
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
        return { type: "settings", data: { lanEnabled: false, providers: [] } } as Reply;
      }
      return undefined;
    },
  } as unknown as Client;
  return { client, calls };
}

function open(agents: AgentInfo[], tab?: "agents" | "models" | "keys") {
  const { client, calls } = stub();
  useWorkbench.setState({ client, agents, settings: null, agentConfig: null });
  useWorkbench.getState().openAgentConfig(tab);
  render(<AgentConfigDialog />);
  return calls;
}

beforeEach(() => {
  useWorkbench.setState({ client: null, agents: [], settings: null, agentConfig: null });
});

describe("the Agent 配置 dialog", () => {
  it("shows one card per Agent, usable ones first, with a text status", async () => {
    open([NOT_INSTALLED, NEEDS_LOGIN, READY]);
    const dialog = screen.getByRole("dialog", { name: "Agent 配置" });
    const cards = within(within(dialog).getByRole("list", { name: "Agent 列表" })).getAllByRole("listitem");

    expect(cards.map((card) => card.getAttribute("data-agent-id"))).toEqual(["codex", "codebuddy", "claude"]); // usable first, the rest as the machine listed them
    expect(within(cards[0]!).getByText("可用")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("未安装")).toBeInTheDocument();
    expect(within(cards[2]!).getByText("需要登录")).toBeInTheDocument();
  });

  it("offers the buttons the Agent declared and runs them on the daemon", async () => {
    const calls = open([NEEDS_LOGIN]);
    await userEvent.click(screen.getByRole("button", { name: "Claude Code 登录" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        type: "agent.action",
        payload: { agentId: "claude", actionId: "login" },
      }),
    );
    // The API-key door is next to it, not hidden behind a terminal.
    expect(screen.getByRole("button", { name: "Claude Code 用 API Key 登录" })).toBeInTheDocument();
  });

  it("asks before logging out and does nothing when declined", async () => {
    const calls = open([READY]);
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

  it("re-checks the machine when it opens, and again on request", async () => {
    const calls = open([READY]);
    await waitFor(() => expect(calls.filter((call) => call.type === "agent.refresh")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "重新检查所有 Agent" }));
    await waitFor(() => expect(calls.filter((call) => call.type === "agent.refresh")).toHaveLength(2));
  });

  it("moves between the three tabs without leaving the dialog", async () => {
    open([READY]);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Agent", "模型与标签", "模型密钥"]);
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("tab", { name: "模型密钥" }));
    expect(screen.getByRole("tab", { name: "模型密钥" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("DeepSeek API Key")).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("tab", { name: "模型与标签" }));
    expect(screen.getByRole("button", { name: "保存到这台机器" })).toBeInTheDocument();

    // Arrow keys move along the tabs too.
    screen.getByRole("tab", { name: "模型与标签" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens on the key tab when asked to", () => {
    open([READY], "keys");
    expect(screen.getByRole("tab", { name: "模型密钥" })).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape and on the close button, and says what to do when there is nothing", async () => {
    open([]);
    expect(screen.getByText("这台机器上还没有可配置的 Agent。")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Agent 配置" })).toBeNull();

    useWorkbench.getState().openAgentConfig();
    expect(await screen.findByRole("dialog", { name: "Agent 配置" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭 Agent 配置" }));
    expect(screen.queryByRole("dialog", { name: "Agent 配置" })).toBeNull();
  });

  it("does not take focus away from a box someone is already typing in", async () => {
    open([READY], "keys");
    const field = await screen.findByLabelText("DeepSeek API Key");
    field.focus();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(field).toHaveFocus();
  });
});

describe("the two doors into Agent 配置", () => {
  it("system settings has one row that opens the same dialog", async () => {
    const { client } = stub();
    useWorkbench.setState({ client, agents: [READY, NEEDS_LOGIN], settings: null, agentConfig: null });
    render(
      <>
        <SettingsPanel host={browserHost()} />
        <AgentConfigDialog />
      </>,
    );

    const doors = screen.getAllByRole("button", { name: "Agent 配置" });
    expect(doors).toHaveLength(1);
    expect(doors[0]).toHaveTextContent("1 个可用 · 1 个需要登录");
    // Nothing of the old per-Agent or key forms is left on the settings page.
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();

    await userEvent.click(doors[0]!);
    expect(await screen.findByRole("dialog", { name: "Agent 配置" })).toBeInTheDocument();
  });

  it("the link variant opens it too", async () => {
    useWorkbench.setState({ agents: [READY], agentConfig: null });
    render(
      <>
        <AgentConfigEntry variant="link" />
        <AgentConfigDialog />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Agent 配置" }));
    expect(await screen.findByRole("dialog", { name: "Agent 配置" })).toBeInTheDocument();
  });
});

describe("Agent 配置 presentation rules", () => {
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
      { id: "update", label: "更新", primary: false },
      { id: "login-api-key", label: "用 API Key 登录", primary: false },
      { id: "login", label: "登录", primary: true },
      { id: "mystery", label: "别的", primary: false },
    ]);
    expect(groups.map((group) => [group.id, group.actions.map((action) => action.id)])).toEqual([
      ["account", ["login", "login-api-key"]],
      ["install", ["update"]],
      ["other", ["mystery"]],
    ]);
    expect(isDestructiveAction({ id: "logout", label: "退出登录" })).toBe(true);
    expect(isDestructiveAction({ id: "login", label: "登录" })).toBe(false);
  });
});

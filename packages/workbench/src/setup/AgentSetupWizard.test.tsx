import type { InstallMethod, Reply, Request } from "@genehub/proto";
import { fireEvent, act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Host } from "../host";
import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";
import { agentFixture } from "../testing/agentFixture";
import { AgentSetupWizard } from "./AgentSetupWizard";

/**
 * The guided setup dialog, tested at the protocol boundary: what it asks the
 * daemon for, and — most importantly — what it never does. Commands go into
 * the terminal as a paste, without the enter that would run them.
 */

// xterm needs canvas, which jsdom does not have; the terminal's rendering is
// not what is being tested here, only the bytes that cross to the daemon.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open() {}
    loadAddon() {}
    onData() {}
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubClient(answers: Partial<Record<Request["type"], (payload: never) => Reply>>) {
  const calls: Request[] = [];
  const client = {
    call: async (request: Request) => {
      calls.push(request);
      if (request.type === "pty.open") return { type: "pty", data: { ptyId: "p1" } };
      if (request.type === "pty.write" || request.type === "pty.close" || request.type === "pty.resize") {
        return undefined;
      }
      const answer = answers[request.type];
      if (!answer) return undefined;
      return answer((request as { payload?: never }).payload as never);
    },
    onPty: () => () => {},
  } as unknown as Client;
  return { client, calls };
}

function hostWith(overrides: Partial<Host> = {}): Host {
  return {
    kind: "browser",
    endpoint: async () => ({ url: "ws://127.0.0.1:1/ws", via: "loopback", label: "本机" }),
    notify: () => {},
    openExternal: vi.fn(),
    ...overrides,
  };
}

const CLAUDE_INSTALL: InstallMethod = {
  label: "官方脚本",
  platforms: ["macos", "linux"],
  command: "curl -fsSL https://claude.ai/install.sh | bash",
};

const UNINSTALLED_CLAUDE = agentFixture({
  id: "claude",
  label: "Claude Code",
  probe: { state: "notInstalled" },
  auth: "unknown",
  version: undefined,
  setup: {
    install: [
      CLAUDE_INSTALL,
      {
        label: "Windows CMD",
        platforms: ["windows"],
        command: "curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd",
      },
    ],
    login: { command: "claude auth login", opensBrowser: true, hint: "在浏览器里完成授权。" },
    docsUrl: "https://code.claude.com/docs/en/setup",
  },
});

const SIGNED_OUT_CLAUDE = agentFixture({
  id: "claude",
  label: "Claude Code",
  auth: "unauthenticated",
  version: "2.0.0",
  setup: {
    install: [CLAUDE_INSTALL],
    login: { command: "claude auth login", opensBrowser: true, hint: "在浏览器里完成授权。" },
    docsUrl: "https://code.claude.com/docs/en/setup",
  },
});

const READY_CLAUDE = agentFixture({
  id: "claude",
  label: "Claude Code",
  auth: "authenticated",
  catalog: {
    models: [{ id: "claude-sonnet-5", label: "Sonnet", reasoning: true, efforts: [] }],
    modes: [],
    commands: [],
    defaultModel: "claude-sonnet-5",
    defaultMode: undefined,
  },
  setup: { install: [CLAUDE_INSTALL] },
});

/** Opens the wizard on `agent` against the stubbed daemon. */
function openWizard(agent: ReturnType<typeof agentFixture>, client: Client, host: Host) {
  useWorkbench.setState({
    agents: [agent],
    client,
    workspaces: [{ id: "w1", name: "app", root: "/home/me/app", isGitRepo: true, folders: [] }],
    activeWorkspaceId: "w1",
    setupAgentId: agent.id,
  });
  return render(<AgentSetupWizard host={host} />);
}

/** The bytes the guide put into the terminal, in order. */
function pastes(calls: Request[]): string[] {
  return calls
    .filter((call) => call.type === "pty.write")
    .map((call) => (call.payload as { data: string }).data);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  useWorkbench.setState({
    client: null,
    workspaces: [],
    activeWorkspaceId: null,
    sessions: [],
    activeSessionId: null,
    draft: null,
    tabs: [],
    activeTabId: null,
    rightPanel: null,
    agents: [],
    settings: null,
    notice: null,
    setupAgentId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the agent setup wizard", () => {
  it("offers only the install commands that run on this machine", async () => {
    const { client } = stubClient({});
    openWizard(UNINSTALLED_CLAUDE, client, hostWith());

    expect(await screen.findByTestId("setup-step-install")).toBeInTheDocument();
    expect(screen.getByText(CLAUDE_INSTALL.command)).toBeInTheDocument();
    // The Windows path exists in the guide but not on a Linux machine.
    expect(screen.queryByText(/install\.cmd/)).not.toBeInTheDocument();
    // Not installed yet, so there is no sign-in badge to show.
    expect(screen.queryByTestId("setup-auth-badge")).not.toBeInTheDocument();
  });

  it("pastes the chosen command into a machine-wide terminal, and never presses enter", async () => {
    const { client, calls } = stubClient({});
    openWizard(UNINSTALLED_CLAUDE, client, hostWith());

    await userEvent.click(await screen.findByTestId("run-install-官方脚本"));

    // A shell outside any project: installing an agent is machine business.
    // The workspace field is absent from the wire, not nulled.
    await waitFor(() => {
      const opened = calls.find((call) => call.type === "pty.open");
      expect(opened?.payload).not.toHaveProperty("workspaceId");
    });
    await waitFor(() => expect(pastes(calls)).toEqual([CLAUDE_INSTALL.command]));
    // The paste ends exactly where the command ends; running it is the user's
    // enter key, not ours.
    for (const data of pastes(calls)) {
      expect(data.endsWith("\r")).toBe(false);
      expect(data.endsWith("\n")).toBe(false);
    }
  });

  it("says an installed agent is signed out and starts from its own login flow", async () => {
    const { client, calls } = stubClient({});
    openWizard(SIGNED_OUT_CLAUDE, client, hostWith());

    expect(await screen.findByTestId("setup-step-credentials")).toBeInTheDocument();
    expect(screen.getByTestId("setup-auth-badge")).toHaveTextContent("未认证");

    await userEvent.click(screen.getByTestId("setup-login-run"));
    await waitFor(() => expect(pastes(calls)).toEqual(["claude auth login"]));
  });

  it("hands the built-in agent its provider key, write-only, then re-probes", async () => {
    const builtin = agentFixture({
      id: "genet",
      label: "GeneHub Agent",
      builtin: true,
      auth: "notApplicable",
      catalog: { models: [], modes: [], commands: [] },
      setup: {
        install: [],
        apiKey: { kind: "builtinProvider", envVars: [], hint: "密钥只保存在这台机器上。" },
      },
    });
    const { client, calls } = stubClient({
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
      "settings.setProvider": () => ({
        type: "settings",
        data: {
          lanEnabled: false,
          providers: [
            {
              id: "deepseek",
              label: "DeepSeek",
              hasApiKey: true,
              baseUrl: "https://api.deepseek.com/v1",
              dialect: "openai",
              custom: false,
              models: ["deepseek-v4-flash"],
            },
          ],
        },
      }),
      "agent.refresh": () => ({ type: "agents", data: [builtin] }),
    });
    openWizard(builtin, client, hostWith());

    expect(await screen.findByTestId("setup-step-credentials")).toBeInTheDocument();
    // fireEvent.change, not userEvent.type: click-to-focus on a portal
    // input is flaky under jsdom, and the controlled onChange is the path
    // being tested.
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    await userEvent.click(screen.getByTestId("setup-save-key"));

    await waitFor(() => {
      const saved = calls.find((call) => call.type === "settings.setProvider");
      expect(saved?.payload).toMatchObject({ providerId: "deepseek", apiKey: "sk-test" });
    });
    expect(calls.some((call) => call.type === "agent.refresh")).toBe(true);
  });

  it("writes environment-variable commands in the platform's own syntax", async () => {
    const envAgent = agentFixture({
      id: "claude",
      label: "Claude Code",
      platform: "windows",
      auth: "unknown",
      setup: {
        install: [CLAUDE_INSTALL],
        apiKey: {
          kind: "environment",
          envVars: [{ name: "ANTHROPIC_API_KEY", purpose: "平台申请的密钥" }],
          keyUrl: "https://platform.claude.com/",
          hint: "只有环境变量这条路时用它。",
        },
      },
    });
    const retry = vi.fn(async () => {});
    const { client, calls } = stubClient({});
    openWizard(envAgent, client, hostWith({ retry }));

    expect(await screen.findByTestId("setup-step-credentials")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("setup-env-ANTHROPIC_API_KEY"));
    await waitFor(() => expect(pastes(calls)).toEqual(['setx ANTHROPIC_API_KEY "在此粘贴"']));

    await userEvent.click(screen.getByTestId("setup-restart-daemon"));
    expect(retry).toHaveBeenCalled();
  });

  it("is one click from a conversation once the agent checks out", async () => {
    const { client } = stubClient({});
    openWizard(READY_CLAUDE, client, hostWith());

    expect(await screen.findByTestId("setup-step-ready")).toBeInTheDocument();
    expect(screen.getByTestId("setup-auth-badge")).toHaveTextContent("已认证");

    await userEvent.click(screen.getByTestId("setup-start"));

    expect(useWorkbench.getState().draft).toMatchObject({
      workspaceId: "w1",
      agentId: "claude",
    });
    // Starting is also leaving: the wizard is done.
    expect(useWorkbench.getState().setupAgentId).toBeNull();
  });

  it("keeps asking the machine while it is open — sign-in finishes outside our events", async () => {
    vi.useFakeTimers();
    const { client, calls } = stubClient({
      "agent.refresh": () => ({ type: "agents", data: [SIGNED_OUT_CLAUDE] }),
    });
    openWizard(SIGNED_OUT_CLAUDE, client, hostWith());
    const refreshes = () => calls.filter((call) => call.type === "agent.refresh").length;

    // The refresh call reaches the client synchronously once the timer fires.
    const before = refreshes();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(refreshes()).toBeGreaterThan(before);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refreshes()).toBeGreaterThanOrEqual(before + 2);
  });
});

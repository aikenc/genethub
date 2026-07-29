import type { AgentInfo, Reply, Request } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import type { Host } from "../host";
import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";

/**
 * The first minute after installing.
 *
 * Everything here was reachable through the protocol before and unreachable
 * through the interface: a fresh machine showed a workbench with every control
 * greyed out and no explanation. These cases exist so that cannot come back.
 */

function stubClient(answers: Partial<Record<Request["type"], (payload: never) => Reply>>) {
  const calls: Request[] = [];
  const client = {
    call: async (request: Request) => {
      calls.push(request);
      const answer = answers[request.type];
      if (!answer) return undefined;
      return answer((request as { payload?: never }).payload as never);
    },
    connect: () => {},
    close: () => {},
    subscribe: async () => ({
      snapshot: {
        seq: 0,
        items: [],
        pendingPermission: undefined,
        summary: {
          id: "s1",
          workspaceId: "w1",
          agentId: "genet",
          title: "新会话",
          createdAtMs: 0,
          updatedAtMs: 0,
          archived: false,
          status: "idle",
        },
      },
      replayed: [],
      reset: false,
    }),
    unsubscribe: async () => {},
    onPty: () => () => {},
    onNotice: () => () => {},
    onStateChange: () => () => {},
  } as unknown as Client;
  return { client, calls };
}

const READY_AGENT: AgentInfo = {
  id: "genet",
  label: "GeneHub Agent",
  builtin: true,
  probe: { state: "ready" },
  capabilities: {
    interrupt: true,
    setModel: true,
    setMode: true,
    permissions: true,
    resume: true,
    attachments: false,
  },
  catalog: {
    models: [{ id: "deepseek/deepseek-v4-flash", label: "flash", reasoning: false }],
    modes: [],
    defaultModel: "deepseek/deepseek-v4-flash",
    defaultMode: undefined,
  },
};

const UNCONFIGURED_AGENT: AgentInfo = {
  ...READY_AGENT,
  catalog: { models: [], modes: [], defaultModel: undefined, defaultMode: undefined },
};

function hostWith(overrides: Partial<Host> = {}): Host {
  return {
    kind: "browser",
    endpoint: async () => ({ url: "ws://127.0.0.1:1/ws", via: "loopback", label: "本机" }),
    notify: () => {},
    openExternal: () => {},
    ...overrides,
  };
}

/** Renders the app against a stubbed daemon, with no socket anywhere. */
async function start(client: Client, host: Host) {
  render(<App host={host} connect={() => client} />);
  await waitFor(() => expect(useWorkbench.getState().agents.length).toBeGreaterThan(0));
}

beforeEach(() => {
  useWorkbench.setState({
    client: null,
    workspaces: [],
    activeWorkspaceId: null,
    sessions: [],
    activeSessionId: null,
    agents: [],
    settings: null,
  });
});

describe("the first run", () => {
  it("asks for a project before anything else, and opens the one that is picked", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "workspace.open": () => ({
        type: "workspace",
        data: { id: "w1", name: "app", root: "/home/me/app", isGitRepo: true },
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
    });
    const pickDirectory = vi.fn(async () => "/home/me/app");
    await start(client, hostWith({ pickDirectory }));

    expect(await screen.findByText("先打开一个项目文件夹。")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "打开项目文件夹…" })[0]!);

    await waitFor(() => {
      const opened = calls.find((call) => call.type === "workspace.open");
      expect(opened?.payload).toEqual({ root: "/home/me/app" });
    });
    expect(pickDirectory).toHaveBeenCalled();
  });

  /**
   * A browser is talking to a daemon on another machine, where there is nothing
   * local to browse — so it asks for a path instead of offering a picker.
   */
  it("takes a typed path when the shell has no folder picker", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "workspace.open": () => ({
        type: "workspace",
        data: { id: "w1", name: "app", root: "/srv/app", isGitRepo: false },
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
    });
    await start(client, hostWith());

    const field = await screen.findAllByLabelText("项目路径");
    await userEvent.type(field[0]!, "/srv/app");
    await userEvent.click(screen.getAllByRole("button", { name: "打开" })[0]!);

    await waitFor(() => {
      expect(calls.find((call) => call.type === "workspace.open")?.payload).toEqual({
        root: "/srv/app",
      });
    });
  });

  it("says a directory that is not there is not there, instead of doing nothing", async () => {
    const { client } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.list": () => ({ type: "sessions", data: [] }),
    });
    (client as unknown as { call: (request: Request) => Promise<Reply> }).call = async (
      request,
    ) => {
      if (request.type === "workspace.open") throw new Error("no such directory: /nope");
      if (request.type === "agent.list") return { type: "agents", data: [READY_AGENT] };
      if (request.type === "workspace.list") return { type: "workspaces", data: [] };
      return { type: "hubStatus", data: { state: "unpaired" } };
    };
    await start(client, hostWith());

    await userEvent.type((await screen.findAllByLabelText("项目路径"))[0]!, "/nope");
    await userEvent.click(screen.getAllByRole("button", { name: "打开" })[0]!);

    expect(await screen.findByText(/no such directory/)).toBeInTheDocument();
  });

  /**
   * The agent's catalog is built from the providers that are configured, so an
   * empty one means there is no key — a more truthful signal than reading the
   * settings, because it is the same thing that decides whether a turn can run.
   */
  it("points at the key when a project is open but no model is reachable", async () => {
    const { client } = stubClient({
      "agent.list": () => ({ type: "agents", data: [UNCONFIGURED_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [{ id: "w1", name: "app", root: "/home/me/app", isGitRepo: true }],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "settings.get": () => ({ type: "settings", data: { lanEnabled: false, providers: [] } }),
    });
    await start(client, hostWith());

    expect(await screen.findByText("还差一个模型密钥。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "去填密钥" }));
    expect(await screen.findByLabelText("DeepSeek API Key")).toBeInTheDocument();
  });

  it("offers the session once the project and the key are both there", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [{ id: "w1", name: "app", root: "/home/me/app", isGitRepo: true }],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.create": () => ({
        type: "session",
        data: {
          id: "s1",
          workspaceId: "w1",
          agentId: "genet",
          title: "新会话",
          createdAtMs: 0,
          updatedAtMs: 0,
          archived: false,
          status: "idle",
        },
      }),
    });
    await start(client, hostWith());

    expect(await screen.findByText("app 已就绪。")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);

    await waitFor(() => {
      expect(calls.find((call) => call.type === "session.create")?.payload).toMatchObject({
        workspaceId: "w1",
        agentId: "genet",
      });
    });
  });
});

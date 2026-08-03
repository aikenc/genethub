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
  let onState: ((state: string) => void) | undefined;
  const client = {
    call: async (request: Request) => {
      calls.push(request);
      const answer = answers[request.type];
      if (!answer) return undefined;
      return answer((request as { payload?: never }).payload as never);
    },
    connect: () => {
      // Real sockets fire "ready" after the handshake; do the same so attach
      // has time to register its listener before the state change arrives.
      queueMicrotask(() => onState?.("ready"));
    },
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
    onUpdateDownload: () => () => {},
    onStateChange: (listener: (state: string) => void) => {
      onState = listener;
      return () => {};
    },
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
    setEffort: false,
    permissions: true,
    resume: true,
    fork: false,
    attachments: false,
  },
  catalog: {
    models: [
      { id: "deepseek/deepseek-v4-flash", label: "flash", reasoning: false, efforts: [] },
    ],
    modes: [],
    commands: [],
    defaultModel: "deepseek/deepseek-v4-flash",
    defaultMode: undefined,
  },
};

const UNCONFIGURED_AGENT: AgentInfo = {
  ...READY_AGENT,
  catalog: {
    models: [],
    modes: [],
    commands: [],
    defaultModel: undefined,
    defaultMode: undefined,
  },
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
    draft: null,
    tabs: [],
    activeTabId: null,
    rightPanel: null,
    agents: [],
    settings: null,
    notice: null,
  });
});

describe("the first run", () => {
  it("does not ask for a project while the socket is still coming up", async () => {
    const { client } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    (client as { connect: () => void }).connect = () => {};
    render(<App host={hostWith()} connect={() => client} />);

    expect(await screen.findByText("正在连这台机器…")).toBeInTheDocument();
    expect(screen.queryByText("先打开一个项目文件夹。")).not.toBeInTheDocument();
  });

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
    const { client, calls } = stubClient({
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
    expect(calls.some((call) => call.type === "session.create")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "去填密钥" }));
    expect(await screen.findByLabelText("DeepSeek API Key")).toBeInTheDocument();
  });

  /**
   * The daemon gives a machine that has never been used a folder to work in,
   * so by the time the interface loads the only thing between the user and a
   * first message is a session — and there is no decision in it worth asking
   * about.
   *
   * Landing there costs nothing on the machine: the conversation is a draft
   * until it is used. Every first visit to a project used to leave a stored
   * session behind whether or not anyone ever said anything in it.
   */
  it("goes straight into a conversation once the project and the key are there", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [{ id: "w1", name: "GeneHub", root: "/home/me/GeneHub", isGitRepo: false }],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.create": () => ({ type: "session", data: session("s1", 0) }),
    });
    await start(client, hostWith());

    expect(await screen.findByPlaceholderText(/描述任务/)).toBeInTheDocument();
    expect(screen.queryByText(/已就绪/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(useWorkbench.getState().draft).toMatchObject({
        workspaceId: "w1",
        agentId: "genet",
      }),
    );
    expect(calls.some((call) => call.type === "session.create")).toBe(false);
  });

  it("writes the session once that first message is actually sent", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [{ id: "w1", name: "GeneHub", root: "/home/me/GeneHub", isGitRepo: false }],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.create": () => ({ type: "session", data: session("s1", 0) }),
    });
    await start(client, hostWith());

    await userEvent.type(await screen.findByPlaceholderText(/描述任务/), "在这里改一行{Enter}");

    await waitFor(() => {
      expect(calls.find((call) => call.type === "session.create")?.payload).toMatchObject({
        workspaceId: "w1",
        agentId: "genet",
      });
    });
    expect(calls.find((call) => call.type === "session.send")?.payload).toMatchObject({
      sessionId: "s1",
      text: "在这里改一行",
    });
  });

  /**
   * The daemon leaves a session unnamed until there is something to name it
   * after, so the word on screen is this side's to choose — and it has to be
   * in the same language as everything around it.
   */
  it("names a session nobody has named yet in the interface's own words", async () => {
    const { client } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [{ id: "w1", name: "GeneHub", root: "/home/me/GeneHub", isGitRepo: false }],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.create": () => ({
        type: "session",
        data: { ...session("s1", 0), title: undefined },
      }),
    });
    await start(client, hostWith());

    await waitFor(() => expect(screen.getAllByText("新会话").length).toBeGreaterThan(0));
  });

  /** Reconnecting means continuing, not starting over. */
  it("comes back to the conversation that was last touched", async () => {
    const subscribed: string[] = [];
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [{ id: "w1", name: "app", root: "/home/me/app", isGitRepo: true }],
      }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.list": () => ({
        type: "sessions",
        data: [session("older", 10), session("newest", 99), session("middle", 50)],
      }),
    });
    (client as unknown as { subscribe: (id: string) => Promise<unknown> }).subscribe = async (
      id,
    ) => {
      subscribed.push(id);
      return { snapshot: { seq: 0, items: [], summary: session(id, 0) }, replayed: [], reset: false };
    };
    await start(client, hostWith());

    await waitFor(() => expect(subscribed).toEqual(["newest"]));
    expect(calls.some((call) => call.type === "session.create")).toBe(false);
  });
});

function session(id: string, updatedAtMs: number) {
  return {
    id,
    workspaceId: "w1",
    agentId: "genet",
    title: id,
    createdAtMs: 0,
    updatedAtMs,
    archived: false,
    status: "idle" as const,
  };
}

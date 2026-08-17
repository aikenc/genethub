import type { AgentInfo, Reply, Request, WorkspaceInfo } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

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
    onBackgroundProcesses: () => () => {},
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

function workspace(
  id: string,
  name: string,
  root: string,
  isGitRepo: boolean,
): WorkspaceInfo {
  return {
    id,
    name,
    root,
    isGitRepo,
    folders: [{ name, root, rootHandle: `r_${name}` }],
  };
}

/** Renders the app against a stubbed daemon, with no socket anywhere. */
async function start(client: Client, host: Host) {
  render(<App host={host} connect={() => client} />);
  await waitFor(() => expect(useWorkbench.getState().agents.length).toBeGreaterThan(0));
}

beforeEach(() => {
  localStorage.clear();
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
    expect(screen.queryByText("先打开一个工作区。")).not.toBeInTheDocument();
  });

  /**
   * The paths belong to the remote machine, so its daemon supplies the folders
   * instead of asking the person to remember and type one.
   */
  it("browses and selects a folder on a remote machine", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "workspace.open": () => ({
        type: "workspace",
        data: workspace("w1", "app", "/srv/app", false),
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "directory.list": (payload: { path: string | null }) => ({
        type: "directory",
        data: payload.path
          ? { path: "/srv/app", parent: "/srv", directories: [], workspaceFiles: [], roots: false }
          : {
              path: "/srv",
              parent: "/",
              directories: [{ name: "app", path: "/srv/app" }],
              workspaceFiles: [],
              roots: false,
            },
      }),
    });
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );
    await userEvent.click(await screen.findByRole("button", { name: /app/ }));
    await userEvent.click(screen.getByRole("button", { name: "打开此工作区" }));

    await waitFor(() => {
      expect(calls.find((call) => call.type === "workspace.open")?.payload).toEqual({
        root: "/srv/app",
      });
    });
  });

  it("starts the project browser at the selected workspace before an older remembered path", async () => {
    localStorage.setItem("genehub:project-picker:loopback:本机", "/srv/older");
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [workspace("w1", "current", "/srv/current", false)],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "directory.list": (payload: { path: string | null }) => ({
        type: "directory",
        data: {
          path: payload.path ?? "/home/me",
          parent: "/srv",
          directories: [],
          workspaceFiles: [],
          roots: false,
        },
      }),
    });
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );

    await waitFor(() => {
      expect(calls.find((call) => call.type === "directory.list")?.payload).toEqual({
        path: "/srv/current",
      });
    });
  });

  it("falls back to the last browsed directory when no workspace is selected", async () => {
    localStorage.setItem("genehub:project-picker:loopback:本机", "/srv/remembered");
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "directory.list": (payload: { path: string | null }) => ({
        type: "directory",
        data: {
          path: payload.path ?? "/home/me",
          parent: "/srv",
          directories: [],
          workspaceFiles: [],
          roots: false,
        },
      }),
    });
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );

    await waitFor(() => {
      expect(calls.find((call) => call.type === "directory.list")?.payload).toEqual({
        path: "/srv/remembered",
      });
    });
  });

  it("opens a .code-workspace file exposed by the remote directory picker", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "workspace.open": () => ({
        type: "workspace",
        data: {
          id: "w_suite",
          name: "suite",
          root: "/srv/product",
          isGitRepo: true,
          workspaceFile: "/srv/suite.code-workspace",
          folders: [
            { name: "Product", root: "/srv/product", rootHandle: "r_product" },
            { name: "Docs", root: "/srv/docs", rootHandle: "r_docs" },
          ],
        },
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "directory.list": () => ({
        type: "directory",
        data: {
          path: "/srv",
          parent: "/",
          directories: [],
          workspaceFiles: [
            { name: "suite.code-workspace", path: "/srv/suite.code-workspace" },
          ],
          roots: false,
        },
      }),
    });
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /suite\.code-workspace/ }),
    );

    await waitFor(() => {
      expect(calls.find((call) => call.type === "workspace.open")?.payload).toEqual({
        root: "/srv/suite.code-workspace",
      });
    });
  });

  it("climbs from a Windows drive root into the machine roots listing", async () => {
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "directory.list": (payload: { path: string | null }) => {
        if (payload.path === "") {
          return {
            type: "directory",
            data: {
              path: "",
              parent: null,
              directories: [
                { name: "C:", path: "C:\\" },
                { name: "D:", path: "D:\\" },
              ],
              workspaceFiles: [],
              roots: true,
            },
          };
        }
        return {
          type: "directory",
          data: {
            path: "C:\\",
            parent: "",
            directories: [{ name: "Users", path: "C:\\Users" }],
            workspaceFiles: [],
            roots: false,
          },
        };
      },
    });
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );
    expect(await screen.findByText("C:\\")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /所有磁盘/ }));
    expect(await screen.findByRole("heading", { name: "选择磁盘" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /D:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开此工作区" })).toBeDisabled();
    expect(calls.some((call) => call.type === "directory.list" && call.payload.path === "")).toBe(
      true,
    );
  });

  it("creates a folder from the remote project picker", async () => {
    let directories = [{ name: "app", path: "/srv/app" }];
    const { client, calls } = stubClient({
      "agent.list": () => ({ type: "agents", data: [READY_AGENT] }),
      "workspace.list": () => ({ type: "workspaces", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "directory.list": () => ({
        type: "directory",
        data: {
          path: "/srv",
          parent: "/",
          directories,
          workspaceFiles: [],
          roots: false,
        },
      }),
      "directory.mkdir": (payload: { parent: string; name: string }) => {
        directories = [
          ...directories,
          { name: payload.name, path: `${payload.parent}/${payload.name}` },
        ];
        return {
          type: "directory",
          data: {
            path: payload.parent,
            parent: "/",
            directories,
            workspaceFiles: [],
            roots: false,
          },
        };
      },
    });
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );
    await userEvent.click(await screen.findByRole("button", { name: "新建文件夹" }));
    const input = await screen.findByLabelText("新文件夹名称");
    await userEvent.clear(input);
    await userEvent.type(input, "fresh");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(calls.find((call) => call.type === "directory.mkdir")?.payload).toEqual({
        parent: "/srv",
        name: "fresh",
      });
    });
    expect(await screen.findByRole("button", { name: /fresh/ })).toBeInTheDocument();
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
      if (request.type === "directory.list") {
        return {
          type: "directory",
          data: { path: "/nope", parent: "/", directories: [], workspaceFiles: [], roots: false },
        };
      }
      if (request.type === "agent.list") return { type: "agents", data: [READY_AGENT] };
      if (request.type === "workspace.list") return { type: "workspaces", data: [] };
      return { type: "hubStatus", data: { state: "unpaired" } };
    };
    await start(client, hostWith());

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "打开工作区" }))[0]!,
    );
    await userEvent.click(await screen.findByRole("button", { name: "打开此工作区" }));

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
        data: [workspace("w1", "app", "/home/me/app", true)],
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

  it("does not misdiagnose an empty OpenCode catalog as a missing GeneHub key", async () => {
    const opencode: AgentInfo = {
      ...UNCONFIGURED_AGENT,
      id: "opencode",
      label: "OpenCode",
      builtin: false,
      capabilities: {
        ...UNCONFIGURED_AGENT.capabilities,
        setEffort: false,
        setMode: false,
        permissions: false,
        attachments: true,
      },
    };
    const { client } = stubClient({
      "agent.list": () => ({ type: "agents", data: [opencode] }),
      "workspace.list": () => ({
        type: "workspaces",
        data: [workspace("w1", "app", "/home/me/app", true)],
      }),
      "session.list": () => ({ type: "sessions", data: [] }),
      "hub.status": () => ({ type: "hubStatus", data: { state: "unpaired" } }),
    });
    await start(client, hostWith());

    expect(await screen.findByPlaceholderText(/描述任务/)).toBeInTheDocument();
    expect(screen.queryByText("还差一个模型密钥。")).not.toBeInTheDocument();
    expect(useWorkbench.getState().draft?.agentId).toBe("opencode");
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
        data: [workspace("w1", "GeneHub", "/home/me/GeneHub", false)],
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
        data: [workspace("w1", "GeneHub", "/home/me/GeneHub", false)],
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
        data: [workspace("w1", "GeneHub", "/home/me/GeneHub", false)],
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
        data: [workspace("w1", "app", "/home/me/app", true)],
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

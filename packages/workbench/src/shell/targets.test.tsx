import type {
  AgentInfo,
  Reply,
  Request,
  SessionSummary,
  TimelineItem,
  WorkspaceInfo,
} from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { rememberMachine } from "../devices/machines";
import { browserHost, desktopHost, type Endpoint, type Host } from "../host";
import { socketQueue, TEST_PEER_SECRET } from "../protocol/fake-socket";
import type { ProtocolDial } from "../protocol/client";
import { useWorkbench } from "../session/store";

/**
 * The target switcher: which machine the workbench is pointed at.
 *
 * The behaviour worth pinning is not the dropdown. It is that "local" and
 * "remote" are the same kind of thing here — a desktop app can drive a machine
 * across the room, and a machine that is not this one does not stop being
 * driveable because the daemon on this one restarted.
 */

const REMOTE =
  "wss://relay.example.com/fabric/v2?ticket=client%3Aabc&route=abc";

const paired = (machineId: string, name: string, endpoint = REMOTE) =>
  rememberMachine({
    machineId,
    name,
    fingerprint: "AAAA-BBBB",
    endpoint,
    deviceId: "d_1",
    secret: "s_1",
    pairedAt: new Date().toISOString(),
  });

/**
 * A stand-in for `App`'s `connect`, typed so that what it was called with —
 * the endpoint, and the redial that asks for a fresh ticket — is inspectable.
 */
const connectSpy = () =>
  vi.fn((_endpoint: Endpoint, _redial: () => Promise<string | ProtocolDial>) =>
    stubClient(),
  );

/** Enough of a client for the store to attach to without throwing in an effect. */
function stubClient() {
  return {
    connect() {},
    close() {},
    onStateChange: () => () => {},
    onNotice: () => () => {},
    onUpdateDownload: () => () => {},
    onBackgroundProcesses: () => () => {},
    onEvent: () => () => {},
    onPty: () => () => {},
    call: async () => null,
    subscribe: async () => ({ replayed: [], reset: false }),
    unsubscribe: async () => {},
  } as never;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
  useWorkbench.setState({ connection: "ready", tabs: [], activeTabId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("what a shell says it can drive", () => {
  it("puts this computer in the desktop's list alongside the machines it paired with", async () => {
    vi.stubGlobal("window", {
      __TAURI__: {
        core: {
          invoke: vi.fn(async () => ({
            port: 42123,
            url: "ws://127.0.0.1:42123/ws?challenge=fresh&pid=42&expiresAt=1&proof=proof",
            machineId: "m_here",
            fingerprint: "AB-CD",
            pid: 42,
            challenge: "c".repeat(64),
            expiresAt: Math.ceil(Date.now() / 1000) + 30,
            serverProof: TEST_PEER_SECRET,
          })),
        },
      },
      localStorage,
    });
    paired("m_far", "工作机");

    expect(await desktopHost().targets!()).toEqual([
      {
        id: "local",
        deviceHandle: "m_here",
        label: "这台电脑",
        kind: "local",
        online: true,
      },
      {
        id: "m_far",
        deviceHandle: "m_far",
        label: "工作机",
        kind: "remote",
        fingerprint: "AAAA-BBBB",
      },
    ]);
  });

  it("keeps this computer on the list when its daemon is down, marked offline", async () => {
    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke: vi.fn(async () => null) } },
      localStorage,
    });

    // Dropping the row would read as "this machine no longer exists", when what
    // happened is that a process failed to start.
    expect(await desktopHost().targets!()).toEqual([
      { id: "local", label: "这台电脑", kind: "local", online: false },
    ]);
  });

  it("carries the pairing credential when switching, or a relayed machine will not answer", async () => {
    paired("m_far", "工作机");
    const host = browserHost({ hash: "" });

    expect(await host.openTarget!("m_far")).toMatchObject({
      url: REMOTE,
      via: "relay",
      label: "工作机",
      credential: { deviceId: "d_1", secret: "s_1" },
    });
    // The address bar follows, so a reload stays where the user is looking.
    expect(decodeURIComponent(window.location.hash)).toContain(REMOTE);
    expect(window.location.pathname).toBe("/d/m_far");
  });

  it("can inspect a fork destination without moving the browser there", async () => {
    paired("m_far", "工作机");
    const host = browserHost({ hash: "" });

    await host.openTarget!("m_far", { remember: false });

    expect(window.location.hash).toBe("");
  });

  it("says so rather than connecting nowhere when the machine was forgotten", async () => {
    await expect(
      browserHost({ hash: "" }).openTarget!("m_gone"),
    ).rejects.toThrow(/名册/);
  });
});

/**
 * Where the account's machines come from on the desktop.
 *
 * Through this machine's own daemon, on a connection of its own — not from
 * anything compiled into the app. The app is the open-source workbench and
 * holds no account credential; the daemon holds the uplink one. That is the
 * boundary the packaging depends on (`genethub-cloud/desktop/README.md`), so it
 * is worth a test that fails if someone routes it any other way.
 */
describe("the machines the account knows about", () => {
  const daemonUp = () =>
    vi.stubGlobal("window", {
      __TAURI__: {
        core: {
          invoke: vi.fn(async () => ({
            port: 42123,
            url: "ws://127.0.0.1:42123/ws?challenge=fresh&pid=42&expiresAt=1&proof=proof",
            machineId: "m_here",
            fingerprint: "AB-CD",
            pid: 42,
            challenge: "c".repeat(64),
            expiresAt: Math.ceil(Date.now() / 1000) + 30,
            serverProof: TEST_PEER_SECRET,
          })),
        },
      },
      localStorage,
    });

  /**
   * Answers one request on the nth side connection the host opens.
   *
   * By index rather than "the latest", because each exchange gets a socket of
   * its own and a helper that grabbed whichever existed would answer the
   * previous, already hung-up one.
   */
  const answer = async (
    queue: ReturnType<typeof socketQueue>,
    nth: number,
    type: string,
    reply: Reply,
  ) => {
    await vi.waitFor(() => expect(queue.sockets.length).toBeGreaterThan(nth));
    const socket = queue.sockets[nth]!;
    socket.open();
    await vi.waitFor(() => socket.lastOf("hello"));
    socket.acceptHandshake();
    await vi.waitFor(() => socket.lastOf(type));
    socket.reply(socket.lastOf(type).id, reply);
  };

  const accountQueue = () =>
    socketQueue({
      secret: TEST_PEER_SECRET,
      identity: {
        machineId: "m_here",
        fingerprint: "AB-CD",
        machineName: "这台电脑",
        transport: "loopback",
        rtcSupported: false,
      },
    });

  it("lists them under this computer, without listing this computer twice", async () => {
    daemonUp();
    const queue = accountQueue();
    const listed = desktopHost(queue.factory).targets!();

    await answer(queue, 0, "hub.machines", {
      type: "hubMachines",
      data: [
        // The Hub knows about this machine too. It is already the first row,
        // and a second one would reach the daemon underfoot through a relay.
        {
          id: "mch_here",
          deviceHandle: "m_here",
          name: "这台电脑",
          online: true,
          fingerprint: "AB-CD",
        },
        {
          id: "mch_far",
          deviceHandle: "m_far",
          name: "公司台式机",
          online: false,
          fingerprint: "EF-GH",
        },
      ],
    });

    expect(await listed).toEqual([
      {
        id: "local",
        deviceHandle: "m_here",
        label: "这台电脑",
        kind: "local",
        online: true,
      },
      {
        id: "mch_far",
        deviceHandle: "m_far",
        label: "公司台式机",
        kind: "remote",
        online: false,
        fingerprint: "EF-GH",
      },
    ]);
  });

  it("does not repeat a machine this browser also paired with by hand", async () => {
    daemonUp();
    paired("m_far", "工作机");
    const queue = accountQueue();
    const listed = desktopHost(queue.factory).targets!();

    await answer(queue, 0, "hub.machines", {
      type: "hubMachines",
      // Same computer, different id space: the Hub's ids and the ones a local
      // pairing recorded have nothing to do with each other, so the key that
      // works is the machine's own key.
      data: [
        {
          id: "mch_far",
          deviceHandle: "m_far",
          name: "工作机（账号）",
          online: true,
          fingerprint: "AAAA-BBBB",
        },
      ],
    });

    expect((await listed).map((target) => target.label)).toEqual([
      "这台电脑",
      "工作机",
    ]);
  });

  it("still shows this computer when the Hub cannot be reached", async () => {
    daemonUp();
    const queue = accountQueue();
    const listed = desktopHost(queue.factory).targets!();

    await vi.waitFor(() => expect(queue.sockets.length).toBeGreaterThan(0));
    queue.latest().close();

    // The local row is the one that still works with the network down. Burying
    // it under an error about an account server would be the wrong trade.
    expect(await listed).toEqual([
      {
        id: "local",
        deviceHandle: "m_here",
        label: "这台电脑",
        kind: "local",
        online: true,
      },
    ]);
  });

  it("mints the ticket through the local daemon, so switching survives the far end dropping", async () => {
    daemonUp();
    const queue = accountQueue();
    const opening = desktopHost(queue.factory).openTarget!("mch_far");

    // One short-lived connection carries both asks (ticket + label). A second
    // socket used to be a second handshake that could fail the whole switch.
    await vi.waitFor(() => expect(queue.sockets.length).toBe(1));
    const socket = queue.sockets[0]!;
    socket.open();
    await vi.waitFor(() => socket.lastOf("hello"));
    socket.acceptHandshake();
    await vi.waitFor(() => socket.lastOf("hub.connect"));
    socket.reply(socket.lastOf("hub.connect").id, {
      type: "hubTicket",
      data: {
        url: REMOTE,
        expiresAt: "2099-01-01T00:00:00Z",
        fingerprint: "EF-GH",
        channelCapability: "cap_test",
        channelSecret: "secret_test",
        fabricRouteTicket: "route_test",
        fabricRouteExpiresAt: "2099-01-01T00:00:00Z",
      },
    });
    await vi.waitFor(() => socket.lastOf("hub.machines"));
    socket.reply(socket.lastOf("hub.machines").id, {
      type: "hubMachines",
      data: [
        {
          id: "mch_far",
          deviceHandle: "m_far",
          name: "公司台式机",
          online: true,
          fingerprint: "EF-GH",
        },
      ],
    });

    expect(await opening).toEqual({
      url: REMOTE,
      via: "relay",
      label: "公司台式机",
      fingerprint: "EF-GH",
      channelCredential: { capabilityId: "cap_test", secret: "secret_test" },
      fabricRouteTicket: "route_test",
    });
    // Dialled the machine underfoot, not the one being switched to: the far end
    // is exactly what may be unreachable when a reconnect needs a fresh ticket.
    expect(queue.urls.every((url) => url.includes("127.0.0.1:42123"))).toBe(
      true,
    );
  });
});

describe("switching from the sidebar", () => {
  const localEndpoint: Endpoint = {
    url: "ws://127.0.0.1:1/ws",
    via: "loopback",
    label: "这台电脑",
  };
  const remoteEndpoint: Endpoint = {
    url: REMOTE,
    via: "relay",
    label: "工作机",
  };

  const host = (overrides: Partial<Host> = {}): Host => ({
    kind: "desktop",
    endpoint: async () => localEndpoint,
    notify: () => {},
    openExternal: () => {},
    targets: async () => [
      { id: "local", label: "这台电脑", kind: "local", online: true },
      { id: "m_far", label: "工作机", kind: "remote" },
    ],
    openTarget: async (id) => (id === "local" ? localEndpoint : remoteEndpoint),
    ...overrides,
  });

  it("names the machine everything below it belongs to", async () => {
    render(<App host={host()} connect={() => stubClient()} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /这台电脑/ }),
      ).toBeInTheDocument(),
    );
  });

  it("points the workbench at another machine, credential and all", async () => {
    const connect = connectSpy();
    render(<App host={host()} connect={connect} />);

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /这台电脑/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: /工作机/ }),
    );

    await waitFor(() =>
      expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ url: REMOTE }),
    );
  });

  it("exports a completed turn, validates the remote catalog, and opens the imported fork", async () => {
    const sourceSession: SessionSummary = {
      id: "source-session",
      workspaceId: "source-workspace",
      agentId: "codex",
      title: "Investigate",
      status: "idle",
      createdAtMs: 1,
      updatedAtMs: 2,
      archived: false,
    };
    const forkedSession: SessionSummary = {
      ...sourceSession,
      id: "forked-session",
      workspaceId: "remote-workspace",
      agentId: "claude",
      title: "Investigate · 分支",
      updatedAtMs: 3,
    };
    const sourceWorkspace: WorkspaceInfo = {
      id: "source-workspace",
      name: "Source",
      root: "/work/source",
      isGitRepo: true,
      folders: [],
    };
    const remoteWorkspace: WorkspaceInfo = {
      id: "remote-workspace",
      name: "Remote",
      root: "/work/remote",
      isGitRepo: true,
      folders: [],
    };
    const agent = (id: string, fork: boolean): AgentInfo => ({
      id,
      label: id === "codex" ? "Codex" : "Claude Code",
      builtin: false,
      probe: { state: "ready" },
      capabilities: {
        interrupt: false,
        setModel: false,
        setMode: false,
        setEffort: false,
        permissions: false,
        resume: false,
        fork,
        attachments: false,
      },
      catalog: { models: [], modes: [], commands: [] },
    });
    const items: TimelineItem[] = [
      { type: "userMessage", id: "u1", text: "继续实现", attachments: [] },
      {
        type: "turnSummary",
        id: "summary-1",
        stats: {
          turnId: "turn-1",
          outcome: "completed",
          startedAtMs: 1,
          finishedAtMs: 2,
          durationMs: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            llmRounds: 1,
            toolOutputTokens: 0,
            compactionCount: 0,
            outputRateEstimated: false,
          },
          toolCalls: 0,
          forkCheckpoint: "native-only",
        },
      },
    ];
    const sourceCalls: Request[] = [];
    const remoteCalls: Request[] = [];
    const client = (remote: boolean) => {
      const summary = remote ? forkedSession : sourceSession;
      const calls = remote ? remoteCalls : sourceCalls;
      return {
        connectionState: "ready",
        identity: { machineId: remote ? "m_far" : "m_here" },
        connect() {},
        close() {},
        onStateChange: () => () => {},
        onNotice: () => () => {},
        onUpdateDownload: () => () => {},
        onBackgroundProcesses: () => () => {},
        onEvent: () => () => {},
        onPty: () => () => {},
        call: async (request: Request): Promise<Reply | null> => {
          calls.push(request);
          switch (request.type) {
            case "agent.list":
              return { type: "agents", data: [agent(remote ? "claude" : "codex", !remote)] };
            case "workspace.list":
              return { type: "workspaces", data: [remote ? remoteWorkspace : sourceWorkspace] };
            case "session.list":
              return { type: "sessions", data: [summary] };
            case "session.forkExport":
              return {
                type: "forkTransfer",
                data: {
                  sourceSessionId: sourceSession.id,
                  sourceTurnId: "turn-1",
                  sourceAgentId: sourceSession.agentId,
                  title: sourceSession.title,
                  items,
                  coverage: {
                    sourceItemCount: 2,
                    retainedItemCount: 2,
                    omittedItemCount: 0,
                    retrieval: "genehub",
                  },
                  blobAppendix: [],
                },
              };
            case "session.forkImport":
              return { type: "session", data: forkedSession };
            default:
              return null;
          }
        },
        subscribe: async () => ({
          snapshot: {
            seq: 0,
            items,
            pendingPermissions: [],
            summary,
          },
          replayed: [],
          reset: true,
        }),
        unsubscribe: async () => {},
      } as never;
    };
    const connect = vi.fn((endpoint: Endpoint) => client(endpoint.url === REMOTE));
    const openTarget = vi.fn(async (id: string) => id === "local" ? localEndpoint : remoteEndpoint);
    render(
      <App
        host={host({
          targets: async () => [
            {
              id: "local",
              deviceHandle: "m_here",
              label: "这台电脑",
              kind: "local",
              online: true,
            },
            {
              id: "m_far",
              deviceHandle: "m_far",
              label: "工作机",
              kind: "remote",
              online: true,
            },
          ],
          openTarget,
        })}
        connect={connect}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Fork" }));
    await userEvent.click(await screen.findByRole("radio", { name: "工作机" }));
    expect(await screen.findByRole("option", { name: /Remote/ })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Fork 会话" })).toBeInTheDocument();
    expect(useWorkbench.getState().activeSessionId).toBe("source-session");
    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));

    await waitFor(() => expect(sourceCalls).toContainEqual({
      type: "session.forkExport",
      payload: { sessionId: "source-session", turnId: "turn-1" },
    }));
    await waitFor(() => expect(remoteCalls).toContainEqual({
      type: "session.forkImport",
      payload: {
        transfer: expect.objectContaining({ sourceSessionId: "source-session" }),
        target: { agentId: "claude", workspaceId: "remote-workspace" },
      },
    }));
    // The fork lands without yanking the user onto the other machine: the
    // dialog closes, the source session stays on screen, and the jump is a
    // button on the completion banner, not a side effect of confirming.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Fork 会话" })).not.toBeInTheDocument(),
    );
    expect(useWorkbench.getState().activeSessionId).toBe("source-session");
    expect(openTarget).toHaveBeenCalledWith("m_far", { remember: false });
    expect(openTarget).not.toHaveBeenCalledWith("m_far");

    const jump = await screen.findByRole("button", { name: "前往查看" });
    await userEvent.click(jump);
    await waitFor(() => expect(useWorkbench.getState().activeSessionId).toBe("forked-session"));
    expect(openTarget).toHaveBeenCalledWith("m_far");
  });

  it("sends an explicit target so a non-native Agent can Fork back to itself", async () => {
    const sourceSession: SessionSummary = {
      id: "cursor-session",
      workspaceId: "source-workspace",
      agentId: "cursor",
      title: "Investigate",
      status: "idle",
      createdAtMs: 1,
      updatedAtMs: 2,
      archived: false,
    };
    const forkedSession: SessionSummary = {
      ...sourceSession,
      id: "cursor-fork",
      title: "Investigate · 分支",
      updatedAtMs: 3,
    };
    const workspace: WorkspaceInfo = {
      id: "source-workspace",
      name: "Source",
      root: "/work/source",
      isGitRepo: true,
      folders: [],
    };
    const cursor: AgentInfo = {
      id: "cursor",
      label: "Cursor",
      builtin: false,
      probe: { state: "ready" },
      capabilities: {
        interrupt: false,
        setModel: false,
        setMode: false,
        setEffort: false,
        permissions: false,
        resume: false,
        fork: false,
        attachments: false,
      },
      catalog: { models: [], modes: [], commands: [] },
    };
    const items: TimelineItem[] = [
      { type: "userMessage", id: "u1", text: "继续实现", attachments: [] },
      {
        type: "turnSummary",
        id: "summary-1",
        stats: {
          turnId: "turn-1",
          outcome: "completed",
          startedAtMs: 1,
          finishedAtMs: 2,
          durationMs: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            llmRounds: 1,
            toolOutputTokens: 0,
            compactionCount: 0,
            outputRateEstimated: false,
          },
          toolCalls: 0,
        },
      },
    ];
    const calls: Request[] = [];
    const client = {
      connectionState: "ready",
      identity: { machineId: "m_here" },
      connect() {},
      close() {},
      onStateChange: () => () => {},
      onNotice: () => () => {},
      onUpdateDownload: () => () => {},
      onBackgroundProcesses: () => () => {},
      onEvent: () => () => {},
      onPty: () => () => {},
      call: async (request: Request): Promise<Reply | null> => {
        calls.push(request);
        switch (request.type) {
          case "agent.list":
            return { type: "agents", data: [cursor] };
          case "workspace.list":
            return { type: "workspaces", data: [workspace] };
          case "session.list":
            return { type: "sessions", data: [sourceSession] };
          case "session.fork":
            return { type: "session", data: forkedSession };
          default:
            return null;
        }
      },
      subscribe: async (sessionId: string) => ({
        snapshot: {
          seq: 0,
          items,
          pendingPermissions: [],
          summary: sessionId === forkedSession.id ? forkedSession : sourceSession,
        },
        replayed: [],
        reset: true,
      }),
      unsubscribe: async () => {},
    } as never;
    const connect = vi.fn(() => client);
    useWorkbench.setState({
      activeSessionId: null,
      sessions: [],
      draft: null,
      client: null,
    });
    render(
      <App
        host={host({
          targets: async () => [
            {
              id: "local",
              deviceHandle: "m_here",
              label: "这台电脑",
              kind: "local",
              online: true,
            },
          ],
        })}
        connect={connect}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Fork" }));
    expect(screen.getByText("重建会话")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重建到所选目标" }));

    await waitFor(() => expect(calls).toContainEqual({
      type: "session.fork",
      payload: {
        sessionId: "cursor-session",
        turnId: "turn-1",
        target: { agentId: "cursor", workspaceId: "source-workspace" },
      },
    }));
    await waitFor(() => expect(useWorkbench.getState().activeSessionId).toBe("cursor-fork"));
  });

  it("does not drag someone home because the local daemon restarted", async () => {
    let announce = () => {};
    const connect = connectSpy();
    render(
      <App
        host={host({
          onEndpointChange: (listener) => {
            announce = listener;
            return () => {};
          },
        })}
        connect={connect}
      />,
    );

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /这台电脑/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: /工作机/ }),
    );
    await waitFor(() =>
      expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ url: REMOTE }),
    );

    announce();

    // A sidecar coming back on a new port is news about one machine, not an
    // instruction to leave the one being worked on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ url: REMOTE });
  });

  it("asks the target again on every redial, because a ticket is spent once", async () => {
    const openTarget = vi.fn(async () => remoteEndpoint);
    const connect = connectSpy();
    render(<App host={host({ openTarget })} connect={connect} />);

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /这台电脑/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: /工作机/ }),
    );
    await waitFor(() => expect(openTarget).toHaveBeenCalledTimes(1));

    const redial = connect.mock.calls.at(-1)![1];
    expect(await redial()).toEqual({ url: REMOTE });
    expect(openTarget).toHaveBeenCalledTimes(2);
  });

  it("stays out of the way where the shell has only one machine to offer", async () => {
    render(
      <App
        host={{
          kind: "browser",
          endpoint: async () => localEndpoint,
          notify: () => {},
          openExternal: () => {},
        }}
        connect={() => stubClient()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("新建会话")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /这台电脑/ }),
    ).not.toBeInTheDocument();
  });
});

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
import { browserHost, type Endpoint, type Host } from "../host";
import type { ProtocolDial } from "../protocol/client";
import { useWorkbench } from "../session/store";

/**
 * The target switcher: which machine the workbench is pointed at.
 *
 * The behaviour worth pinning is not the dropdown. It is that direct and
 * relayed machines are the same browser target shape, and that reconnecting a
 * relayed one always mints fresh connection material.
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
    kind: "browser",
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
    await waitFor(() => expect(useWorkbench.getState().activeSessionId).toBe("forked-session"));
    expect(openTarget).toHaveBeenCalledWith("m_far", { remember: false });
    expect(openTarget).toHaveBeenCalledWith("m_far");
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

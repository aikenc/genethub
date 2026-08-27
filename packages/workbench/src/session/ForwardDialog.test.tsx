import type { AgentInfo, SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { ForwardDialog } from "./ForwardDialog";
import type { CapsuleMessage, ForwardSource } from "./forwardCapsule";
import type { MachineOption } from "./MachineCatalogPicker";
import { useWorkbench } from "./store";
import { emptyTimeline } from "./timeline";
import type { ForwardController } from "./TimelineView";

function agent(id: string, label: string): AgentInfo {
  return {
    id,
    label,
    builtin: false,
    probe: { state: "ready" },
    capabilities: {
      interrupt: false,
      setModel: false,
      setEffort: false,
      setMode: false,
      permissions: false,
      resume: false,
      fork: false,
      attachments: false,
    },
    catalog: { models: [], modes: [], commands: [] },
  };
}

function workspace(id: string, name: string): WorkspaceInfo {
  return { id, name, root: `/work/${id}`, isGitRepo: true, folders: [] };
}

function session(id: string, title: string, agentId = "codex"): SessionSummary {
  return {
    id,
    workspaceId: "w1",
    agentId,
    title,
    status: "idle",
    createdAtMs: 0,
    updatedAtMs: 1,
    archived: false,
  };
}

const sourceMachine: MachineOption = {
  id: "m_here",
  routeId: "local",
  label: "开发机",
  kind: "local",
  online: true,
};

const remoteMachine: MachineOption = {
  id: "m_far",
  routeId: "m_far",
  label: "工作机",
  kind: "remote",
  online: true,
};

const SOURCE: ForwardSource = {
  sessionId: "s1",
  agentLabel: "Codex",
  sessionTitle: "源会话",
  spanMs: null,
};

const MESSAGES: CapsuleMessage[] = [
  { id: "u1", role: "user", text: "你好", attachments: [], roundId: null, atMs: null },
];

function stubClient() {
  return {
    call: async (request: { type: string }) => {
      if (request.type === "round.trunk.list") {
        return { type: "roundLayer", data: { trunks: [], nextCursor: null } };
      }
      return undefined;
    },
    subscribe: async () => ({
      snapshot: { seq: 0, items: [], pendingPermission: undefined, summary: session("s2", "既有会话") },
      replayed: [],
      reset: false,
    }),
    unsubscribe: async () => {},
  } as unknown as Client;
}

beforeEach(() => {
  localStorage.clear();
  useWorkbench.setState({
    client: stubClient(),
    agents: [agent("codex", "Codex")],
    workspaces: [workspace("w1", "GeneHub")],
    sessions: [session("s1", "源会话"), session("s2", "既有会话")],
    activeSessionId: "s1",
    activeWorkspaceId: "w1",
    draft: null,
    tabs: [],
    activeTabId: null,
    notice: null,
    forwardDraft: null,
    completionNotice: null,
    timeline: emptyTimeline(),
    sessionTimelines: {},
    subscribedSessionIds: [],
  });
});

async function waitForBuilt() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /放入输入框|直接发送|创建并发送/ })).toBeEnabled(),
  );
}

describe("ForwardDialog", () => {
  it("parks the capsule on the draft composer for a same-machine new session", async () => {
    const onConfirmed = vi.fn();
    render(
      <ForwardDialog
        source={SOURCE}
        messages={MESSAGES}
        rounds={[]}
        onClose={vi.fn()}
        onConfirmed={onConfirmed}
      />,
    );

    await waitForBuilt();
    await userEvent.click(screen.getByRole("button", { name: "放入输入框" }));

    const draft = useWorkbench.getState().forwardDraft;
    expect(draft?.sessionId).toBeNull();
    expect(draft?.capsule).toContain("你好");
    expect(useWorkbench.getState().draft?.workspaceId).toBe("w1");
    expect(onConfirmed).toHaveBeenCalled();
  });

  it("parks the capsule on an existing same-machine session and opens it", async () => {
    render(
      <ForwardDialog
        source={SOURCE}
        messages={MESSAGES}
        rounds={[]}
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
      />,
    );

    await waitForBuilt();
    await userEvent.click(screen.getByRole("radio", { name: "既有会话" }));
    await userEvent.click(await screen.findByRole("option", { name: /既有会话/ }));
    await userEvent.click(screen.getByRole("button", { name: "放入输入框" }));

    await waitFor(() =>
      expect(useWorkbench.getState().forwardDraft?.sessionId).toBe("s2"),
    );
    expect(useWorkbench.getState().activeSessionId).toBe("s2");
  });

  it("delivers cross-machine forwards immediately and offers the jump instead of teleporting", async () => {
    const deliver = vi.fn(async () => ({ sessionId: "remote-s" }));
    const jumpTo = vi.fn();
    const controller: ForwardController = {
      sourceMachine,
      listMachines: async () => [sourceMachine, remoteMachine],
      loadCatalog: async () => ({
        agents: [agent("claude", "Claude Code")],
        workspaces: [workspace("rw", "远程项目")],
      }),
      loadSessions: async () => [session("remote-s", "远端会话", "claude")],
      deliver,
      jumpTo,
    };
    const onConfirmed = vi.fn();
    render(
      <ForwardDialog
        source={SOURCE}
        messages={MESSAGES}
        rounds={[]}
        controller={controller}
        onClose={vi.fn()}
        onConfirmed={onConfirmed}
      />,
    );

    await waitForBuilt();
    await userEvent.click(screen.getByRole("radio", { name: "既有会话" }));
    await userEvent.click(await screen.findByRole("radio", { name: "工作机" }));
    await userEvent.click(await screen.findByRole("option", { name: /远端会话/ }));
    await userEvent.click(screen.getByRole("button", { name: "直接发送" }));

    await waitFor(() =>
      expect(deliver).toHaveBeenCalledWith(
        remoteMachine,
        { kind: "session", sessionId: "remote-s" },
        expect.stringContaining("你好"),
      ),
    );
    // Nothing is parked locally and nobody navigates; the banner offers the jump.
    expect(useWorkbench.getState().forwardDraft).toBeNull();
    expect(useWorkbench.getState().activeSessionId).toBe("s1");
    const notice = useWorkbench.getState().completionNotice;
    expect(notice?.text).toContain("工作机");
    notice?.onAction?.();
    expect(jumpTo).toHaveBeenCalledWith(remoteMachine, "remote-s");
    expect(onConfirmed).toHaveBeenCalled();
  });

  it("creates a session on the target machine for a cross-machine new forward", async () => {
    const deliver = vi.fn(async () => ({ sessionId: "created-s" }));
    const controller: ForwardController = {
      sourceMachine,
      listMachines: async () => [sourceMachine, remoteMachine],
      loadCatalog: async () => ({
        agents: [agent("claude", "Claude Code")],
        workspaces: [workspace("rw", "远程项目")],
      }),
      loadSessions: async () => [],
      deliver,
      jumpTo: vi.fn(),
    };
    render(
      <ForwardDialog
        source={SOURCE}
        messages={MESSAGES}
        rounds={[]}
        controller={controller}
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
      />,
    );

    await waitForBuilt();
    await userEvent.click(await screen.findByRole("radio", { name: "工作机" }));
    await userEvent.click(await screen.findByRole("option", { name: /远程项目/ }));
    await userEvent.click(screen.getByRole("button", { name: "创建并发送" }));

    await waitFor(() =>
      expect(deliver).toHaveBeenCalledWith(
        remoteMachine,
        { kind: "new", workspaceId: "rw", agentId: "claude" },
        expect.stringContaining("你好"),
      ),
    );
    expect(useWorkbench.getState().completionNotice?.text).toContain("工作机");
    expect(useWorkbench.getState().forwardDraft).toBeNull();
  });
});

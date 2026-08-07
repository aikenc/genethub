import type { AgentInfo, SequencedEvent, SessionSummary } from "@genehub/proto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { defaultAgent, useWorkbench } from "./store";

/**
 * The daemon pushes `titleChanged` once, the moment a session picks up a
 * name (`SessionManager::send`, first message only). A client that ignores
 * the push and only ever reads titles off `session.list`/`session.create`
 * shows "新会话" until something unrelated causes a refetch — this is the bug
 * the user reported as "标题没刷新".
 */

const SESSION: SessionSummary = {
  id: "s1",
  workspaceId: "w1",
  agentId: "genet",
  title: undefined,
  createdAtMs: 0,
  updatedAtMs: 0,
  archived: false,
  status: "idle",
};

function stubClient() {
  let onEvent: ((event: SequencedEvent) => void) | null = null;
  const client = {
    subscribe: async (_sessionId: string, handlers: { onEvent: (event: SequencedEvent) => void }) => {
      onEvent = handlers.onEvent;
      return {
        snapshot: {
          seq: 0,
          items: [],
          pendingPermission: undefined,
          summary: SESSION,
        },
        replayed: [],
        reset: false,
      };
    },
    unsubscribe: async () => {},
  } as unknown as Client;
  return { client, fire: (event: SequencedEvent) => onEvent?.(event) };
}

beforeEach(() => {
  useWorkbench.setState({
    client: null,
    agents: [],
    workspaces: [],
    sessions: [SESSION],
    activeSessionId: null,
    activeWorkspaceId: null,
    draft: null,
    tabs: [],
    activeTabId: null,
    notice: null,
    timeline: useWorkbench.getState().timeline,
    sessionTimelines: {},
    subscribedSessionIds: [],
    tabLimit: 16,
  });
});

describe("warm chat tabs", () => {
  it("keeps an opened session subscribed and reactivates it without another snapshot", async () => {
    const other = { ...SESSION, id: "s2" };
    let subscriptions = 0;
    const client = {
      subscribe: async (sessionId: string) => {
        subscriptions += 1;
        return {
          snapshot: { seq: 0, items: [], summary: sessionId === "s2" ? other : SESSION },
          replayed: [],
          reset: false,
        };
      },
      unsubscribe: async () => {},
    } as unknown as Client;
    useWorkbench.setState({ client, sessions: [SESSION, other] });

    await useWorkbench.getState().selectSession("s1");
    await useWorkbench.getState().selectSession("s2");
    await useWorkbench.getState().selectSession("s1");

    expect(subscriptions).toBe(2);
    expect(useWorkbench.getState().tabs.map((tab) => tab.id)).toEqual(["chat:s1", "chat:s2"]);
  });

  it("evicts the least recently used inactive completed tab before a running tab", () => {
    const running = { ...SESSION, id: "s2", status: "running" as const };
    const active = { ...SESSION, id: "s3" };
    useWorkbench.setState({
      sessions: [SESSION, running, active],
      activeTabId: "chat:s3",
      tabs: [
        { id: "chat:s1", kind: "chat", title: "old", sessionId: "s1", lastActivatedAt: 1 },
        { id: "chat:s2", kind: "chat", title: "running", sessionId: "s2", lastActivatedAt: 2 },
        { id: "chat:s3", kind: "chat", title: "active", sessionId: "s3", lastActivatedAt: 3 },
      ],
    });

    useWorkbench.getState().setTabLimit(2);

    expect(useWorkbench.getState().tabs.map((tab) => tab.id)).toEqual(["chat:s2", "chat:s3"]);
  });
});

describe("a session's title arriving after the first message", () => {
  it("repaints the sidebar entry and the tab without a refetch", async () => {
    const { client, fire } = stubClient();
    useWorkbench.setState({ client });
    await useWorkbench.getState().selectSession("s1");

    fire({ seq: 1, sessionId: "s1", event: { type: "titleChanged", title: "Fix the login redirect" } });

    expect(useWorkbench.getState().sessions.find((s) => s.id === "s1")?.title).toBe(
      "Fix the login redirect",
    );
    expect(useWorkbench.getState().tabs.find((t) => t.sessionId === "s1")?.title).toBe(
      "Fix the login redirect",
    );
  });

  it("leaves other sessions' tabs alone", async () => {
    const other: SessionSummary = { ...SESSION, id: "s2" };
    useWorkbench.setState({ sessions: [SESSION, other] });
    const { client, fire } = stubClient();
    useWorkbench.setState({ client });
    await useWorkbench.getState().selectSession("s1");
    useWorkbench.setState((state) => ({
      tabs: [...state.tabs, { id: "chat:s2", kind: "chat" as const, title: "新会话", sessionId: "s2" }],
    }));

    fire({ seq: 1, sessionId: "s1", event: { type: "titleChanged", title: "Fix the login redirect" } });

    expect(useWorkbench.getState().sessions.find((s) => s.id === "s2")?.title).toBeUndefined();
    expect(useWorkbench.getState().tabs.find((t) => t.sessionId === "s2")?.title).toBe("新会话");
  });
});

describe("live session status in the sidebar", () => {
  it("tracks running, waiting, failed and completed events immediately", async () => {
    const { client, fire } = stubClient();
    useWorkbench.setState({ client });
    await useWorkbench.getState().selectSession("s1");

    fire({
      seq: 1,
      sessionId: "s1",
      event: { type: "turnStarted", turnId: "t1", startedAtMs: 1 },
    });
    expect(useWorkbench.getState().sessions[0]?.status).toBe("running");

    fire({
      seq: 2,
      sessionId: "s1",
      event: {
        type: "permissionRequested",
        request: { id: "p1", kind: "permission", title: "允许？", options: [] },
      },
    });
    expect(useWorkbench.getState().sessions[0]?.status).toBe("waiting");

    fire({
      seq: 3,
      sessionId: "s1",
      event: {
        type: "turnFailed",
        turnId: "t1",
        error: { code: "upstream", message: "boom" },
      },
    });
    expect(useWorkbench.getState().sessions[0]?.status).toBe("failed");

    fire({
      seq: 4,
      sessionId: "s1",
      event: {
        type: "turnCompleted",
        turnId: "t1",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    expect(useWorkbench.getState().sessions[0]?.status).toBe("idle");
  });
});

/**
 * The sidebar shows every project's sessions at once, so the session that was
 * clicked is no longer guaranteed to be in the project on screen. The file
 * tree, the terminal and the diff all read `activeWorkspaceId`, and before this
 * they went on pointing at whichever project the user had navigated away from —
 * a diff of the wrong repository, presented as if it were this one.
 */
describe("opening a session that belongs to another project", () => {
  it("moves the rest of the workbench to that project too", async () => {
    const elsewhere: SessionSummary = { ...SESSION, id: "s9", workspaceId: "w2" };
    const { client } = stubClient();
    useWorkbench.setState({
      client,
      sessions: [SESSION, elsewhere],
      activeWorkspaceId: "w1",
    });

    await useWorkbench.getState().selectSession("s9");

    expect(useWorkbench.getState().activeWorkspaceId).toBe("w2");
  });

  it("leaves the project alone for a session it has never heard of", async () => {
    const { client } = stubClient();
    useWorkbench.setState({ client, sessions: [SESSION], activeWorkspaceId: "w1" });

    await useWorkbench.getState().selectSession("unknown");

    expect(useWorkbench.getState().activeWorkspaceId).toBe("w1");
  });

  it("does not let a late subscription overwrite the session opened next", async () => {
    const second: SessionSummary = { ...SESSION, id: "s2" };
    let releaseFirst!: (value: {
      snapshot: unknown;
      replayed: SequencedEvent[];
      reset: boolean;
    }) => void;
    const first = new Promise<{
      snapshot: unknown;
      replayed: SequencedEvent[];
      reset: boolean;
    }>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshot = (summary: SessionSummary, text: string) => ({
      snapshot: {
        seq: 0,
        items: [{ type: "assistantMessage", id: `a-${summary.id}`, text }],
        pendingPermissions: [],
        summary,
      },
      replayed: [],
      reset: true,
    });
    const client = {
      subscribe: async (sessionId: string) =>
        sessionId === "s1" ? first : snapshot(second, "second"),
      unsubscribe: async () => {},
    } as unknown as Client;
    useWorkbench.setState({ client, sessions: [SESSION, second] });

    const openingFirst = useWorkbench.getState().selectSession("s1");
    await useWorkbench.getState().selectSession("s2");
    releaseFirst(snapshot(SESSION, "first"));
    await openingFirst;

    expect(useWorkbench.getState().activeSessionId).toBe("s2");
    expect(useWorkbench.getState().timeline.items).toEqual([
      { type: "assistantMessage", id: "a-s2", text: "second" },
    ]);
  });
});

describe("forking a completed turn", () => {
  it("asks for the exact turn and opens the independent session returned by the daemon", async () => {
    const forked: SessionSummary = {
      ...SESSION,
      id: "s-fork",
      title: "Fix the redirect · 分支",
      updatedAtMs: 10,
    };
    const calls: unknown[] = [];
    const client = {
      call: async (request: unknown) => {
        calls.push(request);
        return { type: "session", data: forked };
      },
      subscribe: async (sessionId: string) => ({
        snapshot: {
          seq: 0,
          items: [],
          pendingPermissions: [],
          summary: sessionId === forked.id ? forked : SESSION,
        },
        replayed: [],
        reset: false,
      }),
      unsubscribe: async () => {},
    } as unknown as Client;
    useWorkbench.setState({ client, activeSessionId: SESSION.id });

    await useWorkbench.getState().forkSession("turn-7");

    expect(calls).toContainEqual({
      type: "session.fork",
      payload: { sessionId: SESSION.id, turnId: "turn-7" },
    });
    expect(useWorkbench.getState().sessions[0]).toEqual(forked);
    expect(useWorkbench.getState().activeSessionId).toBe(forked.id);
  });
});

/**
 * The user's report was "对话发送后没反应". The daemon had in fact refused the
 * send and said why; the click handler dropped the rejection on the floor, so
 * the only trace was an unhandled rejection in a console nobody has open.
 */
describe("an action the user asked for that fails", () => {
  function refusingClient(message: string) {
    return {
      call: async () => {
        throw new Error(message);
      },
      subscribe: async () => ({ snapshot: { seq: 0, items: [], summary: SESSION }, replayed: [], reset: false }),
      unsubscribe: async () => {},
    } as unknown as Client;
  }

  it("says why instead of looking like the button did nothing", async () => {
    useWorkbench.setState({
      client: refusingClient("claude 启动失败：找不到可执行文件"),
      activeSessionId: "s1",
    });

    await useWorkbench.getState().send("hello");

    expect(useWorkbench.getState().notice).toBe("claude 启动失败：找不到可执行文件");
  });

  it("does not leave the last failure sitting there during the next attempt", async () => {
    const client = {
      call: async () => undefined,
      subscribe: async () => ({ snapshot: { seq: 0, items: [], summary: SESSION }, replayed: [], reset: false }),
      unsubscribe: async () => {},
    } as unknown as Client;
    useWorkbench.setState({ client, activeSessionId: "s1", notice: "上一次的错误" });

    await useWorkbench.getState().send("hello");

    expect(useWorkbench.getState().notice).toBeNull();
  });

  it("sends deployment-aware artifact link context without changing the user text", async () => {
    const calls: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const client = {
      call: async (request: { type: string; payload?: Record<string, unknown> }) => {
        calls.push(request);
        return undefined;
      },
      identity: { machineId: "m_device" },
      subscribe: async () => ({ snapshot: { seq: 0, items: [], summary: SESSION }, replayed: [], reset: false }),
      unsubscribe: async () => {},
    } as unknown as Client;
    useWorkbench.setState({
      client,
      activeSessionId: "s1",
      activeWorkspaceId: "w1",
      sessions: [SESSION],
    });

    await useWorkbench.getState().send("生成报告");

    expect(calls).toContainEqual({
      type: "session.send",
      payload: {
        sessionId: "s1",
        text: "生成报告",
        attachments: [],
        artifactPreviewBaseUrl:
          "http://localhost:3000/assets/preview/v1/m_device/w1/",
        continuesRound: null,
      },
    });
  });

  it("reports a session that could not be opened, rather than staying empty", async () => {
    useWorkbench.setState({
      client: refusingClient("no adapter registered for 'codex'"),
      sessions: [],
      draft: { workspaceId: "w1", agentId: "codex", modelId: null, modeId: null, effortId: null },
    });

    await useWorkbench.getState().send("hello");

    expect(useWorkbench.getState().notice).toBe("no adapter registered for 'codex'");
    expect(useWorkbench.getState().sessions).toEqual([]);
  });
});

/**
 * "新会话即使没有内容也会残留在会话列表中".
 *
 * Pressing "new session" used to write one to the machine on the spot, so
 * every conversation that was opened and not used stayed in the sidebar
 * forever as another indistinguishable row called "新会话".
 */
describe("opening a new conversation", () => {
  function creatingClient() {
    const calls: string[] = [];
    const created: SessionSummary = { ...SESSION, id: "s-new", title: undefined };
    const client = {
      call: async (request: { type: string }) => {
        calls.push(request.type);
        return request.type === "session.create"
          ? ({ type: "session", data: created } as const)
          : undefined;
      },
      subscribe: async () => ({
        snapshot: { seq: 0, items: [], summary: created },
        replayed: [],
        reset: false,
      }),
      unsubscribe: async () => {},
    } as unknown as Client;
    return { client, calls };
  }

  it("tells the machine nothing until there is something to say", () => {
    const { client, calls } = creatingClient();
    useWorkbench.setState({ client, sessions: [], workspaces: [], activeWorkspaceId: "w1" });

    useWorkbench.getState().newSession();

    expect(calls).toEqual([]);
    expect(useWorkbench.getState().sessions).toEqual([]);
    expect(useWorkbench.getState().draft?.workspaceId).toBe("w1");
  });

  it("creates the session with the first message, and only once", async () => {
    const { client, calls } = creatingClient();
    useWorkbench.setState({ client, sessions: [], activeWorkspaceId: "w1" });
    useWorkbench.getState().newSession("w1", "genet");

    await useWorkbench.getState().send("hello");
    await useWorkbench.getState().send("again");

    expect(calls.filter((type) => type === "session.create")).toHaveLength(1);
    expect(useWorkbench.getState().activeSessionId).toBe("s-new");
    expect(useWorkbench.getState().draft).toBeNull();
  });

  it("uses ready Codex when the built-in agent is unavailable", async () => {
    const { client } = creatingClient();
    const sent: Array<{ type: string; payload?: { agentId?: string } }> = [];
    const recording = {
      ...client,
      call: async (request: { type: string; payload?: { agentId?: string } }) => {
        sent.push(request);
        return request.type === "session.create"
          ? ({ type: "session", data: { ...SESSION, id: "s-new", agentId: "codex" } } as const)
          : undefined;
      },
    } as unknown as Client;
    const agents = [
      {
        id: "genet",
        builtin: true,
        probe: { state: "notInstalled" },
        catalog: { models: [] },
      },
      {
        id: "codex",
        builtin: false,
        probe: { state: "ready" },
        catalog: { models: [{ id: "gpt-5.6-sol" }] },
      },
    ] as AgentInfo[];
    useWorkbench.setState({
      client: recording,
      agents,
      sessions: [],
      activeWorkspaceId: "w1",
    });
    useWorkbench.getState().newSession("w1");

    await useWorkbench.getState().send("hello");

    expect(sent.find((request) => request.type === "session.create")?.payload?.agentId).toBe(
      "codex",
    );
  });

  it("lets an external Agent use its own default even when discovery returned no models", () => {
    const external = {
      id: "opencode",
      label: "OpenCode",
      builtin: false,
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
      catalog: {
        models: [],
        modes: [],
        commands: [],
        defaultModel: undefined,
        defaultMode: undefined,
        defaultEffort: undefined,
      },
    } as AgentInfo;
    expect(defaultAgent([external])?.id).toBe("opencode");

    const catalogued = {
      ...external,
      id: "codex",
      label: "Codex",
      catalog: {
        ...external.catalog,
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoning: true, efforts: [] }],
      },
    } as AgentInfo;
    expect(defaultAgent([external, catalogued])?.id).toBe("codex");

    const unconfiguredGenet = {
      ...external,
      id: "genet",
      builtin: true,
    } as AgentInfo;
    expect(defaultAgent([unconfiguredGenet])).toBeUndefined();
  });

  it("carries the model chosen in the empty chat into the session it becomes", async () => {
    const { client } = creatingClient();
    const sent: unknown[] = [];
    const recording = {
      ...client,
      call: async (request: { type: string; payload?: unknown }) => {
        sent.push(request);
        return request.type === "session.create"
          ? ({ type: "session", data: { ...SESSION, id: "s-new" } } as const)
          : undefined;
      },
    } as unknown as Client;
    useWorkbench.setState({ client: recording, sessions: [], activeWorkspaceId: "w1" });
    useWorkbench.getState().newSession("w1", "genet");

    await useWorkbench.getState().setModel("opus");
    await useWorkbench.getState().send("hello");

    expect(sent).toContainEqual({
      type: "session.create",
      payload: {
        workspaceId: "w1",
        agentId: "genet",
        modelId: "opus",
        modeId: null,
        title: null,
      },
    });
  });

  it("stays with the agent the user is already talking to", () => {
    const { client } = creatingClient();
    useWorkbench.setState({
      client,
      sessions: [{ ...SESSION, agentId: "claude" }],
      activeSessionId: "s1",
      activeWorkspaceId: "w1",
    });

    useWorkbench.getState().newSession();

    expect(useWorkbench.getState().draft?.agentId).toBe("claude");
  });

  it("leaves no second 新会话 tab behind once it is a real conversation", async () => {
    const { client } = creatingClient();
    useWorkbench.setState({ client, sessions: [], activeWorkspaceId: "w1" });
    useWorkbench.getState().newSession("w1", "genet");

    await useWorkbench.getState().send("hello");

    expect(useWorkbench.getState().tabs.map((tab) => tab.id)).toEqual(["chat:s-new"]);
  });
});

/** "会话没有删除和重命名功能" — both go through the daemon and come back here. */
describe("renaming and deleting a conversation", () => {
  function answering(reply: (type: string) => unknown) {
    const asked: string[] = [];
    return {
      asked,
      client: {
        call: async (request: { type: string }) => {
          asked.push(request.type);
          return reply(request.type);
        },
        subscribe: async () => ({
          snapshot: { seq: 0, items: [], summary: SESSION },
          replayed: [],
          reset: false,
        }),
        unsubscribe: async () => {},
      } as unknown as Client,
    };
  }

  it("shows the name the machine stored, in the list and on the tab", async () => {
    const { client } = answering((type) =>
      type === "session.rename" ? { type: "session", data: { ...SESSION, title: "发布收尾" } } : undefined,
    );
    useWorkbench.setState({
      client,
      tabs: [{ id: "chat:s1", kind: "chat", title: "新会话", sessionId: "s1" }],
    });

    await useWorkbench.getState().renameSession("s1", "  发布收尾  ");

    expect(useWorkbench.getState().sessions[0]?.title).toBe("发布收尾");
    expect(useWorkbench.getState().tabs[0]?.title).toBe("发布收尾");
  });

  it("does not ask the machine to call a session nothing", async () => {
    const { client, asked } = answering(() => undefined);
    useWorkbench.setState({ client });

    await useWorkbench.getState().renameSession("s1", "   ");

    expect(asked).toEqual([]);
  });

  it("takes the row, its tab and the open conversation with it", async () => {
    const { client, asked } = answering(() => undefined);
    useWorkbench.setState({
      client,
      activeSessionId: "s1",
      tabs: [{ id: "chat:s1", kind: "chat", title: "新会话", sessionId: "s1" }],
      activeTabId: "chat:s1",
    });

    await useWorkbench.getState().deleteSession("s1");

    expect(asked).toContain("session.delete");
    expect(useWorkbench.getState().sessions).toEqual([]);
    expect(useWorkbench.getState().tabs).toEqual([]);
    expect(useWorkbench.getState().activeSessionId).toBeNull();
  });
});

/**
 * A daemon answers one request per connection at a time and drops the whole
 * connection once too many go unanswered. Both of the ways this store used to
 * outrun it ended the same way: a turn cut off mid-flight, and a person told
 * only that the outcome was unknown.
 */
describe("asking the machine about rounds", () => {
  function counting() {
    let inFlight = 0;
    let peak = 0;
    const waiting: (() => void)[] = [];
    const client = {
      call: async (request: { type: string; payload: { roundId?: string } }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => waiting.push(resolve));
        inFlight -= 1;
        if (request.type !== "round.trunk.list") return undefined;
        return {
          type: "roundLayer",
          data: {
            round: {
              roundId: request.payload.roundId,
              userItemId: "u1",
              startedAtMs: 1,
              endedAtMs: 2,
              outcome: "completed",
              trunkCount: 0,
            },
            trunks: [],
          },
        };
      },
    } as unknown as Client;
    return {
      client,
      peak: () => peak,
      // Answers everything, whether it arrived one at a time or all at once,
      // so an unserialized store fails on the count rather than on a timeout.
      settle: async () => {
        for (let step = 0; step < 40; step += 1) {
          while (waiting.length > 0) waiting.shift()?.();
          await Promise.resolve();
          await Promise.resolve();
        }
      },
    };
  }

  it("reads one round at a time however many panels want one at once", async () => {
    const { client, peak, settle } = counting();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const reads = ["r1", "r2", "r3", "r4", "r5", "r6"].map((round) =>
      useWorkbench.getState().loadRound(round),
    );
    await settle();
    await Promise.all(reads);

    expect(peak()).toBe(1);
  });

  it("owes one more read after a burst, not one per event in it", async () => {
    let onEvent: ((event: SequencedEvent) => void) | null = null;
    const fire = (event: SequencedEvent) => onEvent?.(event);
    let asked = 0;
    const held: (() => void)[] = [];
    let holding = true;
    const client = {
      subscribe: async (
        _sessionId: string,
        handlers: { onEvent: (event: SequencedEvent) => void },
      ) => {
        onEvent = handlers.onEvent;
        return {
          snapshot: { seq: 0, items: [], summary: SESSION },
          replayed: [],
          reset: false,
        };
      },
      unsubscribe: async () => {},
      call: async () => {
        asked += 1;
        if (holding) await new Promise<void>((resolve) => held.push(resolve));
        return undefined;
      },
    } as unknown as Client;

    vi.useFakeTimers();
    try {
      useWorkbench.setState({ client });
      await useWorkbench.getState().selectSession("s1");

      // A fast agent, with the machine still working on the first question.
      for (let seq = 1; seq <= 40; seq += 1) {
        fire({
          seq,
          event: {
            type: "item",
            turnId: "t1",
            item: { type: "toolCall", id: `tool${seq}`, name: "shell", status: "ok" },
          },
        } as unknown as SequencedEvent);
        await vi.advanceTimersByTimeAsync(300);
      }

      // It answers, and whatever was owed comes due. A store that kept one
      // debt per event pays out a burst here — the very shape that filled the
      // queue on the far side.
      holding = false;
      while (held.length > 0) held.shift()?.();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(asked).toBeLessThanOrEqual(3);
  });
});

describe("returning after a disconnection", () => {
  function reconnectable(close: { code: number; reason: string }) {
    let listener: ((state: string) => void) | null = null;
    const client = {
      onStateChange: (fn: (state: string) => void) => {
        listener = fn;
      },
      onNotice: () => {},
      onUpdateDownload: () => {},
      call: async () => undefined,
      lastCloseReason: close,
      failure: undefined,
    } as unknown as Client;
    return { client, go: (state: string) => listener?.(state) };
  }

  it("stops saying it is reconnecting once it has reconnected", async () => {
    const { client, go } = reconnectable({ code: 1000, reason: "channel receive queue exceeded" });
    await useWorkbench.getState().attach(client);

    go("reconnecting");
    expect(useWorkbench.getState().notice).toContain("正在重连");

    go("ready");
    expect(useWorkbench.getState().notice).toBeNull();
  });

  it("leaves anything said since the drop alone", async () => {
    const { client, go } = reconnectable({ code: 1001, reason: "relay shutting down" });
    await useWorkbench.getState().attach(client);

    go("reconnecting");
    useWorkbench.setState({ notice: "claude 启动失败：找不到可执行文件" });
    go("ready");

    expect(useWorkbench.getState().notice).toBe("claude 启动失败：找不到可执行文件");
  });
});

describe("renaming a workspace", () => {
  it("uses the name returned by the machine", async () => {
    const workspace = { id: "w1", name: "project", root: "/tmp/project", isGitRepo: false };
    const client = {
      call: async (request: { type: string }) =>
        request.type === "workspace.rename"
          ? { type: "workspace", data: { ...workspace, name: "核心项目" } }
          : undefined,
    } as unknown as Client;
    useWorkbench.setState({ client, workspaces: [workspace] });

    await useWorkbench.getState().renameWorkspace("w1", "  核心项目  ");

    expect(useWorkbench.getState().workspaces[0]?.name).toBe("核心项目");
  });
});

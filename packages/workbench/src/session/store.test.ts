import type { AgentInfo, SequencedEvent, SessionSummary } from "@genehub/proto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { ConnectionOutcomeUnknownError } from "../protocol/client";
import { setLandingIntent } from "../location/landing";
import { defaultAgent, useWorkbench } from "./store";
import { emptyTimeline } from "./timeline";

/**
 * The daemon pushes `titleChanged` when a session is named: first from the
 * user's first message, then again if an Agent extracts a better title. A
 * client that ignores the push and only ever reads titles off
 * `session.list`/`session.create` shows "新会话" until something unrelated
 * causes a refetch — this is the bug the user reported as "标题没刷新".
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
  // The per-project Agent and model memory lives here, and jsdom keeps one
  // store for the whole file: without this, one test's choice is the next
  // test's starting point.
  localStorage.clear();
  useWorkbench.setState({
    client: null,
    agents: [],
    workspaces: [],
    sessions: [SESSION],
    activeSessionId: null,
    activeWorkspaceId: null,
    draft: null,
    addressScope: "machine",
    tabs: [],
    activeTabId: null,
    notice: null,
    restoreDraft: null,
    composerDraftInserts: [],
    // Fresh, not carried over: a test that leaves a message pending must not
    // hand it to the next one.
    timeline: emptyTimeline(),
    sessionTimelines: {},
    subscribedSessionIds: [],
    tabLimit: 16,
  });
});

describe("warm chat tabs", () => {
  it("queues composer lines for their session until the composer consumes them", () => {
    const store = useWorkbench.getState();
    store.appendComposerDraftLine("s1", "运行产物Bundle：`first`");
    store.appendComposerDraftLine("s2", "运行产物Bundle：`second`");

    const queued = useWorkbench.getState().composerDraftInserts;
    expect(queued.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([
      { sessionId: "s1", text: "运行产物Bundle：`first`" },
      { sessionId: "s2", text: "运行产物Bundle：`second`" },
    ]);

    useWorkbench.getState().consumedComposerDraftInsert(queued[0]!.id);
    expect(useWorkbench.getState().composerDraftInserts).toEqual([queued[1]]);
  });

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

  it("replaces a first-prompt title when the agent extracts a better one", async () => {
    const { client, fire } = stubClient();
    useWorkbench.setState({ client });
    await useWorkbench.getState().selectSession("s1");

    fire({ seq: 1, sessionId: "s1", event: { type: "titleChanged", title: "Fix the login redirect" } });
    fire({ seq: 2, sessionId: "s1", event: { type: "titleChanged", title: "修复登录跳转" } });

    expect(useWorkbench.getState().sessions.find((s) => s.id === "s1")?.title).toBe("修复登录跳转");
    expect(useWorkbench.getState().tabs.find((t) => t.sessionId === "s1")?.title).toBe("修复登录跳转");
  });
});

/**
 * The daemon does not echo the user's own message until the agent process is up
 * and the prompt handed over, which is seconds for a cold third-party CLI. Until
 * this existed, the text left the composer and the conversation stayed empty for
 * the whole of that wait — the report was "发送后消息不出现，状态也不对".
 */
describe("a message that has been sent and not yet confirmed", () => {
  function deferred<T>() {
    let settle!: { resolve(value: T): void; reject(error: unknown): void };
    const promise = new Promise<T>((resolve, reject) => {
      settle = { resolve, reject };
    });
    return { promise, ...settle };
  }

  /**
   * Lets `send` reach the daemon. The placeholder is written before the first
   * await, but `session.send` itself goes out one turn of the microtask queue
   * later — which is the whole point: the bubble does not wait for it.
   */
  const handedOver = () => new Promise((resolve) => setTimeout(resolve, 0));

  function sendingClient() {
    let onEvent: ((event: SequencedEvent) => void) | null = null;
    const calls: { request: { type: string; payload?: { text?: string } }; settle: ReturnType<typeof deferred<unknown>> }[] = [];
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
      call: (request: { type: string; payload?: { text?: string } }) => {
        const settle = deferred<unknown>();
        calls.push({ request, settle });
        return settle.promise;
      },
    } as unknown as Client;
    return {
      client,
      calls,
      sends: () => calls.filter((call) => call.request.type === "session.send"),
      fire: (event: SequencedEvent) => onEvent?.(event),
    };
  }

  it("is on screen before the daemon has answered, and replaced by the echo", async () => {
    const { client, sends, fire } = sendingClient();
    useWorkbench.setState({ client });
    await useWorkbench.getState().selectSession("s1");

    const inFlight = useWorkbench.getState().send("重构存储层");
    // Synchronously, before anything has left this machine.
    expect(useWorkbench.getState().timeline.pending?.text).toBe("重构存储层");
    expect(useWorkbench.getState().timeline.pending?.error).toBeNull();
    await handedOver();

    // The real item arrives before the reply, which is the order the daemon
    // publishes in; the placeholder must go now rather than sit beside it.
    fire({
      seq: 1,
      sessionId: "s1",
      event: {
        type: "item",
        turnId: "t1",
        item: { type: "userMessage", id: "u1", text: "重构存储层", attachments: [] },
      },
    } as unknown as SequencedEvent);
    expect(useWorkbench.getState().timeline.pending).toBeNull();
    expect(useWorkbench.getState().timeline.items).toHaveLength(1);
    expect(useWorkbench.getState().timeline.status).toBe("running");

    sends()[0]!.settle.resolve({ type: "ok" });
    await inFlight;
    expect(useWorkbench.getState().timeline.pending).toBeNull();
  });

  it("clears on the reply too, so a lost event cannot leave a bubble behind", async () => {
    const { client, sends } = sendingClient();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const inFlight = useWorkbench.getState().send("跑一下测试");
    expect(useWorkbench.getState().timeline.pending).not.toBeNull();
    await handedOver();
    sends()[0]!.settle.resolve({ type: "ok" });
    await inFlight;

    expect(useWorkbench.getState().timeline.pending).toBeNull();
    expect(useWorkbench.getState().timeline.status).toBe("running");
  });

  it("parks the placeholder on a draft before the session exists", () => {
    const { client } = sendingClient();
    useWorkbench.setState({
      client,
      activeSessionId: null,
      draft: {
        workspaceId: "w1",
        agentId: "genet",
        modelId: null,
        modeId: null,
        effortId: null,
        runtimeValues: {},
      },
    });

    void useWorkbench.getState().send("新开一场");

    expect(useWorkbench.getState().timeline.pending?.text).toBe("新开一场");
    expect(useWorkbench.getState().timeline.pending?.error).toBeNull();
  });

  it("refuses a second send instead of earning the daemon's refusal", async () => {
    const { client, sends } = sendingClient();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const first = useWorkbench.getState().send("第一条");
    await useWorkbench.getState().send("第二条");
    await handedOver();

    expect(sends()).toHaveLength(1);
    expect(useWorkbench.getState().timeline.pending?.text).toBe("第一条");
    sends()[0]!.settle.resolve({ type: "ok" });
    await first;
  });

  it("keeps a definitely failed message where it can be retried unchanged", async () => {
    const { client, sends } = sendingClient();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const inFlight = useWorkbench.getState().send("启动 Cursor 试试");
    await handedOver();
    sends()[0]!.settle.reject(new Error("cursor-agent is not installed"));
    await inFlight;

    const failed = useWorkbench.getState().timeline.pending;
    expect(failed?.text).toBe("启动 Cursor 试试");
    expect(failed?.error).toBe("cursor-agent is not installed");
    expect(useWorkbench.getState().notice).toBe("cursor-agent is not installed");

    const retried = useWorkbench.getState().retryPending();
    await handedOver();
    expect(sends()).toHaveLength(2);
    expect(sends()[1]!.request.payload?.text).toBe("启动 Cursor 试试");
    sends()[1]!.settle.resolve({ type: "ok" });
    await retried;
  });

  it("does not call a lost connection a failed send", async () => {
    const { client, sends } = sendingClient();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const inFlight = useWorkbench.getState().send("提交一下");
    await handedOver();
    sends()[0]!.settle.reject(new ConnectionOutcomeUnknownError());
    await inFlight;

    // The prompt may well have been taken. Calling this a failure would put a
    // second bubble next to the real one as soon as the replay lands.
    const pending = useWorkbench.getState().timeline.pending;
    expect(pending?.text).toBe("提交一下");
    expect(pending?.error).toBeNull();
  });

  it("lets a new message through while a failed one is still on screen", async () => {
    const { client, sends } = sendingClient();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const failed = useWorkbench.getState().send("第一次");
    await handedOver();
    sends()[0]!.settle.reject(new Error("nope"));
    await failed;
    expect(useWorkbench.getState().timeline.pending?.error).toBe("nope");

    // Typing something else instead of retrying used to be swallowed by the
    // in-flight guard, which counted a failure as a message still on its way.
    const second = useWorkbench.getState().send("第二次");
    await handedOver();
    expect(sends()).toHaveLength(2);
    expect(useWorkbench.getState().timeline.pending?.text).toBe("第二次");
    expect(useWorkbench.getState().timeline.pending?.error).toBeNull();
    sends()[1]!.settle.resolve({ type: "ok" });
    await second;
  });

  it("returns the text to the composer when there was no conversation to send into", async () => {
    const client = {
      call: async () => ({ type: "error" }),
      unsubscribe: async () => {},
    } as unknown as Client;
    // A draft, not a session: `session.create` is what fails here, so there is
    // no timeline to hold a failed bubble.
    useWorkbench.setState({
      client,
      activeSessionId: null,
      draft: {
        workspaceId: "w1",
        agentId: "genet",
        modelId: null,
        modeId: null,
        effortId: null,
        runtimeValues: {},
      },
    });

    await useWorkbench.getState().send("开个新会话说这句");

    expect(useWorkbench.getState().restoreDraft).toEqual({
      text: "开个新会话说这句",
      attachments: [],
    });
    expect(useWorkbench.getState().timeline.pending).toBeNull();
  });

  it("hands a failed message back to the composer when it is to be edited", async () => {
    const { client, sends } = sendingClient();
    useWorkbench.setState({ client, activeSessionId: "s1" });

    const inFlight = useWorkbench
      .getState()
      .send("改这里", [{ name: "shot.png", mime: "image/png", dataBase64: "AAA" }]);
    await handedOver();
    sends()[0]!.settle.reject(new Error("nope"));
    await inFlight;

    useWorkbench.getState().editPending();

    expect(useWorkbench.getState().timeline.pending).toBeNull();
    expect(useWorkbench.getState().restoreDraft).toEqual({
      text: "改这里",
      attachments: [{ name: "shot.png", mime: "image/png", dataBase64: "AAA" }],
    });

    useWorkbench.getState().restoredDraft();
    expect(useWorkbench.getState().restoreDraft).toBeNull();
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
  it("omits the target when the current Agent should use its native Fork", async () => {
    const calls: unknown[] = [];
    const client = {
      call: async (request: unknown) => {
        calls.push(request);
        return { type: "session", data: { ...SESSION, id: "s-native" } };
      },
      subscribe: async () => ({
        snapshot: {
          seq: 0,
          items: [],
          pendingPermissions: [],
          summary: { ...SESSION, id: "s-native" },
        },
        replayed: [],
        reset: false,
      }),
      unsubscribe: async () => {},
    } as unknown as Client;
    useWorkbench.setState({ client, activeSessionId: SESSION.id });

    await useWorkbench.getState().forkSession("turn-native");

    expect(calls[0]).toEqual({
      type: "session.fork",
      payload: { sessionId: SESSION.id, turnId: "turn-native" },
    });
  });

  it("asks for the exact turn and opens the independent session returned by the daemon", async () => {
    const forked: SessionSummary = {
      ...SESSION,
      id: "s-fork",
      workspaceId: "w2",
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

    await useWorkbench.getState().forkSession("turn-7", {
      agentId: "claude",
      workspaceId: "w2",
    });

    expect(calls).toContainEqual({
      type: "session.fork",
      payload: {
        sessionId: SESSION.id,
        turnId: "turn-7",
        target: { agentId: "claude", workspaceId: "w2" },
      },
    });
    expect(useWorkbench.getState().sessions[0]).toEqual(forked);
    expect(useWorkbench.getState().activeSessionId).toBe(forked.id);
    expect(useWorkbench.getState().activeWorkspaceId).toBe("w2");
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

  it("does not teach Agents a deployment-bound Preview URL prefix", async () => {
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
      workspaces: [{
        id: "w1",
        name: "suite",
        root: "/srv/product",
        isGitRepo: true,
        workspaceFile: "/srv/suite.code-workspace",
        folders: [
          { name: "Product", root: "/srv/product", rootHandle: "r_product" },
          { name: "Docs", root: "/srv/docs", rootHandle: "r_docs" },
        ],
      }],
    });

    await useWorkbench.getState().send("生成报告");

    expect(calls).toContainEqual({
      type: "session.send",
      payload: {
        sessionId: "s1",
        text: "生成报告",
        attachments: [],
        artifactPreviewBaseUrl: null,
        continuesRound: null,
      },
    });
  });

  it("reports a session that could not be opened, rather than staying empty", async () => {
    useWorkbench.setState({
      client: refusingClient("no adapter registered for 'codex'"),
      sessions: [],
      draft: {
        workspaceId: "w1",
        agentId: "codex",
        modelId: null,
        modeId: null,
        effortId: null,
        runtimeValues: {},
      },
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
        runtimeValues: {},
        title: null,
        // The workbench opens a session at the workspace root; naming a
        // directory inside it is something only the CLI does today.
        cwd: null,
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

/**
 * "选择思考强度或者权限感觉有延时，是有网络通讯吗？"
 *
 * There is one, and it is unavoidable — the daemon owns the value and an ACP
 * agent may take a round trip of its own to accept it. What is avoidable is
 * waiting for it before the radio the finger is on moves.
 */
describe("switching a runtime axis mid-conversation", () => {
  function held() {
    let settle: (() => void) | null = null;
    const client = {
      call: () =>
        new Promise((resolve) => {
          settle = () => resolve({ type: "ok" });
        }),
    } as unknown as Client;
    useWorkbench.setState({ client, sessions: [SESSION], activeSessionId: "s1" });
    return { release: () => settle?.() };
  }

  it("shows the new level before the machine has answered", async () => {
    const { release } = held();

    const sent = useWorkbench.getState().setEffort("high");
    expect(useWorkbench.getState().timeline.effortId).toBe("high");

    release();
    await sent;
    expect(useWorkbench.getState().timeline.effortId).toBe("high");
  });

  it("puts the old one back when the machine refuses", async () => {
    const client = {
      call: () => Promise.reject(new Error("agent rejected the mode")),
    } as unknown as Client;
    useWorkbench.setState({
      client,
      sessions: [SESSION],
      activeSessionId: "s1",
      timeline: { ...emptyTimeline(), modeId: "read-only" },
    });

    await useWorkbench.getState().setMode("full-access");

    expect(useWorkbench.getState().timeline.modeId).toBe("read-only");
    expect(useWorkbench.getState().notice).toBe("agent rejected the mode");
  });

  it("leaves a later choice alone when an earlier one fails", async () => {
    const outcomes: Array<(value: unknown) => void> = [];
    const rejects: Array<(reason: Error) => void> = [];
    const client = {
      call: () =>
        new Promise((resolve, reject) => {
          outcomes.push(resolve);
          rejects.push(reject);
        }),
    } as unknown as Client;
    useWorkbench.setState({ client, sessions: [SESSION], activeSessionId: "s1" });

    const first = useWorkbench.getState().setEffort("low");
    const second = useWorkbench.getState().setEffort("high");
    rejects[0]!(new Error("too slow"));
    await first;
    outcomes[1]!({ type: "ok" });
    await second;

    expect(useWorkbench.getState().timeline.effortId).toBe("high");
  });

  it("switches a generic runtime axis optimistically with opaque ids", async () => {
    const calls: unknown[] = [];
    const client = {
      call: async (request: unknown) => {
        calls.push(request);
        return { type: "ok" };
      },
    } as unknown as Client;
    useWorkbench.setState({ client, sessions: [SESSION], activeSessionId: "s1" });

    await useWorkbench.getState().setRuntimeAxis("fast", "max");

    expect(useWorkbench.getState().timeline.runtimeValues).toEqual({ fast: "max" });
    expect(calls).toContainEqual({
      type: "session.setRuntimeAxis",
      payload: { sessionId: "s1", axisId: "fast", valueId: "max" },
    });
  });
});

/**
 * "每个工作区都要记录上一次的模型选择。新工作区就按上一次的选择走。"
 *
 * The choice is remembered in this browser, keyed by project, and the models
 * are kept under the Agent they belong to — Claude's `sonnet` is not an id
 * Codex would accept.
 */
describe("what a new conversation opens with", () => {
  const claude = {
    id: "claude",
    label: "Claude Code",
    builtin: false,
    probe: { state: "ready" },
    capabilities: { setModel: true, setEffort: true, setMode: true },
    catalog: {
      models: [
        { id: "sonnet", label: "Sonnet", reasoning: true, efforts: ["low", "high"] },
        { id: "opus", label: "Opus", reasoning: true, efforts: [] },
      ],
      modes: [],
      commands: [],
    },
  } as unknown as AgentInfo;
  const codex = {
    ...claude,
    id: "codex",
    label: "Codex",
    catalog: {
      ...claude.catalog,
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoning: true, efforts: [] }],
    },
  } as AgentInfo;

  beforeEach(() => {
    useWorkbench.setState({ agents: [claude, codex], sessions: [], workspaces: [] });
  });

  it("reopens a project with the Agent and model it was last used with", async () => {
    useWorkbench.getState().newSession("w1", "claude");
    await useWorkbench.getState().setModel("opus");

    useWorkbench.getState().newSession("w2", "codex");
    useWorkbench.getState().newSession("w1", null);

    expect(useWorkbench.getState().draft).toMatchObject({
      workspaceId: "w1",
      agentId: "claude",
      modelId: "opus",
    });
  });

  it("keeps each Agent's model to itself when the Agent changes back and forth", async () => {
    useWorkbench.getState().newSession("w1", "claude");
    await useWorkbench.getState().setModel("opus");
    useWorkbench.getState().newSession("w1", "codex");
    expect(useWorkbench.getState().draft?.modelId).toBeNull();

    await useWorkbench.getState().setModel("gpt-5.6-sol");
    useWorkbench.getState().newSession("w1", "claude");
    expect(useWorkbench.getState().draft?.modelId).toBe("opus");
  });

  it("starts an unvisited project from the last choice made anywhere", async () => {
    useWorkbench.getState().newSession("w1", "claude");
    await useWorkbench.getState().setEffort("high");
    await useWorkbench.getState().setModel("sonnet");

    useWorkbench.getState().newSession("w-fresh", null);

    expect(useWorkbench.getState().draft).toMatchObject({
      workspaceId: "w-fresh",
      agentId: "claude",
      modelId: "sonnet",
      effortId: "high",
    });
  });

  it("drops a remembered model the catalog no longer offers", async () => {
    useWorkbench.getState().newSession("w1", "claude");
    await useWorkbench.getState().setModel("opus");

    useWorkbench.setState({
      agents: [{ ...claude, catalog: { ...claude.catalog, models: [claude.catalog.models[0]!] } }],
    });
    useWorkbench.getState().newSession("w1", null);

    expect(useWorkbench.getState().draft).toMatchObject({ agentId: "claude", modelId: null });
  });

  it("still follows the conversation on screen into a project it knows nothing about", () => {
    useWorkbench.setState({
      sessions: [{ ...SESSION, workspaceId: "w9", agentId: "codex" }],
      activeSessionId: "s1",
    });

    useWorkbench.getState().newSession("w9", null);

    expect(useWorkbench.getState().draft?.agentId).toBe("codex");
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
  it("keeps older trunks in place when the live page refreshes", async () => {
    const round = {
      roundId: "r1",
      userItemId: "u1",
      startedAtMs: 1,
      endedAtMs: 0,
      outcome: "running" as const,
      trunkCount: 4,
    };
    const trunk = (index: number) => ({
      index,
      firstItemId: `t${index}`,
      blobCount: 1,
      title: `trunk ${index}`,
      batches: [],
    });
    const timeline = {
      ...emptyTimeline(),
      rounds: [round],
      roundLayers: {
        r1: { round, trunks: [trunk(0), trunk(1), trunk(2)], nextCursor: undefined },
      },
    };
    const client = {
      call: async () => ({
        type: "roundLayer",
        data: { round, trunks: [trunk(2), trunk(3)], nextCursor: "before:2" },
      }),
    } as unknown as Client;
    useWorkbench.setState({
      client,
      activeSessionId: "s1",
      timeline,
      sessionTimelines: { s1: timeline },
    });

    await useWorkbench.getState().loadRound("latest");

    expect(useWorkbench.getState().timeline.roundLayers.r1?.trunks.map(({ index }) => index)).toEqual(
      [0, 1, 2, 3],
    );
    expect(useWorkbench.getState().timeline.roundLayers.r1?.nextCursor).toBeUndefined();
  });

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
      onBackgroundProcesses: () => {},
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

  it("withdraws the connection-loss sentence once the connection is back", async () => {
    const { client, go } = reconnectable({ code: 1006, reason: "" });
    // The requests the drop took down reject the way a lost request does.
    (client as { call: unknown }).call = async () => {
      throw new ConnectionOutcomeUnknownError({ code: 1006 });
    };
    await useWorkbench.getState().attach(client);

    expect(useWorkbench.getState().notice).toContain("the connection was lost");

    go("ready");
    expect(useWorkbench.getState().notice).toBeNull();
  });

  it("keeps a failure that is not the connection speaking", async () => {
    const { client, go } = reconnectable({ code: 1006, reason: "" });
    (client as { call: unknown }).call = async () => {
      throw new Error("session.list 失败：磁盘已满");
    };
    await useWorkbench.getState().attach(client);

    expect(useWorkbench.getState().notice).toBe("session.list 失败：磁盘已满");

    go("ready");
    expect(useWorkbench.getState().notice).toBe("session.list 失败：磁盘已满");
  });
});

describe("renaming a workspace", () => {
  it("uses the name returned by the machine", async () => {
    const workspace = {
      id: "w1",
      name: "project",
      root: "/tmp/project",
      isGitRepo: false,
      folders: [{ name: "project", root: "/tmp/project", rootHandle: "r_project" }],
    };
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

describe("removing a workspace registration", () => {
  it("drops its local navigation state while keeping another workspace intact", async () => {
    const first = {
      id: "w1",
      name: "first",
      root: "/tmp/first",
      isGitRepo: false,
      folders: [{ name: "first", root: "/tmp/first", rootHandle: "r_first" }],
    };
    const second = {
      id: "w2",
      name: "second",
      root: "/tmp/second",
      isGitRepo: false,
      folders: [{ name: "second", root: "/tmp/second", rootHandle: "r_second" }],
    };
    const other = { ...SESSION, id: "s2", workspaceId: "w2" };
    const unsubscribe = vi.fn(async () => {});
    const client = {
      unsubscribe,
      call: async (request: { type: string }) => {
        if (request.type === "workspace.remove") {
          return { type: "workspaces", data: [second] };
        }
        if (request.type === "session.list") {
          return { type: "sessions", data: [other] };
        }
        return undefined;
      },
    } as unknown as Client;
    useWorkbench.setState({
      client,
      workspaces: [first, second],
      activeWorkspaceId: "w2",
      sessions: [SESSION, other],
      activeSessionId: "s2",
      tabs: [
        { id: "chat:s1", kind: "chat", title: "first", sessionId: "s1" },
        { id: "chat:s2", kind: "chat", title: "second", sessionId: "s2" },
      ],
      activeTabId: "chat:s2",
      subscribedSessionIds: ["s1", "s2"],
    });

    await useWorkbench.getState().removeWorkspace("w1");

    expect(useWorkbench.getState().workspaces).toEqual([second]);
    expect(useWorkbench.getState().sessions).toEqual([other]);
    expect(useWorkbench.getState().tabs.map((tab) => tab.id)).toEqual(["chat:s2"]);
    expect(useWorkbench.getState().activeWorkspaceId).toBe("w2");
    expect(unsubscribe).toHaveBeenCalledWith("s1");
  });
});

describe("landing from a bookmark", () => {
  it("opens the session named in the address instead of the newest one", async () => {
    const older = { ...SESSION, id: "s_old", updatedAtMs: 1 };
    const newer = { ...SESSION, id: "s_new", updatedAtMs: 9 };
    setLandingIntent({ workspaceId: "w1", sessionId: "s_old", previewPath: null });
    const client = {
      identity: { machineId: "dev_7k2" },
      onStateChange: () => () => {},
      onNotice: () => {},
      onUpdateDownload: () => {},
      onBackgroundProcesses: () => {},
      call: async (request: { type: string }) => {
        if (request.type === "workspace.list") {
          return {
            type: "workspaces",
            data: [
              {
                id: "w1",
                name: "docs",
                root: "/tmp/docs",
                isGitRepo: false,
                folders: [{ name: "docs", root: "/tmp/docs", rootHandle: "r_docs" }],
              },
            ],
          };
        }
        if (request.type === "session.list") {
          return { type: "sessions", data: [older, newer] };
        }
        if (request.type === "update.downloadState") {
          return { type: "updateDownload", data: { state: "idle" } };
        }
        return undefined;
      },
      subscribe: async () => ({
        snapshot: { seq: 0, items: [], pendingPermission: undefined, summary: older },
        replayed: [],
        reset: false,
      }),
      unsubscribe: async () => {},
    } as unknown as Client;

    await useWorkbench.getState().attach(client);

    expect(useWorkbench.getState().activeSessionId).toBe("s_old");
  });

  it("expands an 8-hex session token and restores tabs without stealing focus", async () => {
    const talk = {
      ...SESSION,
      id: "s_a1b2c3d4e5f6789012345678abcdef01",
      title: "短码会话",
      updatedAtMs: 1,
    };
    setLandingIntent({
      workspaceId: "w1",
      sessionId: "s-a1b2c3d4",
      previewPath: null,
      tabs: ["s-a1b2c3d4", "term"],
    });
    const client = {
      identity: { machineId: "m_17ef85c530554af9bb7de6c19116aff0" },
      onStateChange: () => () => {},
      onNotice: () => {},
      onUpdateDownload: () => {},
      onBackgroundProcesses: () => {},
      call: async (request: { type: string }) => {
        if (request.type === "workspace.list") {
          return {
            type: "workspaces",
            data: [
              {
                id: "w1",
                name: "docs",
                root: "/tmp/docs",
                isGitRepo: false,
                folders: [{ name: "docs", root: "/tmp/docs", rootHandle: "r_docs" }],
              },
            ],
          };
        }
        if (request.type === "session.list") {
          return { type: "sessions", data: [talk] };
        }
        if (request.type === "update.downloadState") {
          return { type: "updateDownload", data: { state: "idle" } };
        }
        return undefined;
      },
      subscribe: async () => ({
        snapshot: { seq: 0, items: [], pendingPermission: undefined, summary: talk },
        replayed: [],
        reset: false,
      }),
      unsubscribe: async () => {},
    } as unknown as Client;

    await useWorkbench.getState().attach(client);

    expect(useWorkbench.getState().activeSessionId).toBe(talk.id);
    expect(useWorkbench.getState().activeTabId).toBe(`chat:${talk.id}`);
    expect(useWorkbench.getState().tabs.map((tab) => tab.kind)).toEqual(["chat", "terminal"]);
  });

  it("refuses to guess when two sessions share an 8-hex prefix", async () => {
    const first = {
      ...SESSION,
      id: "s_a1b2c3d4e5f6789012345678abcdef01",
      updatedAtMs: 1,
    };
    const second = {
      ...SESSION,
      id: "s_a1b2c3d4ffffffffffffffffffffffff",
      updatedAtMs: 2,
    };
    setLandingIntent({ workspaceId: "w1", sessionId: "s-a1b2c3d4", previewPath: null });
    const client = {
      identity: { machineId: "m_17ef85c530554af9bb7de6c19116aff0" },
      onStateChange: () => () => {},
      onNotice: () => {},
      onUpdateDownload: () => {},
      onBackgroundProcesses: () => {},
      call: async (request: { type: string }) => {
        if (request.type === "workspace.list") {
          return {
            type: "workspaces",
            data: [
              {
                id: "w1",
                name: "docs",
                root: "/tmp/docs",
                isGitRepo: false,
                folders: [{ name: "docs", root: "/tmp/docs", rootHandle: "r_docs" }],
              },
            ],
          };
        }
        if (request.type === "session.list") {
          return { type: "sessions", data: [first, second] };
        }
        if (request.type === "update.downloadState") {
          return { type: "updateDownload", data: { state: "idle" } };
        }
        return undefined;
      },
      subscribe: async () => ({
        snapshot: { seq: 0, items: [], pendingPermission: undefined, summary: second },
        replayed: [],
        reset: false,
      }),
      unsubscribe: async () => {},
    } as unknown as Client;

    await useWorkbench.getState().attach(client);

    expect(useWorkbench.getState().notice).toBe("这个会话已经不在了。");
    expect(useWorkbench.getState().activeSessionId).not.toBe(first.id);
  });

  it("keeps a machine homepage as a new conversation in the most recent workspace", async () => {
    const older = { ...SESSION, id: "s_old", updatedAtMs: 1, workspaceId: "w1" };
    const newer = { ...SESSION, id: "s_new", updatedAtMs: 9, workspaceId: "w2" };
    setLandingIntent({ workspaceId: null, sessionId: null, previewPath: null });
    await useWorkbench.getState().attach(catalogClient([older, newer], [docsWorkspace(), docsWorkspace("w2", "app")]));

    expect(useWorkbench.getState().addressScope).toBe("machine");
    expect(useWorkbench.getState().draft?.workspaceId).toBe("w2");
    expect(useWorkbench.getState().activeSessionId).toBeNull();
  });

  it("keeps a workspace homepage as a new conversation instead of the newest session", async () => {
    const older = { ...SESSION, id: "s_old", updatedAtMs: 1 };
    const newer = { ...SESSION, id: "s_new", updatedAtMs: 9 };
    setLandingIntent({ workspaceId: "w1", sessionId: null, previewPath: null });
    await useWorkbench.getState().attach(catalogClient([older, newer]));

    expect(useWorkbench.getState().addressScope).toBe("workspace");
    expect(useWorkbench.getState().draft?.workspaceId).toBe("w1");
    expect(useWorkbench.getState().activeSessionId).toBeNull();
  });

  it("opens the workspace homepage when the sidebar picks a project", async () => {
    const newer = { ...SESSION, id: "s_new", updatedAtMs: 9 };
    useWorkbench.setState({
      client: catalogClient([SESSION, newer]),
      agents: [],
      workspaces: [docsWorkspace()],
      sessions: [SESSION, newer],
      activeWorkspaceId: "w1",
      activeSessionId: "s_new",
      addressScope: "session",
    });

    await useWorkbench.getState().selectWorkspace("w1");

    expect(useWorkbench.getState().addressScope).toBe("workspace");
    expect(useWorkbench.getState().draft?.workspaceId).toBe("w1");
    expect(useWorkbench.getState().activeSessionId).toBeNull();
  });
});

function docsWorkspace(id = "w1", name = "docs") {
  return {
    id,
    name,
    root: `/tmp/${name}`,
    isGitRepo: false,
    folders: [{ name, root: `/tmp/${name}`, rootHandle: `r_${name}` }],
  };
}

function catalogClient(
  sessions: SessionSummary[],
  workspaces: ReturnType<typeof docsWorkspace>[] = [docsWorkspace()],
) {
  return {
    identity: { machineId: "m_17ef85c530554af9bb7de6c19116aff0" },
    onStateChange: () => () => {},
    onNotice: () => {},
    onUpdateDownload: () => {},
    onBackgroundProcesses: () => {},
    call: async (request: { type: string }) => {
      if (request.type === "workspace.list") {
        return { type: "workspaces", data: workspaces };
      }
      if (request.type === "session.list") {
        return { type: "sessions", data: sessions };
      }
      if (request.type === "update.downloadState") {
        return { type: "updateDownload", data: { state: "idle" } };
      }
      return undefined;
    },
    subscribe: async () => ({
      snapshot: {
        seq: 0,
        items: [],
        pendingPermission: undefined,
        summary: sessions[0] ?? SESSION,
      },
      replayed: [],
      reset: false,
    }),
    unsubscribe: async () => {},
  } as unknown as Client;
}

describe("batchGet version-skew fallback", () => {
  const TRUNK = {
    summary: {
      index: 0,
      first_item_id: "i0",
      blob_count: 0,
      title: "阶段 0",
      batches: [],
    },
    batches: [],
  } as never;

  function skewedClient() {
    const calls: string[] = [];
    const client = {
      call: async (request: { type: string; payload?: unknown }) => {
        calls.push(request.type);
        if (request.type === "round.trunk.batchGet" || request.type === "blob.batchGet") {
          throw new Error(
            `invalid RPC operation body: unknown variant \`${request.type}\`, expected one of \`round.trunk.get\`, \`blob.get\``,
          );
        }
        if (request.type === "round.trunk.get") return { type: "roundTrunk", data: TRUNK };
        if (request.type === "blob.get") {
          return { type: "blob", data: { id: "b1", kind: "toolCall", value: { n: 1 } } };
        }
        return undefined;
      },
    } as unknown as Client;
    return { client, calls };
  }

  it("falls back to one-by-one fetches when the daemon predates batchGet", async () => {
    const { client, calls } = skewedClient();
    useWorkbench.setState({ client });

    const trunks = await useWorkbench
      .getState()
      .fetchTrunkDetails("s1", [{ roundId: "r1", trunkIndex: 0 }]);
    expect(trunks).toHaveLength(1);
    expect(calls).toEqual(["round.trunk.batchGet", "round.trunk.get"]);
    expect(
      useWorkbench.getState().sessionTimelines["s1"]?.roundTrunks["r1:0"],
    ).toBeDefined();

    // The refusal is remembered: the next fill goes straight to single gets.
    await useWorkbench
      .getState()
      .fetchBlobPayloads("s1", [{ id: "b1", kind: "toolCall" } as never]);
    expect(calls).toEqual(["round.trunk.batchGet", "round.trunk.get", "blob.get"]);
    expect(useWorkbench.getState().sessionTimelines["s1"]?.blobs["b1"]).toBeDefined();
    // Expected skew is absorbed, not surfaced as an error notice.
    expect(useWorkbench.getState().notice).toBeNull();
  });

  it("keeps using the batch RPC when the daemon answers it", async () => {
    const calls: string[] = [];
    const client = {
      call: async (request: { type: string }) => {
        calls.push(request.type);
        if (request.type === "round.trunk.batchGet") {
          return { type: "roundTrunks", data: [TRUNK] };
        }
        return undefined;
      },
    } as unknown as Client;
    useWorkbench.setState({ client });

    const trunks = await useWorkbench
      .getState()
      .fetchTrunkDetails("s1", [{ roundId: "r1", trunkIndex: 0 }]);
    expect(trunks).toHaveLength(1);
    expect(calls).toEqual(["round.trunk.batchGet"]);
  });

  it("reports real failures instead of falling back", async () => {
    const calls: string[] = [];
    const client = {
      call: async (request: { type: string }) => {
        calls.push(request.type);
        throw new Error("connection lost");
      },
    } as unknown as Client;
    useWorkbench.setState({ client });

    const trunks = await useWorkbench
      .getState()
      .fetchTrunkDetails("s1", [{ roundId: "r1", trunkIndex: 0 }]);
    expect(trunks).toBeNull();
    expect(calls).toEqual(["round.trunk.batchGet"]);
    expect(useWorkbench.getState().notice).toContain("connection lost");
  });
});

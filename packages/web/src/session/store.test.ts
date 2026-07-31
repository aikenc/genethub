import type { SequencedEvent, SessionSummary } from "@genehub/proto";
import { beforeEach, describe, expect, it } from "vitest";

import type { Client } from "../protocol/client";
import { useWorkbench } from "./store";

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

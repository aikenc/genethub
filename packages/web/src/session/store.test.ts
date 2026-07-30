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
    sessions: [SESSION],
    activeSessionId: null,
    tabs: [],
    activeTabId: null,
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
    });

    await useWorkbench.getState().createSession("w1", "codex");

    expect(useWorkbench.getState().notice).toBe("no adapter registered for 'codex'");
    expect(useWorkbench.getState().sessions).toEqual([]);
  });
});

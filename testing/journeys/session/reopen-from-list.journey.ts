import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.reopen-from-list",
    title: "A session found in the list can be reopened and continued",
    oracle: "session.list finds the closed tab; subscribe snapshot has history; session.get grows after the next prompt",
    catches: ["close deletes the session"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "First answer." });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Remember the number 7.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      await opened.client.unsubscribe(sessionId);
      await opened.client.call({ type: "session.close", payload: { sessionId } });
      const listed = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(listed?.type === "sessions", "session.list failed");
      const found = listed?.type === "sessions" ? listed.data.find((item) => item.id === sessionId) : undefined;
      t.assertions.assert(Boolean(found), "closed session vanished from the list");
      t.assertions.assert(Boolean(found?.title), "a session with no title is unfindable");
      const { snapshot } = await opened.client.subscribe(found!.id, {
        onEvent: () => {},
        onResync: () => {},
      });
      const history = (snapshot as { items?: unknown[] } | null)?.items ?? [];
      t.assertions.assert(history.length > 0, "reopening should show what was said before");
      const before = await opened.client.call({ type: "session.get", payload: { sessionId: found!.id } });
      const beforeCount = before?.type === "snapshot" ? before.data.items.length : 0;
      opened.mock.script({ text: "It was 7." });
      await t.flows.main.sendPrompt(opened.client, found!.id, "What number did I ask you to remember?");
      await t.tools.waitUntil(async () => {
        const after = await opened.client.call({ type: "session.get", payload: { sessionId: found!.id } });
        return after?.type === "snapshot" && after.data.items.length > beforeCount;
      }, 45_000);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

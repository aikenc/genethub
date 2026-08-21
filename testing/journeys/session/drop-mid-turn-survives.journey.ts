import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.drop-mid-turn-survives",
    title: "A client that drops mid-turn gets the missing events when it returns",
    oracle: "a second Client can leave after turnStarted; session.get still shows the completed turn",
    catches: ["agent stops when a watcher disconnects"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const watcher = await t.flows.main.openSecondClient(opened);
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({
        text: "A reply that keeps arriving after the client has gone.",
        delayMs: 800,
      });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const ownerEvents = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.attachEventLog(watcher, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Say something long.");
      await t.tools.waitUntil(() => ownerEvents.some((item) => item.type === "turnStarted"), 20_000);
      watcher.close();
      await t.tools.waitUntil(() => ownerEvents.some((item) => item.type === "turnCompleted"), 45_000);
      const returning = await t.flows.main.openSecondClient(opened, "testctl-3");
      try {
        const { snapshot } = await returning.subscribe(sessionId, {
          onEvent: () => {},
          onResync: () => {},
        });
        const items = (snapshot as { items?: unknown[] } | null)?.items ?? [];
        t.assertions.assert(items.length > 0, "reopening after a drop lost the turn");
      } finally {
        returning.close();
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

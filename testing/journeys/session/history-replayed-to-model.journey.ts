import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.history-replayed-to-model",
    title: "Conversation history is replayed to the model on the next turn",
    oracle: "the second mock LLM request contains both user turns",
    catches: ["each turn is a fresh conversation"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "first" }, { text: "second" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "one");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      await t.flows.main.sendPrompt(opened.client, sessionId, "two");
      await t.tools.waitUntil(
        () => events.filter((item) => item.type === "turnCompleted").length >= 2,
        45_000,
      );
      t.assertions.assert(opened.mock.requests.length >= 2, `only ${opened.mock.requests.length} model calls`);
      const transcript = JSON.stringify(opened.mock.requests[1]);
      t.assertions.assert(
        transcript.includes("one") && transcript.includes("two"),
        "the second call must carry the first exchange",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

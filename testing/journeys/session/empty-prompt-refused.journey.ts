import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.empty-prompt-refused",
    title: "An empty prompt is refused before it reaches the model",
    oracle: "session.send of whitespace is badRequest and mock LLM request count stays 0",
    catches: ["blank prompt billed", "model called anyway"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.assertions.expectProtocolCode(
        () => t.flows.main.sendPrompt(opened.client, sessionId, "   "),
        "badRequest",
      );
      t.assertions.assert(opened.mock.requests.length === 0, "empty prompt reached the model");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

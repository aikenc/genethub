import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.mid-turn-refused",
    title: "A prompt arriving mid-turn is refused rather than interleaved",
    oracle: "second session.send is conflict; first turn still completes; a later send is accepted",
    catches: ["two send buttons interleave one conversation"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "Working on it.", delayMs: 800 }, { text: "Ready." });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "First.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 20_000);
      await t.assertions.expectProtocolCode(
        () => t.flows.main.sendPrompt(opened.client, sessionId, "Second."),
        "conflict",
      );
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Third.");
      await t.tools.waitUntil(
        () => events.filter((item) => item.type === "turnCompleted").length >= 2,
        45_000,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

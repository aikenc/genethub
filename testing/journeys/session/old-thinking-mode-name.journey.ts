import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.old-thinking-mode-name",
    title: "The built-in agent still answers to the old name for thinking",
    oracle: "session.setMode high is accepted on genet",
    catches: ["old mode axis silently dropped"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "ok" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "hello");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      await opened.client.call({ type: "session.setMode", payload: { sessionId, modeId: "high" } });
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

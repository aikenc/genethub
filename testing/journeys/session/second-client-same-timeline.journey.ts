import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.second-client-same-timeline",
    title: "A second client sees the same session as the first",
    oracle: "two canonical Clients both observe turnCompleted on one session",
    catches: ["per-connection timeline"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const second = await t.flows.main.openSecondClient(opened);
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "shared" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const firstEvents = await t.flows.main.attachEventLog(opened.client, sessionId);
      const secondEvents = await t.flows.main.attachEventLog(second, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Say something.");
      await t.tools.waitUntil(() => firstEvents.some((item) => item.type === "turnCompleted"), 45_000);
      await t.tools.waitUntil(() => secondEvents.some((item) => item.type === "turnCompleted"), 45_000);
    } finally {
      second.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

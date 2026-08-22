import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.thinking-effort",
    title: "Switching the thinking level takes effect on the built-in agent",
    oracle: "session.setEffort stores effortId and does not write it as modeId",
    catches: ["thinking rides on mode"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
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
      await opened.client.call({ type: "session.setEffort", payload: { sessionId, effortId: "low" } });
      const got = await opened.client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(got?.type === "snapshot", `session.get returned ${got?.type}`);
      t.assertions.assert(
        got?.type === "snapshot" && got.data.summary.effortId === "low",
        `effortId is ${got?.type === "snapshot" ? got.data.summary.effortId : "?"}`,
      );
      t.assertions.assert(
        got?.type === "snapshot" && (got.data.summary.modeId == null || got.data.summary.modeId === ""),
        "thinking was stored as a mode",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

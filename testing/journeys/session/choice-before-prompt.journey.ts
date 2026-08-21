import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.choice-before-prompt",
    title: "A choice made before the first prompt is announced and not only stored",
    oracle: "session.setEffort before any send is visible on session.get; unknown levels are refused",
    catches: ["picker springs back", "unknown effort stored"],
    tags: ["core", "session", "parity"],
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
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await opened.client.call({ type: "session.setEffort", payload: { sessionId, effortId: "high" } });
      await t.tools.waitUntil(() => events.some((item) => item.type === "effortChanged"), 10_000);
      const got = await opened.client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(
        got?.type === "snapshot" && got.data.summary.effortId === "high",
        "the choice was not stored",
      );
      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "session.setEffort",
            payload: { sessionId, effortId: "as-hard-as-you-can" },
          }),
        "badRequest",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

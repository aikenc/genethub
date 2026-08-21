import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.unknown-tool-renders",
    title: "An unknown tool still renders instead of disappearing",
    oracle: "a mock teleport tool call is visible in the session event stream",
    catches: ["unrecognized tool dropped from the timeline"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script(
        { tool: { name: "teleport", arguments: { destination: "mars" } } },
        { text: "Could not." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Teleport.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      const blob = JSON.stringify(events);
      t.assertions.assert(blob.includes("teleport"), "the unrecognised call is not dropped");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

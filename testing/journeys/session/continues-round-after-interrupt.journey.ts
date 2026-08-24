import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.continues-round-after-interrupt",
    title: "A message naming continuesRound after an interrupt still runs normally",
    oracle: "after turnCanceled, send with a guessed continuesRound still completes",
    catches: ["interrupt wedges the next send"],
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
      opened.mock.script(
        { text: "This is a long answer that arrives one piece at a time.", delayMs: 800 },
        { text: "Picking up from there." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Count from 1 to 500, one number per line, with a short comment on each.",
      );
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 20_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCanceled"), 30_000);
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "keep going",
        "r_whatever_the_ui_remembered",
      );
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

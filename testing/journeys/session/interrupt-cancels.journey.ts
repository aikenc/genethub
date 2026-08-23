import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.interrupt-cancels",
    title: "Interrupting a running turn ends it as canceled",
    oracle: "session.interrupt yields turnCanceled, not turnCompleted",
    catches: ["stop button completes the turn"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({
        text: "This is a long answer that arrives one piece at a time.",
        delayMs: 800,
      });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Count from 1 to 500, one number per line, with a short comment on each.",
      );
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 20_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnCanceled" || item.type === "turnCompleted" || item.type === "turnFailed"),
        30_000,
      );
      t.assertions.assert(
        events.some((item) => item.type === "turnCanceled"),
        `stopped turn did not cancel: ${events.map((item) => item.type).join(",")}`,
      );
      t.assertions.assert(
        !events.some((item) => item.type === "turnCompleted"),
        "stopped turn still completed",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.reasoning-only-recovery",
    title: "A reasoning-only model response never silently completes a user request",
    oracle: "one bounded retry produces a visible answer, and repeated empty answers fail visibly",
    catches: ["PM turn marked complete without an answer", "unbounded empty-answer retries"],
    tags: ["core", "session", "recovery"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
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
        { reasoning: "checking the current task state" },
        { text: "The task remains blocked; here is the recovery decision." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Resolve the blocked task.");
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnCompleted" || item.type === "turnFailed"),
        45_000,
      );
      t.assertions.assert(events.some((item) => item.type === "turnCompleted"), "bounded retry did not complete");
      t.assertions.assert(opened.mock.requests.length === 2, "the model was not retried exactly once");
      t.assertions.assert(
        events.some((event) => {
          const item = t.flows.main.sessionEventOf(event)?.item as { type?: string; text?: string } | undefined;
          return item?.type === "assistantMessage" && item.text?.includes("recovery decision");
        }),
        "the user never received a visible answer",
      );

      opened.mock.script(
        { reasoning: "still checking" },
        { reasoning: "still checking" },
      );
      const failedSession = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const failedEvents = await t.flows.main.attachEventLog(opened.client, failedSession);
      await t.flows.main.sendPrompt(opened.client, failedSession, "Report the result.");
      await t.tools.waitUntil(
        () => failedEvents.some((item) => item.type === "turnCompleted" || item.type === "turnFailed"),
        45_000,
      );
      t.assertions.assert(failedEvents.some((item) => item.type === "turnFailed"), "empty responses silently completed");
      t.assertions.assert(!failedEvents.some((item) => item.type === "turnCompleted"), "failed request was marked complete");
      t.assertions.assert(opened.mock.requests.length === 4, "retry exceeded its one-attempt bound");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

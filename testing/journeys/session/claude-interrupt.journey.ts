import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.claude-interrupt",
    title: "Interrupting Claude Code ends the turn as canceled",
    oracle: "session.interrupt after a live turn yields turnCanceled rather than completed or failed",
    catches: ["interrupt swallowed at t=0", "stopped turn reported as completed"],
    tags: ["third-party", "session", "claude"],
    expectedDurationMs: 60_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    t.flows.main.pointClaudeAtBuiltinLlm(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const claude = await t.flows.main.requireAgentReady(opened.client, "claude");
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId,
        agentId: "claude",
        modelId: claude.catalog.models[0]?.id ?? null,
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Write a very long, detailed short story (at least 3000 words) about a lighthouse keeper on a stormy night. Do not stop until the story is complete. Do not use any tool, just write the story directly in your reply.",
      );
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 60_000);
      const failedEarly = events.find((item) => item.type === "turnFailed");
      if (failedEarly) {
        const blob = JSON.stringify(failedEarly.raw);
        if (/root\/sudo|dangerously-skip-permissions/i.test(blob)) {
          throw new BlockedError(`claude refuses skip-permissions as root: ${blob.slice(0, 500)}`);
        }
        throw new Error(`claude turnFailed before interrupt: ${blob.slice(0, 1500)}`);
      }
      if (events.some((item) => item.type === "turnCompleted" || item.type === "turnCanceled")) {
        throw new BlockedError("the model finished before interrupt plumbing could be exercised");
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const failedArming = events.find((item) => item.type === "turnFailed");
      if (failedArming) {
        throw new Error(`claude turnFailed during interrupt arming: ${JSON.stringify(failedArming.raw).slice(0, 1500)}`);
      }
      if (events.some((item) => item.type === "turnCompleted" || item.type === "turnCanceled")) {
        throw new BlockedError("the model finished during the 3s interrupt arming window");
      }
      await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
      try {
        await t.tools.waitUntil(
          () =>
            events.some(
              (item) => item.type === "turnCanceled" || item.type === "turnCompleted" || item.type === "turnFailed",
            ),
          90_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.map((item) => item.type))}`,
        );
      }
      t.assertions.assert(
        events.some((item) => item.type === "turnCanceled"),
        `a stopped turn must say it was stopped, not completed or failed: ${JSON.stringify(events.map((item) => item.type))}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

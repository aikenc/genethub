import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.claude-same-timeline",
    title: "Claude Code reaches the same timeline as the built-in agent",
    oracle: "a claude session turn completes with a reply after the CLI is on PATH and pointed at the built-in DeepSeek key",
    catches: ["Claude handshake never becomes a turn"],
    tags: ["third-party", "session", "claude"],
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
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
      await t.flows.main.sendPrompt(opened.client, sessionId, "Reply with exactly one word: pong");
      try {
        await t.tools.waitUntil(
          () => events.some((item) => item.type === "turnCompleted" || item.type === "turnFailed"),
          150_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.map((item) => item.type))}`,
        );
      }
      const failed = events.find((item) => item.type === "turnFailed");
      if (failed) {
        const blob = JSON.stringify(failed.raw);
        if (/not logged|unauthor|auth|api key|login|credit|root\/sudo|dangerously-skip-permissions/i.test(blob)) {
          throw new BlockedError(`claude could not reach the model: ${blob.slice(0, 500)}`);
        }
        throw new Error(`claude turnFailed: ${blob.slice(0, 1500)}`);
      }
      t.assertions.assert(
        events.some((item) => item.type === "turnCompleted"),
        `claude turn did not complete: ${JSON.stringify(events.map((item) => item.type))}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

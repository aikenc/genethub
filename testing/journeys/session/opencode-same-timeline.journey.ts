import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.opencode-same-timeline",
    title: "OpenCode reaches the same timeline as the built-in agent",
    oracle: "an opencode session turn completes with a reply after the CLI is on PATH and pointed at the built-in DeepSeek key",
    catches: ["OpenCode handshake never becomes a turn", "prompt echoed as the reply"],
    tags: ["third-party", "session", "opencode"],
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const modelId = t.flows.main.writeOpencodeBuiltinConfig(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.requireAgentReady(opened.client, "opencode");
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId,
        agentId: "opencode",
        modelId,
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      const prompt = "Say hello.";
      await t.flows.main.sendPrompt(opened.client, sessionId, prompt);
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
        if (/not logged|unauthor|auth|api key|login|credit/i.test(blob)) {
          throw new BlockedError(`opencode could not reach the model: ${blob.slice(0, 500)}`);
        }
        throw new Error(`opencode turnFailed: ${blob.slice(0, 1500)}`);
      }
      t.assertions.assert(
        events.some((item) => item.type === "turnCompleted"),
        `opencode turn did not complete: ${JSON.stringify(events.map((item) => item.type))}`,
      );
      const texts = events
        .map((item) => t.flows.main.sessionEventOf(item))
        .filter((inner) => inner?.type === "item")
        .map((inner) => inner?.item as { type?: string; text?: string })
        .filter((item) => item.type === "assistantMessage")
        .map((item) => item.text ?? "")
        .join("\n");
      t.assertions.assert(texts.trim().length > 0, "opencode produced no assistant text");
      t.assertions.assert(texts.trim() !== prompt, "OpenCode echoed the prompt instead of answering");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

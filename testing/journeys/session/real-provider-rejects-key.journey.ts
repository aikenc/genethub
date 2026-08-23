import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.real-provider-rejects-key",
    title: "A real provider that rejects our key says so instead of hanging",
    oracle: "settings.setProvider deepseek with a fake key and no override URL names deepseek and leaves models empty; the next turn fails naming deepseek",
    catches: ["rejected key sent to the wrong host", "turn hangs on a dead key"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 40_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      let saved;
      try {
        saved = await opened.client.call({
          type: "settings.setProvider",
          payload: {
            providerId: "deepseek",
            apiKey: "sk-0000000000000000000000000000000000000000",
            baseUrl: null,
            label: null,
            dialect: null,
            models: null,
          },
        });
      } catch (error) {
        throw new BlockedError(
          `real DeepSeek could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      t.assertions.assert(saved?.type === "settings", `setProvider returned ${saved?.type}`);
      const provider =
        saved?.type === "settings" ? saved.data.providers.find((item) => item.id === "deepseek") : undefined;
      t.assertions.assert(
        provider?.baseUrl === "https://api.deepseek.com/v1",
        `a key saved for DeepSeek must be pointed at DeepSeek, got ${provider?.baseUrl}`,
      );
      t.assertions.assert(Boolean(provider?.problem), "a rejected key has to say so somewhere");
      t.assertions.assert(
        /deepseek/i.test(provider?.problem ?? ""),
        `the complaint does not name the provider: ${provider?.problem}`,
      );
      t.assertions.assert((provider?.models.length ?? 1) === 0, "a rejected key still listed models");
      await opened.client.call({ type: "agent.refresh" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Say hello.");
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnFailed" || item.type === "turnCompleted"),
        60_000,
      );
      t.assertions.assert(events.some((item) => item.type === "turnFailed"), "a rejected key cannot look like success");
      t.assertions.assert(/deepseek/i.test(JSON.stringify(events)), "the turn failure does not name deepseek");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

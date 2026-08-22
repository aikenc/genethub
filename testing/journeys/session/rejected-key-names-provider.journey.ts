import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.rejected-key-names-provider",
    title: "A key the provider will not accept says that and not add a key",
    oracle: "turnFailed names the provider and does not tell the user to add an API key",
    catches: ["add an API key after they just did"],
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
      await opened.client.call({
        type: "settings.setProvider",
        payload: {
          providerId: "deepseek",
          apiKey: "sk-nope",
          baseUrl: "http://127.0.0.1:9/v1",
          label: null,
          dialect: null,
          models: null,
        },
      });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Say hello.");
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnFailed" || item.type === "turnCompleted"),
        45_000,
      );
      t.assertions.assert(
        events.some((item) => item.type === "turnFailed"),
        "a turn with nothing to run on looked like success",
      );
      const blob = JSON.stringify(events);
      t.assertions.assert(/deepseek/i.test(blob), "the failure does not name the provider that refused");
      t.assertions.assert(!/Add an API key/i.test(blob), "told to add a key they already added");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

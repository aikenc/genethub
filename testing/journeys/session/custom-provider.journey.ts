import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.custom-provider",
    title: "A provider the user adds works like the ones we ship",
    oracle: "settings.setProvider inhouse appears in agent.list labels; forgetProvider removes it but not deepseek",
    catches: ["custom provider never reaches the picker"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const saved = await opened.client.call({
        type: "settings.setProvider",
        payload: {
          providerId: "inhouse",
          apiKey: "sk-inhouse",
          baseUrl: opened.mock.origin,
          label: "公司内网",
          dialect: "openai",
          models: null,
        },
      });
      t.assertions.assert(saved?.type === "settings", `setProvider returned ${saved?.type}`);
      const added = saved?.type === "settings" ? saved.data.providers.find((item) => item.id === "inhouse") : undefined;
      t.assertions.assert(Boolean(added?.custom), "only ours are built in");
      t.assertions.assert(added?.label === "公司内网", `label ${added?.label}`);
      t.assertions.assert((added?.models.length ?? 0) > 0, "it was asked and it answered");
      const agents = await opened.client.call({ type: "agent.refresh" });
      const genet = agents?.type === "agents" ? agents.data.find((agent) => agent.id === "genet") : undefined;
      t.assertions.assert(
        (genet?.catalog.models ?? []).some((model) => model.label.startsWith("公司内网:")),
        `the added provider's models never reached the picker: ${(genet?.catalog.models ?? []).map((model) => model.label).join(",")}`,
      );
      await opened.client.call({ type: "settings.forgetProvider", payload: { providerId: "inhouse" } });
      const after = await opened.client.call({ type: "settings.get" });
      t.assertions.assert(
        after?.type === "settings" && !after.data.providers.some((item) => item.id === "inhouse"),
        "an added provider could not be removed",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "settings.forgetProvider", payload: { providerId: "deepseek" } }),
        "badRequest",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

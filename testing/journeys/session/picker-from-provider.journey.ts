import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.picker-from-provider",
    title: "The picker is filled from what the provider says it has",
    oracle: "after settings.setProvider to the mock, genet catalog contains deepseek-v4-flash and no embedding model",
    catches: ["hardcoded picker", "embedding models offered as chat"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const reply = await opened.client.call({ type: "agent.list" });
      t.assertions.assert(reply?.type === "agents", `agent.list returned ${reply?.type}`);
      const genet = reply?.type === "agents" ? reply.data.find((agent) => agent.id === "genet") : undefined;
      t.assertions.assert(Boolean(genet), "the built-in agent is always listed");
      const ids = (genet?.catalog.models ?? []).map((model) => model.id);
      t.assertions.assert(
        ids.some((id) => id.includes("deepseek-v4-flash")),
        `picker models: ${ids.join(",")}`,
      );
      t.assertions.assert(
        !ids.some((id) => id.includes("embedding")),
        `offered something that cannot hold a conversation: ${ids.join(",")}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

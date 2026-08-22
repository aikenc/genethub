import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.capabilities-declared",
    title: "Capabilities are declared so the UI never offers a dead control",
    oracle: "agent.list never advertises models/modes/efforts the agent cannot set",
    catches: ["picker for a dead axis"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const reply = await opened.client.call({ type: "agent.list" });
      t.assertions.assert(reply?.type === "agents", `agent.list returned ${reply?.type}`);
      if (reply?.type !== "agents") return;
      for (const agent of reply.data) {
        if (!agent.capabilities.setModel) {
          t.assertions.assert(agent.catalog.models.length === 0, `${agent.id} lists models it cannot switch`);
        }
        if (!agent.capabilities.setMode) {
          t.assertions.assert(agent.catalog.modes.length === 0, `${agent.id} lists modes it cannot switch`);
        }
        if (!agent.capabilities.setEffort) {
          const named = agent.catalog.models.filter((model) => model.efforts.length > 0).map((model) => model.id);
          t.assertions.assert(named.length === 0, `${agent.id} names efforts it cannot set: ${named.join(",")}`);
        }
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

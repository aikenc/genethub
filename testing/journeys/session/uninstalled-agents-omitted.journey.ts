import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.uninstalled-agents-omitted",
    title: "Agents that are not installed stay out of the picker",
    oracle: "genet is builtin and Ready; every Ready agent has a label",
    catches: ["ghost rows in the agent picker"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const reply = await opened.client.call({ type: "agent.list" });
      t.assertions.assert(reply?.type === "agents", `agent.list returned ${reply?.type}`);
      const genet = reply?.type === "agents" ? reply.data.find((agent) => agent.id === "genet") : undefined;
      t.assertions.assert(Boolean(genet?.builtin), "the built-in agent is always listed");
      t.assertions.assert(genet?.probe.state === "ready", `genet probe is ${JSON.stringify(genet?.probe)}`);
      t.assertions.assert((genet?.catalog.models.length ?? 0) > 0, "a configured provider should produce models");
      if (reply?.type === "agents") {
        for (const agent of reply.data) {
          if (agent.probe.state === "ready") {
            t.assertions.assert(agent.label.length > 0, `${agent.id} has nothing to show in the picker`);
          }
        }
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

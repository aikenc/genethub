import { defineJourney, hideHostAgentClis, seedScriptAgentRuntime } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.uninstalled-agents-omitted",
    // The id is kept for its legacy parity row; the contract changed with
    // script Agents: an unready one is listed on purpose, with a way forward.
    title: "Unready Agents are listed with a reason and a way forward, never as ready",
    oracle: "genet is builtin and Ready with models; every Ready agent has a label; the shipped codex and cursor script Agents are listed with source builtin, and once settled every unready script Agent carries a message and a primary action",
    catches: [
      "ghost rows in the agent picker",
      "a shipped script Agent missing from agent.list",
      "an unready Agent reported as ready",
      "an unready Agent with no reason or nothing to click",
    ],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    // agent.list starts the built-in script Agents: give them the declared
    // Python instead of a download, and none of this machine's own CLIs.
    seedScriptAgentRuntime(t.env);
    hideHostAgentClis(t.env);
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
      // Script Agents report asynchronously: wait until each shipped one has
      // left "starting" and is not running a job, then read what it says.
      const settled = (agent: { message?: string; job?: { done: boolean } }) =>
        agent.message !== "正在启动" && !(agent.job && !agent.job.done);
      for (const id of ["codex", "cursor"]) {
        const agent = await t.flows.branches.waitForAgent(opened.client, id, settled, { what: "settled" });
        t.assertions.assert(agent.source === "builtin" && !agent.builtin, `${id} listed as ${JSON.stringify(t.flows.branches.summarizeAgent(agent))}`);
      }
      for (const agent of await t.flows.branches.listAgents(opened.client)) {
        if (agent.source === undefined || agent.probe.state === "ready") continue;
        t.assertions.assert((agent.message ?? "").trim() !== "", `${agent.id} is unready and says nothing`);
        t.assertions.assert(agent.actions?.some((action) => action.primary) === true,
          `${agent.id} is unready and offers nothing: ${JSON.stringify(t.flows.branches.summarizeAgent(agent))}`);
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

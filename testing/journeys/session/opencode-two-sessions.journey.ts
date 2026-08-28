import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.opencode-two-sessions",
    title: "OpenCode and the built-in agent run side by side without leaking",
    oracle: "two in-flight turns complete, each with exactly one turnStarted on its own subscribe",
    catches: ["shared adapter state mixing two agents"],
    tags: ["third-party", "session", "opencode"],
    llm: { default: "real", realEligible: true },
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "real-llm" },
    expectedDurationMs: 120_000,
    timeoutMs: 210_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    t.flows.main.seedHostBetaProviders(t.env);
    const modelId = t.flows.main.writeOpencodeBuiltinConfig(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.requireAgentReady(opened.client, "opencode");
      const thirdParty = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId,
        agentId: "opencode",
        modelId,
      });
      const builtIn = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const thirdEvents = await t.flows.main.attachEventLog(opened.client, thirdParty);
      const builtEvents = await t.flows.main.attachEventLog(opened.client, builtIn);
      await t.flows.main.sendPrompt(opened.client, thirdParty, "Say something.");
      await t.flows.main.sendPrompt(opened.client, builtIn, "Say something.");
      try {
        await t.tools.waitUntil(
          () =>
            thirdEvents.some((item) => item.type === "turnCompleted" || item.type === "turnFailed") &&
            builtEvents.some((item) => item.type === "turnCompleted" || item.type === "turnFailed"),
          180_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; opencode=${JSON.stringify(thirdEvents.map((item) => item.type))} genet=${JSON.stringify(builtEvents.map((item) => item.type))}`,
        );
      }
      for (const [name, events] of [
        ["opencode", thirdEvents],
        ["genet", builtEvents],
      ] as const) {
        const failed = events.find((item) => item.type === "turnFailed");
        if (failed) {
          const blob = JSON.stringify(failed.raw);
          if (/not logged|unauthor|auth|api key|login|credit/i.test(blob)) {
            throw new BlockedError(`${name} could not reach the model: ${blob.slice(0, 500)}`);
          }
          throw new Error(`${name} turnFailed: ${blob.slice(0, 1500)}`);
        }
        t.assertions.assert(
          events.some((item) => item.type === "turnCompleted"),
          `${name} did not complete: ${JSON.stringify(events.map((item) => item.type))}`,
        );
        t.assertions.assert(
          events.filter((item) => item.type === "turnStarted").length === 1,
          `${name} saw another session's turn: ${JSON.stringify(events.map((item) => item.type))}`,
        );
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

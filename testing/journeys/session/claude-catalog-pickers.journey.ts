import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.claude-catalog-pickers",
    title: "Claude pickers offer what this CLI actually accepts",
    oracle: "agent.refresh catalog lists this CLI's modes, and setModel/setMode/setEffort refuse unknown ids",
    catches: ["hardcoded permission-mode", "picker showing a model the CLI never offered"],
    tags: ["third-party", "session", "claude"],
    expectedDurationMs: 120_000,
    timeoutMs: 210_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    t.flows.main.pointClaudeAtBuiltinLlm(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const claude = await t.flows.main.requireAgentReady(opened.client, "claude");
      t.assertions.assert(claude.capabilities.setModel, "switching model is a control request this CLI answers");
      t.assertions.assert(claude.catalog.models.length > 0, "the handshake should have brought back this install's model list");
      const modeIds = claude.catalog.modes.map((mode) => mode.id);
      t.assertions.assert(
        modeIds.includes("acceptEdits"),
        `every build lists acceptEdits; saw ${JSON.stringify(modeIds)}`,
      );
      t.assertions.assert(claude.catalog.commands.length > 5, `an install with skills lists plenty; saw ${claude.catalog.commands.length}`);
      t.assertions.assert(
        claude.catalog.commands.every((command) => !command.name.startsWith("/")),
        "the slash is the composer's to draw, not part of the name",
      );
      const withEffort = claude.catalog.models.find((model) => model.efforts.length > 0);
      if (!withEffort) {
        throw new BlockedError("this Claude install named no effort levels");
      }
      t.assertions.assert(claude.capabilities.setEffort, "a build that names levels can be switched between them");
      const asking = claude.catalog.defaultMode;
      t.assertions.assert(
        asking === "default" || asking === "manual" || asking === "bypassPermissions",
        `catalog defaultMode is a real CLI mode, not an invented alias: ${asking}`,
      );

      const knownModel = claude.catalog.models[0];
      if (!knownModel) throw new Error("catalog listed a model after the empty-list check");
      const knownEffort = withEffort.efforts[withEffort.efforts.length - 1];
      if (!knownEffort) throw new Error("the effort-capable model named at least one level");
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId,
        agentId: "claude",
        modelId: knownModel.id,
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
      t.assertions.assert(
        events.some((item) => item.type === "turnCompleted"),
        "the first turn must finish before control switches are live",
      );

      await opened.client.call({
        type: "session.setModel",
        payload: { sessionId, modelId: knownModel.id },
      });
      await opened.client.call({ type: "session.setMode", payload: { sessionId, modeId: "plan" } });
      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "session.setModel",
            payload: { sessionId, modelId: "not-a-model-this-cli-has" },
          }),
        "badRequest",
      );
      await opened.client.call({
        type: "session.setEffort",
        payload: { sessionId, effortId: knownEffort },
      });
      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "session.setEffort",
            payload: { sessionId, effortId: "as-hard-as-you-can" },
          }),
        "badRequest",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

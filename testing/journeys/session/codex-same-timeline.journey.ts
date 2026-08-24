import { spawnSync } from "node:child_process";

import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.codex-same-timeline",
    title: "Codex reaches the same timeline as the built-in agent",
    oracle: "a codex session turn completes with a reply after the CLI is on PATH and logged in",
    catches: ["Codex handshake never becomes a turn"],
    tags: ["third-party", "session", "codex"],
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const which = spawnSync("which", ["codex"], { encoding: "utf8" });
    if (which.status !== 0) {
      throw new BlockedError("codex is not on PATH");
    }
    t.flows.main.seedHostCodexLogin(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const agents = await opened.client.call({ type: "agent.refresh" });
      const codex = agents?.type === "agents" ? agents.data.find((agent) => agent.id === "codex") : undefined;
      if (!codex || codex.probe.state !== "ready") {
        throw new BlockedError(`codex agent is not ready: ${JSON.stringify(codex?.probe)}`);
      }
      const modelId = codex.catalog.models[0]?.id ?? null;
      const created = await opened.client.call({
        type: "session.create",
        payload: {
          workspaceId: opened.workspaceId,
          agentId: "codex",
          modelId,
          modeId: null,
          title: null,
          cwd: null,
        },
      });
      t.assertions.assert(created?.type === "session", `session.create returned ${created?.type}`);
      const sessionId = created?.type === "session" ? created.data.id : "";
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
      const failed = events.find((item) => item.type === "turnFailed");
      if (failed) {
        const blob = JSON.stringify(failed.raw);
        if (/not logged|unauthor|auth|api key|login/i.test(blob)) {
          throw new BlockedError(`codex is not logged in: ${blob.slice(0, 500)}`);
        }
        throw new Error(`codex turnFailed: ${blob.slice(0, 1500)}`);
      }
      t.assertions.assert(
        events.some((item) => item.type === "turnCompleted"),
        `codex turn did not complete: ${JSON.stringify(events.map((item) => item.type))}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

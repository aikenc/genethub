import { spawnSync } from "node:child_process";

import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.cursor-same-timeline",
    title: "Cursor reaches the same timeline as the built-in agent",
    oracle: "a cursor session turn completes with a reply after cursor-agent is on PATH and logged in",
    catches: ["ACP handshake never becomes a turn"],
    tags: ["third-party", "session", "parity"],
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const which = spawnSync("which", ["cursor-agent"], { encoding: "utf8" });
    if (which.status !== 0) {
      throw new BlockedError("cursor-agent is not on PATH");
    }
    t.flows.main.seedHostCursorLogin(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const agents = await opened.client.call({ type: "agent.refresh" });
      t.assertions.assert(agents?.type === "agents", `agent.refresh returned ${agents?.type}`);
      const cursor = agents?.type === "agents" ? agents.data.find((agent) => agent.id === "cursor") : undefined;
      if (!cursor || cursor.probe.state !== "ready") {
        throw new BlockedError(`cursor agent is not ready: ${JSON.stringify(cursor?.probe)}`);
      }
      const modelId =
        cursor.catalog.models.find((model) => model.id.includes("composer-2.5[fast=true]"))?.id ??
        cursor.catalog.models[0]?.id ??
        null;
      const created = await opened.client.call({
        type: "session.create",
        payload: {
          workspaceId: opened.workspaceId,
          agentId: "cursor",
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
          throw new BlockedError(`cursor is not logged in: ${blob.slice(0, 500)}`);
        }
        throw new Error(`cursor turnFailed: ${blob.slice(0, 1500)}`);
      }
      t.assertions.assert(events.some((item) => item.type === "turnCompleted"), `cursor turn did not complete: ${JSON.stringify(events.map((item) => item.type))}`);
      t.assertions.assert(/pong/i.test(JSON.stringify(events)), "cursor reply never contained pong");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

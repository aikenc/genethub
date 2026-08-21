import { spawnSync } from "node:child_process";

import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.cursor-tool-while-running",
    title: "A Cursor tool call is visible while the turn is still running",
    oracle: "a tool event arrives at least 250ms before turnCompleted when Cursor writes ping.txt",
    catches: ["ACP timeline flushed only at turn end"],
    tags: ["third-party", "session", "parity"],
    expectedDurationMs: 120_000,
    timeoutMs: 210_000,
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
      const sent = Date.now();
      let toolAt: number | null = null;
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Create a file named ping.txt in the current working directory whose only contents are the word pong, using your file tools. Then reply with exactly: done",
      );
      await t.tools.waitUntil(() => {
        if (toolAt == null && events.some((item) => /tool/i.test(item.type ?? "") || /tool/i.test(JSON.stringify(item.raw)))) {
          toolAt = Date.now();
        }
        return events.some((item) => item.type === "turnCompleted" || item.type === "turnFailed");
      }, 180_000);
      const failed = events.find((item) => item.type === "turnFailed");
      if (failed) {
        const blob = JSON.stringify(failed.raw);
        if (/not logged|unauthor|auth|api key|login/i.test(blob)) {
          throw new BlockedError(`cursor is not logged in: ${blob.slice(0, 500)}`);
        }
        throw new Error(`cursor turnFailed: ${blob.slice(0, 1500)}`);
      }
      t.assertions.assert(events.some((item) => item.type === "turnCompleted"), "cursor write turn did not complete");
      t.assertions.assert(toolAt != null, "no tool call reached the subscriber while the turn ran");
      const ended = Date.now();
      t.assertions.assert(
        ended - (toolAt ?? sent) >= 250,
        `tool call lead was only ${ended - (toolAt ?? sent)}ms; the timeline was flushed at the end`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

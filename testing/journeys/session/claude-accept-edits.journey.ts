import { existsSync } from "node:fs";
import path from "node:path";

import { BlockedError, defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.claude-accept-edits",
    title: "acceptEdits lets a real Claude Write reach the workspace",
    oracle: "session.setMode acceptEdits then a Write tool call creates greeting.txt without a permission prompt",
    catches: ["acceptEdits still blocks on permission", "Write never reaches disk"],
    tags: ["third-party", "session", "claude"],
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    t.flows.main.pointClaudeAtBuiltinLlm(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const claude = await t.flows.main.requireAgentReady(opened.client, "claude");
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId,
        agentId: "claude",
        modelId: claude.catalog.models[0]?.id ?? null,
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await opened.client.call({
        type: "session.setMode",
        payload: { sessionId, modeId: "acceptEdits" },
      });
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Create a file named greeting.txt containing exactly: hello, using your Write tool.",
      );
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
        throw new Error(`claude turnFailed: ${JSON.stringify(failed.raw).slice(0, 1500)}`);
      }
      t.assertions.assert(
        events.some((item) => item.type === "turnCompleted"),
        "acceptEdits should let the tool run without blocking on a permission prompt",
      );
      const asked = events.some((item) => item.type === "permissionRequested");
      t.assertions.assert(!asked, "acceptEdits must not raise a permission prompt");
      const toolOk = events.some((item) => {
        const inner = t.flows.main.sessionEventOf(item);
        const timeline = inner?.item as { type?: string; status?: string } | undefined;
        return inner?.type === "item" && timeline?.type === "toolCall" && timeline.status === "ok";
      });
      t.assertions.assert(toolOk, "a tool call should have run and succeeded");
      t.assertions.assert(
        existsSync(path.join(t.env.workspace, "greeting.txt")),
        "the Write tool call should have reached the real filesystem",
      );
    } catch (error) {
      if (error instanceof BlockedError) throw error;
      throw error;
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

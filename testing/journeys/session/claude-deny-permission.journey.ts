import { existsSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.claude-deny-permission",
    title: "Denying a Claude permission request never touches disk",
    oracle: "session.respondPermission deny leaves denied.txt absent after the turn settles",
    catches: ["denied Write still reaches the filesystem"],
    tags: ["third-party", "session", "claude"],
    llm: { default: "real" },
    resources: { pool: "real-llm" },
    expectedDurationMs: 90_000,
    timeoutMs: 180_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
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
      const asking = claude.catalog.modes.find(mode => mode.id === "manual" || mode.id === "default")?.id;
      if (!asking) throw new Error("installed Claude catalog omitted an asking mode");
      await opened.client.call({ type: "session.setMode", payload: { sessionId, modeId: asking } });
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Create a file named denied.txt containing exactly: hello, using your Write tool.",
      );
      try {
        await t.tools.waitUntil(
          () =>
            events.some(
              (item) =>
                item.type === "permissionRequested" ||
                item.type === "turnCompleted" ||
                item.type === "turnFailed",
            ),
          120_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.map((item) => item.type))}`,
        );
      }
      const asked = events.find((item) => item.type === "permissionRequested");
      if (!asked) {
        if (existsSync(path.join(t.env.workspace, "denied.txt"))) {
          throw new Error("default mode wrote denied.txt without asking permission");
        }
        throw new Error("asking mode finished without a Write permission prompt");
      }
      t.assertions.assert(!existsSync(path.join(t.env.workspace, "denied.txt")), "Write ran before a permission decision");
      const inner = t.flows.main.sessionEventOf(asked);
      const request = inner?.request as
        | { id?: string; options?: Array<{ id: string; kind: string }> }
        | undefined;
      const requestId = request?.id;
      if (!requestId) throw new Error("permissionRequested had no request id");
      const optionId =
        request.options?.find((option) => option.id === "deny")?.id ??
        request.options?.find((option) => option.kind === "reject")?.id;
      if (!optionId) throw new Error(`no deny/reject option: ${JSON.stringify(request.options)}`);
      await opened.client.call({
        type: "session.respondPermission",
        payload: {
          sessionId,
          requestId,
          outcome: { outcome: "selected", optionId },
        },
      });
      // Asking stops the old execution before publishing permissionRequested.
      // An earlier turnCanceled is not evidence that the denial was applied.
      const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(snapshot?.type === "snapshot", "denied session is readable");
      if (snapshot?.type !== "snapshot") throw new Error("expected session snapshot");
      t.assertions.assert(snapshot.data.pendingPermissions.length === 0, "denial left a pending permission");
      t.assertions.assert(snapshot.data.summary.status === "idle", "denial resumed the stopped execution");
      t.assertions.assert(!events.some(item => item.type === "turnFailed"), "a denial should not itself fail the turn");
      t.assertions.assert(
        !existsSync(path.join(t.env.workspace, "denied.txt")),
        "a denied Write must never reach the filesystem",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

import { defineSpecialty, registerControlledAgent, readControlledAgentJournal } from "../../framework/public.ts";

for (const mode of ["declared", "missing", "configured"] as const) {
  for (const idType of (mode === "configured" ? ["number"] : ["number", "string"]) as Array<"number" | "string">) {
    defineSpecialty({
      id: `specialty.agent-space.durable-acp-elevation.${mode}.${idType}`,
      title: `ACP elevation with ${mode} unattended mode and a ${idType} request ID`,
      oracle: "The original native request receives exactly one cancellation, its process exits, resume preserves the session ID, declared/configured modes continue, and unavailable elevation stops repeated approval",
      catches: ["duplicate native replies", "string IDs dropped", "mode names guessed", "approval cannot change the mode", "ineffective elevation loops", "resume creates a new native session"],
      tags: ["core", "contract", "agent-space", "durable-approval", "refactor-acp-elevation"],
      llm: { default: "none" }, expectedDurationMs: 15000, timeoutMs: 90000,
      surfaces: ["daemon", "stdio", "external-acp-cli", "workbench-client"],
      productInterfaces: ["agents.custom", "session.send", "session.respondPermission", "session.get"],
    }, async t => {
      const fixture = registerControlledAgent(t.env, {
        profile: mode === "declared" ? "acp-elevation" : "acp-elevation-no-mode",
        permissionId: idType,
        unattendedModes: mode === "configured" ? ["full-access"] : [],
      });
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await t.flows.main.requireAgentReady(opened.client, fixture.agentId);
        const sessionId = await t.flows.main.createAgentSession(opened.client, {
          workspaceId: opened.workspaceId, agentId: fixture.agentId, modelId: null,
        });
        const snapshot = async () => {
          const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
          if (reply?.type !== "snapshot") throw new Error("ACP session disappeared");
          return reply.data;
        };
        const journal = () => readControlledAgentJournal(fixture);
        await t.flows.main.sendPrompt(opened.client, sessionId, "edit a controlled test file");
        const request = await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions?.[0], 20000);
        t.assertions.assert(request.id.startsWith("interaction-"), "Human card lacks a durable interaction identity");
        t.assertions.assert(request.author === "agent" && Boolean(request.summary) && request.description?.includes("未经验证"), "Human display fields or provenance were lost");
        const nativeRequest = journal().find(entry => entry.event === "permission-request");
        t.assertions.assert(Boolean(nativeRequest), "native process did not emit a request");
        if (!nativeRequest) return;
        await t.tools.waitUntil(() => journal().some(entry => entry.event === "permission-reply" && entry.pid === nativeRequest.pid), 5000);
        const replies = journal().filter(entry => entry.event === "permission-reply" && entry.pid === nativeRequest.pid);
        t.assertions.assert(replies.length === 1 && replies[0]!.id === (idType === "number" ? 7 : "permission-7") && (replies[0]!.result as any)?.outcome?.outcome === "cancelled", "native request was not answered exactly once with cancellation");
        await t.tools.waitUntil(() => {
          try { process.kill(nativeRequest.pid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
        }, 5000);
        const answer = await opened.client.call({ type: "session.respondPermission", payload: {
          sessionId, requestId: request.id, outcome: { outcome: "selected", optionId: "allow" },
        } });
        t.assertions.assert(answer?.type === "ack", "Human decision was not durably accepted");
        await t.tools.waitUntil(() => journal().some(entry => entry.event === "resumed" && entry.sessionId === nativeRequest.sessionId), 20000);
        if (mode === "missing") {
          const repeated = await t.tools.waitUntil(async () => {
            const pending = (await snapshot()).pendingPermissions?.[0];
            return pending?.title === "该 Agent 无法提权" ? pending : undefined;
          }, 20000);
          t.assertions.assert(repeated.id !== request.id, "a reused child RPC ID replaced the durable Human identity");
          await opened.client.call({ type: "session.respondPermission", payload: {
            sessionId, requestId: request.id, outcome: { outcome: "selected", optionId: "allow" },
          } });
          t.assertions.assert((await snapshot()).pendingPermissions[0]?.id === repeated.id, "an old reply decided a later native request");
          t.assertions.assert(repeated.options.length === 1 && repeated.options[0]?.kind === "reject", "unsupported elevation offered another ineffective approval");
          await opened.client.call({ type: "session.respondPermission", payload: {
            sessionId, requestId: repeated.id, outcome: { outcome: "selected", optionId: repeated.options[0]!.id },
          } });
          await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 10000);
          t.assertions.assert(journal().filter(entry => entry.event === "permission-request").length === 2, "stopping unsupported elevation started another request");
        } else {
          const completed = await t.tools.waitUntil(async () => {
            const current = await snapshot();
            return current.summary.status === "idle" ? current : undefined;
          }, 20000);
          const expectedMode = mode === "declared" ? "run-unattended" : "full-access";
          t.assertions.assert(completed.summary.modeId === expectedMode && completed.pendingPermissions.length === 0, "elevated mode was not persisted or created another Human wait");
          t.assertions.assert(JSON.stringify(completed.items).includes("continued-after-"), "approved native session did not continue");
          if (mode === "configured") t.assertions.assert(journal().some(entry => entry.event === "permission-reply" && (entry.result as any)?.outcome?.outcome === "selected"), "configured unattended mode did not answer the native request immediately");
        }
      } finally {
        opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
      }
    });
  }
}

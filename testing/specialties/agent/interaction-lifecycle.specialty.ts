import { randomBytes } from "node:crypto";
import type { PermissionOutcome, SessionSnapshot } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenet } from "../../framework/public.ts";

// The real public script/CLI boundary, with the same durable message identity
// that Workbench uses. The fixture's journal and OS PIDs are independent
// evidence of executions; no daemon or client behavior is replaced.
for (const scenario of ["waiting", "restart-waiting", "answer-round", "cancel", "history", "missing-usage"] as const) {
  defineSpecialty({
    id: `specialty.agent.interaction-lifecycle.${scenario}`,
    title: `Conversation interaction preserves delivery, history and accounting: ${scenario}`,
    oracle: "A durable original stays blocked without new executions, including after restart; Human answers resume the original business round, cancellation ends its obligation, and submitted choices/text persist exactly once. Missing provider accounting is unavailable rather than a reported zero",
    catches: ["sent original automatically becomes a consultation", "restart undoes Human pause", "answer opens a new business round", "canceled original redelivered", "answer disappears from history", "missing usage becomes zero"],
    tags: ["core", "session", "durable-interaction", "interaction-lifecycle"],
    llm: { default: "none" }, expectedDurationMs: 12_000, timeoutMs: 90_000,
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "script-agent", "real-cli", "filesystem", "os-process"],
    productInterfaces: ["session.send", "session.get", "session.respondPermission", "session.narrative", "genet daemon start"],
  }, async t => {
    const nonce = "human-answer-" + randomBytes(8).toString("hex");
    const session = await t.flows.branches.openControlledAgentSession({ openRoot: t.openRoot, lease: t.env,
      agent: { profile: scenario === "missing-usage" ? "normal" : "cli-question", once: true, expectedResume: nonce } });
    let client = session.client;
    const snapshot = async (): Promise<SessionSnapshot> => {
      const reply = await client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
      if (reply?.type !== "snapshot") throw new Error("no snapshot");
      return reply.data;
    };
    try {
      const messageId = "u_" + randomBytes(16).toString("hex");
      // Isolate the history defect from the durable dispatcher defect. The
      // compatibility path must retain answers as well as the Workbench path.
      await client.call({ type: "session.send", payload: { sessionId: session.sessionId,
        ...(scenario === "history" ? {} : { messageId }), text: "请给我输入框和选择", attachments: [],
        artifactPreviewBaseUrl: null, continuesRound: null } });
      if (scenario === "missing-usage") {
        await t.tools.waitUntil(async () => (await snapshot()).items.some(i => i.type === "turnSummary"), 15_000);
        const stats = (await snapshot()).items.find(i => i.type === "turnSummary");
        t.assertions.assert(stats?.type === "turnSummary"
          && (stats.stats.usage as unknown as { tokenUsageStatus?: string }).tokenUsageStatus === "unavailable",
          "provider never reported token counts but the settled turn claims a numeric zero");
        return;
      }
      await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions?.length === 1, 20_000);
      const paused = await snapshot(), request = paused.pendingPermissions![0]!;
      const rounds = async () => {
        const reply = await client.call({ type: "session.rounds", payload: { sessionId: session.sessionId, throughRoundId: null, cursor: null, limit: 100 } });
        if (reply?.type !== "sessionRounds") throw new Error("no round history");
        return reply.data.rounds;
      };
      const originalRound = (await rounds()).at(-1)!.roundId;
      if (scenario === "waiting" || scenario === "restart-waiting") {
        if (scenario === "restart-waiting") {
          client.close(); session.daemon.stop();
          const result = runGenet(session.daemon.genet, ["daemon", "start"], session.daemon.env);
          t.assertions.assert(result.code === 0, "daemon restart failed");
          client = await connectProductClient(daemonEndpoint(session.daemon));
        }
        // Observe several scheduler cycles, not only the instant at which the
        // first CLI died. No Human input or decision is submitted here.
        await new Promise(resolve => setTimeout(resolve, 2_000));
        const starts = session.journal().filter(e => e.event === "session-start");
        const current = await snapshot();
        t.assertions.assert(starts.length === 1 && current.summary.status === "waiting"
          && current.pendingPermissions?.[0]?.id === request.id,
          `Human pause spawned ${starts.length - 1} unsolicited execution(s); status=${current.summary.status}`);
        t.assertions.assert(starts.every(e => !t.flows.branches.processAlive(Number(e.cliPid))), "waiting retains a session CLI");
        return;
      }
      const outcome: PermissionOutcome = scenario === "cancel" ? { outcome: "canceled" } : {
        outcome: "answered", answers: request.questions!.map(q => ({ questionId: q.id,
          selectedOptionIds: [q.options[1]!.id], freeformText: nonce })) };
      await client.call({ type: "session.respondPermission", payload: { sessionId: session.sessionId, requestId: request.id, outcome } });
      await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 20_000);
      const after = await snapshot();
      if (scenario === "cancel") {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        t.assertions.assert(session.journal().filter(e => e.event === "session-start").length === 1,
          "canceling the question restarted the original task");
        t.assertions.assert(!(await snapshot()).summary.inputSummary?.pendingMessageIds.includes(messageId), "canceled input remains a delivery obligation");
      } else if (scenario === "answer-round") {
        const completed = await rounds();
        t.assertions.assert(completed.length === 1 && completed[0]?.roundId === originalRound
          && completed[0]?.outcome === "completed", "Human answer superseded the original business round");
      } else {
        const answers = after.items.filter(i => i.type === "userMessage" && i.text.includes(nonce) && i.text.includes("选项 B"));
        t.assertions.assert(answers.length === 1, "Human choice and text are absent from durable chat history");
        // Same decision is an idempotent retry; it must not duplicate history.
        await client.call({ type: "session.respondPermission", payload: { sessionId: session.sessionId, requestId: request.id, outcome } });
        t.assertions.assert((await snapshot()).items.filter(i => i.type === "userMessage" && i.text.includes(nonce)).length === 1,
          "retry duplicated the Human answer");
      }
      t.note(`scenario=${scenario}; observed executions=${session.journal().filter(e => e.event === "session-start").length}`);
    } finally { client.close(); await session.dispose(); }
  });
}

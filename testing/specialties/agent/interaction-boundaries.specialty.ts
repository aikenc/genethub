import { randomBytes } from "node:crypto";
import type { PermissionOutcome, SessionSnapshot } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenet, seedScriptAgentRuntime } from "../../framework/public.ts";

for (const scenario of ["consultation", "two-questions", "history-restart", "answer-race", "invalid-answer", "denied-plan", "cancel-restart", "zero-usage", "partial-usage", "partial-cancel"] as const) {
  defineSpecialty({
    id: `specialty.agent.interaction-boundaries.${scenario}`,
    title: `Human interaction boundary: ${scenario}`,
    oracle: "Explicit consultations retain the original question and release their CLI when finished; successive answers survive restart exactly once; invalid/conflicting answers never change a decision; refusal/cancellation do not execute the original effect. Provider zero, partial and absent accounting remain distinct",
    catches: ["consultation leaves a live waiting CLI", "second question overwrites earlier chat answers", "two devices resume twice", "invalid answer acknowledged", "refusal treated as approval", "restart revives a canceled task", "reported zero displayed as missing", "partial accounting drops known counts"],
    tags: ["core", "session", "durable-interaction", "interaction-boundaries"], llm: { default: "none" },
    expectedDurationMs: 15_000, timeoutMs: 100_000,
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "script-agent", "filesystem", "os-process", "workbench-client"],
    productInterfaces: ["session.send", "session.get", "session.rounds", "session.respondPermission", "genet daemon start"],
  }, async t => {
    const marker = "boundary-" + randomBytes(8).toString("hex");
    const counting = scenario === "zero-usage" || scenario === "partial-usage" || scenario === "partial-cancel";
    const usage = counting ? { inputTokens: scenario === "zero-usage" ? 0 : 17, outputTokens: scenario === "zero-usage" ? 0 : 7,
      cacheReadTokens: 0, cacheWriteTokens: 0, llmRounds: 1,
      tokenUsageStatus: scenario === "partial-usage" ? "partial" as const : "reported" as const } : undefined;
    const session = await t.flows.branches.openControlledAgentSession({ openRoot: t.openRoot, lease: t.env,
      agent: { profile: scenario === "denied-plan" ? "native-plan" : counting && scenario !== "partial-cancel" ? "normal" : "native-question",
        questionCount: scenario === "two-questions" ? 2 : 1, expectedResume: marker, usage } });
    let client = session.client, second: typeof client | undefined;
    const snapshot = async (): Promise<SessionSnapshot> => {
      const reply = await client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
      if (reply?.type !== "snapshot") throw new Error("no snapshot");
      return reply.data;
    };
    const restart = async () => {
      client.close(); session.daemon.stop();
      t.assertions.assert(runGenet(session.daemon.genet, ["daemon", "start"], session.daemon.env).code === 0, "restart failed");
      client = await connectProductClient(daemonEndpoint(session.daemon));
    };
    const answer = (requestId: string, outcome: PermissionOutcome, via = client) => via.call({
      type: "session.respondPermission", payload: { sessionId: session.sessionId, requestId, outcome } });
    try {
      await t.flows.main.sendPrompt(client, session.sessionId, "请先询问用户", null, "u_" + randomBytes(16).toString("hex"));
      if (counting && scenario !== "partial-cancel") {
        await t.tools.waitUntil(async () => (await snapshot()).items.some(i => i.type === "turnSummary"), 20_000);
        const item = (await snapshot()).items.find(i => i.type === "turnSummary");
        t.assertions.assert(item?.type === "turnSummary" && item.stats.usage.tokenUsageStatus === usage!.tokenUsageStatus
          && item.stats.usage.inputTokens === usage!.inputTokens && item.stats.usage.outputTokens === usage!.outputTokens,
          "reported zero/partial usage lost its provider status or counts");
        return;
      }
      await t.tools.waitUntil(async () => !!(await snapshot()).pendingPermissions?.length, 20_000);
      const request = (await snapshot()).pendingPermissions![0]!;
      if (scenario === "partial-cancel") {
        const item = (await snapshot()).items.find(i => i.type === "turnSummary");
        t.assertions.assert(item?.type === "turnSummary" && item.stats.usage.tokenUsageStatus === "partial"
          && item.stats.usage.inputTokens === 17 && item.stats.usage.outputTokens === 7, "pause dropped known partial usage");
        return;
      }
      if (scenario === "consultation") {
        await t.flows.main.sendPrompt(client, session.sessionId, "请解释选项，保留原问题", null, "u_" + randomBytes(16).toString("hex"));
        await t.tools.waitUntil(async () => session.journal().filter(e => e.event === "answered").some(e => e.stopReason === "end_turn")
          && (await snapshot()).summary.status === "waiting", 20_000);
        t.assertions.assert((await snapshot()).pendingPermissions?.[0]?.id === request.id, "consultation replaced the original question");
        const latest = session.journal().filter(e => e.event === "session-start").at(-1)!;
        await t.tools.waitUntil(() => !t.flows.branches.processAlive(Number(latest.cliPid)), 3_000)
          .catch(() => {
            const trace = session.journal().map(e => `${e.event}:${e.cliPid ?? e.sessionId ?? ""}`).join(",");
            throw new Error(`completed consultation kept its Session CLI alive during Human wait; pid=${latest.cliPid}; journal=${trace}`);
          });
      }
      if (scenario === "cancel-restart") {
        await answer(request.id, { outcome: "canceled" });
        await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 15_000);
        await restart(); await new Promise(resolve => setTimeout(resolve, 1_500));
        t.assertions.assert(session.journal().filter(e => e.event === "session-start").length === 1
          && !(await snapshot()).pendingPermissions?.length, "restart revived canceled work");
        return;
      }
      if (scenario === "denied-plan") {
        await answer(request.id, { outcome: "selected", optionId: "reject" });
        await t.tools.waitUntil(() => session.journal().some(e => e.event === "rejected-continuation"), 15_000);
        t.assertions.assert(!session.journal().some(e => e.event === "approved-continuation"), "rejection executed the approved effect");
        return;
      }
      if (scenario === "invalid-answer") {
        let refused = false;
        try { await answer(request.id, { outcome: "answered", answers: [{ questionId: "choice", selectedOptionIds: ["missing"] }] }); }
        catch { refused = true; }
        t.assertions.assert(refused && (await snapshot()).pendingPermissions?.[0]?.id === request.id, "invalid answer consumed the Human pause");
      }
      const outcome: PermissionOutcome = { outcome: "answered", answers: [{ questionId: "choice", selectedOptionIds: ["b"], freeformText: marker + "-first" }] };
      if (scenario === "answer-race") {
        second = await connectProductClient(daemonEndpoint(session.daemon));
        const both = await Promise.all([answer(request.id, outcome), answer(request.id, outcome, second)]);
        t.assertions.assert(both.every(r => r?.type === "ack"), "same decision retry was not idempotent");
      } else await answer(request.id, outcome);
      if (scenario === "two-questions") {
        await t.tools.waitUntil(async () => !!(await snapshot()).pendingPermissions?.some(p => p.id !== request.id), 15_000);
        const next = (await snapshot()).pendingPermissions![0]!;
        await answer(next.id, { outcome: "answered", answers: [{ questionId: "choice", selectedOptionIds: ["a"], freeformText: marker + "-second" }] });
      }
      await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 20_000);
      if (scenario === "history-restart" || scenario === "two-questions") await restart();
      const items = (await snapshot()).items;
      t.assertions.assert(items.filter(i => i.type === "userMessage" && i.text.includes(marker + "-first") && i.text.includes("选项 B")).length === 1,
        "answer history is missing or duplicated");
      if (scenario === "two-questions") t.assertions.assert(items.filter(i => i.type === "userMessage" && i.text.includes(marker + "-second") && i.text.includes("选项 A")).length === 1,
        "second question lost its own or earlier answer");
      if (scenario === "answer-race") {
        t.assertions.assert(session.journal().filter(e => e.event === "session-start").length === 2, "two answers launched two continuations");
        let refused = false;
        try { await answer(request.id, { outcome: "canceled" }); } catch { refused = true; }
        t.assertions.assert(refused, "conflicting late decision replaced the accepted answer");
      }
      t.note(`scenario=${scenario}; executions=${session.journal().filter(e => e.event === "session-start").length}`);
    } catch (error) {
      if (scenario === "consultation") {
        const journal = session.journal().map(e => e.event + ":" + (e.stopReason ?? "")).join(",");
        t.note(`journal=${journal}`);
      }
      throw error;
    } finally { second?.close(); client.close(); await session.dispose(); }
  });
}

defineSpecialty({
  id: "specialty.agent.interaction-boundaries.model-quiescence",
  title: "A real builtin provider remains silent across a durable Human pause",
  oracle: "The real builtin Agent calls a public model endpoint once to ask, makes no further request without Human input, and uses the recorded answer in one restored turn",
  catches: ["waiting hides unsolicited model calls", "Human response is lost on durable delivery"],
  tags: ["core", "session", "durable-interaction", "interaction-boundaries"], llm: { default: "mock" },
  expectedDurationMs: 20_000, timeoutMs: 90_000,
  surfaces: ["daemon", "builtin-agent", "real-model-protocol"],
  productInterfaces: ["session.send", "session.get", "session.respondPermission"],
}, async t => {
  seedScriptAgentRuntime(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const marker = "recorded-answer-" + randomBytes(8).toString("hex");
    opened.mock.script({ tool: { name: "request_user_input", arguments: { questions: [{ header: "选择", id: "choice", question: "选择并补充", options: [{ label: "A", description: "甲" }, { label: "B", description: "乙" }] }] } } },
      { respond: body => { t.assertions.assert(JSON.stringify(body).includes(marker), "recorded Human answer did not reach real provider"); return { text: "answer received" }; } });
    const snapshot = async () => { const r = await opened.client.call({ type: "session.get", payload: { sessionId } }); if (r?.type !== "snapshot") throw new Error("no snapshot"); return r.data; };
    await t.flows.main.sendPrompt(opened.client, sessionId, "请先问一个问题");
    await t.tools.waitUntil(async () => !!(await snapshot()).pendingPermissions?.length, 30_000);
    const request = (await snapshot()).pendingPermissions![0]!;
    await new Promise(resolve => setTimeout(resolve, 2_000));
    t.assertions.assert(opened.mock.requests.length === 1 && (await snapshot()).summary.status === "waiting", "Human wait generated an unsolicited model request");
    await opened.client.call({ type: "session.respondPermission", payload: { sessionId, requestId: request.id,
      outcome: { outcome: "answered", answers: [{ questionId: "choice", selectedOptionIds: [], freeformText: marker }] } } });
    await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 30_000);
    t.assertions.assert(opened.mock.requests.length === 2, "answer was delivered to more than one model turn");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

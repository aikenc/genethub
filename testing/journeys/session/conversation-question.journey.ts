import { randomBytes } from "node:crypto";
import { defineJourney, seedScriptAgentRuntime } from "../../framework/public.ts";

// Real CLI + real model: this checks discovery from natural language rather
// than proving only that a forced function_call can be rendered.
defineJourney({
  id: "journey.session.conversation-question",
  title: "Codex discovers a real conversation input and choices from the feedback's words",
  oracle: "The real model chooses the exposed platform/native question entry from a natural-language request, produces text plus choices in the original conversation, and after Human answers a fresh execution repeats the nonce; no substitute HTML page and no pending CLI are required",
  catches: ["guidance exists but tool is inaccessible", "HTML used as detached conversation input", "answer never reaches resumed model"],
  tags: ["third-party", "session", "codex", "conversation-question", "durable-interaction"],
  llm: { default: "real" }, resources: { pool: "real-llm" },
  expectedDurationMs: 50_000, timeoutMs: 180_000,
  surfaces: ["daemon", "real-codex-cli", "real-model", "workbench-client", "os-process"],
  productInterfaces: ["session.create", "session.send", "session.get", "session.respondPermission", "agent-serve-protocol-1"],
}, async t => {
  t.flows.main.seedHostCodexLogin(t.env); seedScriptAgentRuntime(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const agent = await t.flows.main.requireAgentReady(opened.client, "codex", 60_000);
    const model = agent.catalog.models.find(m => m.id === "gpt-6-luna") ?? agent.catalog.models[0];
    t.assertions.assert(!!model, "real CLI has no model for discovery");
    const sessionId = await t.flows.main.createAgentSession(opened.client, { workspaceId: opened.workspaceId, agentId: "codex", modelId: model!.id });
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, "我们正在调试Agent对话，你能给我一个输入框+一个选择给我试试吗？收到我的选择和输入后，请只复述输入内容。");
    const snapshot = async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("no conversation snapshot");
      return reply.data;
    };
    let request: (Awaited<ReturnType<typeof snapshot>>)["pendingPermissions"][number] | undefined;
    await t.tools.waitUntil(async () => {
      const state = await snapshot();
      request = state.pendingPermissions.find(p => p.kind === "question");
      if (request) return true;
      if (events.some(e => e.type === "turnCompleted" || e.type === "turnFailed")) {
        const answer = state.items.filter(i => i.type === "assistantMessage").map(i => i.text).join("\n");
        throw new Error("real model ended without a conversation question: " + events.map(e => e.type).join(",") + "; answer=" + answer.slice(-4000));
      }
      return false;
    }, 60_000);
    const questions = request!.questions ?? [];
    t.assertions.assert(questions.some(q => q.allowFreeform && q.options.length > 0), "real question did not offer text plus choices");
    const nonce = "native-input-" + randomBytes(8).toString("hex");
    const before = events.length;
    await opened.client.call({ type: "session.respondPermission", payload: { sessionId, requestId: request!.id,
      outcome: { outcome: "answered", answers: questions.map(q => ({ questionId: q.id,
        selectedOptionIds: q.options[0] ? [q.options[0].id] : [], freeformText: q.allowFreeform ? nonce : undefined })) } } });
    await t.tools.waitUntil(() => events.slice(before).some(e => e.type === "turnCompleted" || e.type === "turnFailed"), 60_000);
    const after = await snapshot();
    t.assertions.assert(!events.slice(before).some(e => e.type === "turnFailed") && after.pendingPermissions.length === 0
      && after.items.some(i => i.type === "assistantMessage" && i.text.includes(nonce)), "answer did not reach resumed real model");
    t.note(`model=${model!.id}; conversationQuestion=${request!.id}; answeredInSameSession=true`);
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

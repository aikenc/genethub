import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineJourney, hideHostAgentClis, seedScriptAgentRuntime } from "../../framework/public.ts";

defineJourney({
  id: "journey.session.provider-self-bootstrap.builtin",
  title: "The built-in Agent uses the same public provider configuration as a third-party Agent",
  oracle: "an actual built-in Agent tool invokes provider configure, the same Session stops for Human input, direct credential submission verifies a model, and its resumed LLM receives a receipt prompt with no key; unrelated Claude configuration is untouched",
  catches: ["only third-party Agents can self-bootstrap", "new execution loses original Session", "key enters resumed model request"],
  tags: ["core", "session", "provider-self-bootstrap"], llm: { default: "mock" },
  expectedDurationMs: 25_000, timeoutMs: 120_000,
  surfaces: ["daemon", "builtin-agent", "real-cli", "workbench-client", "external-model-endpoint"],
  productInterfaces: ["genet provider configure", "provider.operation", "session.send", "session.get"],
}, async t => {
  hideHostAgentClis(t.env); seedScriptAgentRuntime(t.env);
  const s = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(s.client, s.mock);
    const sessionId = await t.flows.main.createBuiltinSession(s.client, s.workspaceId);
    const events = await t.flows.main.attachEventLog(s.client, sessionId);
    const command = '"$GENEHUB_CLI" provider configure self-bootstrap --session "$GENEHUB_SESSION_ID" --action builtin-provider-action --base-url ' + s.mock.origin + ' --dialect openai --label SelfBootstrap --model mock-llm';
    s.mock.script({ tool: { name: "bash", arguments: { command } } });
    await t.flows.main.sendPrompt(s.client, sessionId, "给 GeneHub 添加模型 provider，密钥我来输入。", null, "u_" + randomBytes(16).toString("hex"));
    const snapshot = async () => {
      const reply = await s.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("no snapshot");
      return reply.data;
    };
    await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions.some(p => p.kind === "providerConfiguration"), 30_000);
    const original = await snapshot();
    const key = "test-builtin-" + randomBytes(20).toString("hex");
    // One non-streaming probe, then the resumed actual Agent's model turn.
    s.mock.script({ text: "ok" }, { text: "Provider operation checked." });
    const receipt = await s.client.call({ type: "provider.operation", payload: { sessionId,
      operation: { type: "submit", actionId: "builtin-provider-action", approved: true, apiKey: key } } });
    t.assertions.assert(receipt?.type === "providerOperation" && receipt.data.validation.status === "ready", "built-in configuration did not verify");
    await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle" && events.some(e => e.type === "turnCompleted"), 30_000);
    t.assertions.assert((await snapshot()).summary.id === original.summary.id && s.mock.requests.length >= 3, "built-in Agent did not resume the same Session");
    t.assertions.assert(!JSON.stringify([await snapshot(), s.mock.requests, receipt]).includes(key), "secret reached built-in model context");
    t.assertions.assert(!existsSync(path.join(t.env.home, ".claude", "settings.json")), "configuration touched Claude settings");
  } finally { s.client.close(); s.daemon.stop(); await s.mock.stop(); }
});

defineJourney({
  id: "journey.session.provider-self-bootstrap.discovery",
  title: "Real Codex discovers platform provider configuration from the feedback's natural language",
  oracle: "a real model finds provider.configure without a supplied command, prepares the specified GeneHub provider in the original conversation, accepts direct Human credential input, and resumes to inspect the verified receipt without changing Claude configuration",
  catches: ["Agent can call forced tools but cannot discover the flow", "wrong software configured", "Agent asks for the key in chat", "successful save never completes the original goal"],
  tags: ["third-party", "session", "codex", "provider-self-bootstrap"],
  llm: { default: "real" }, resources: { pool: "real-llm" },
  expectedDurationMs: 60_000, timeoutMs: 240_000,
  surfaces: ["daemon", "real-codex-cli", "real-model", "workbench-client"],
  productInterfaces: ["genet provider", "provider.operation", "session.get", "session.send"],
}, async t => {
  t.flows.main.seedHostCodexLogin(t.env, { includeMcpServers: false }); seedScriptAgentRuntime(t.env);
  const s = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const agent = await t.flows.main.requireAgentReady(s.client, "codex", 60_000);
    const model = agent.catalog.models.find(m => m.id === "gpt-6-luna") ?? agent.catalog.models[0];
    t.assertions.assert(!!model, "real Codex has no discovery model");
    const sessionId = await t.flows.main.createAgentSession(s.client, { workspaceId: s.workspaceId, agentId: "codex", modelId: model!.id });
    const events = await t.flows.main.attachEventLog(s.client, sessionId);
    const claude = path.join(t.env.home, ".claude", "settings.json");
    const original = existsSync(claude) ? readFileSync(claude, "utf8") : null;
    await t.flows.main.sendPrompt(s.client, sessionId, `帮忙配置 GeneHub 的 genet Agent：添加一个叫 discovery-provider 的自定义 provider，Claude API 风格（Anthropic），地址 ${s.mock.origin}，模型 mock-llm。密钥我来输入。请通过平台提供的能力完成，验证后告诉我结果。`, null, "u_" + randomBytes(16).toString("hex"));
    const snapshot = async () => {
      const reply = await s.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("no snapshot");
      return reply.data;
    };
    await t.tools.waitUntil(async () => {
      const snap = await snapshot();
      if (snap.pendingPermissions.some(p => p.kind === "providerConfiguration")) return true;
      if (events.some(e => e.type === "turnCompleted" || e.type === "turnFailed")) throw new Error("real Agent ended without a platform provider configuration card");
      return false;
    }, 90_000);
    const request = (await snapshot()).pendingPermissions.find(p => p.kind === "providerConfiguration")!;
    const actionId = request.id.slice("provider-".length);
    const prepared = await s.client.call({ type: "provider.operation", payload: { sessionId, operation: { type: "get", actionId } } });
    t.assertions.assert(prepared?.type === "providerOperation" && prepared.data.draft.providerId === "discovery-provider" && prepared.data.draft.dialect === "anthropic" && prepared.data.draft.baseUrl === s.mock.origin, "real model configured a different target");
    const key = "test-discovery-" + randomBytes(20).toString("hex");
    const before = events.length;
    await s.client.call({ type: "provider.operation", payload: { sessionId, operation: { type: "submit", actionId, approved: true, apiKey: key } } });
    await t.tools.waitUntil(() => events.slice(before).some(e => e.type === "turnCompleted" || e.type === "turnFailed"), 90_000);
    t.assertions.assert(!events.slice(before).some(e => e.type === "turnFailed") && (await snapshot()).pendingPermissions.length === 0, "real model did not finish the original task");
    t.assertions.assert((existsSync(claude) ? readFileSync(claude, "utf8") : null) === original, "real Agent changed unrelated Claude settings");
    t.assertions.assert(!JSON.stringify(await snapshot()).includes(key), "real model conversation contains credential");
    t.note(`model=${model!.id}; naturalDiscovery=true; sameSession=true; providerDialect=anthropic`);
  } finally { s.client.close(); s.daemon.stop(); await s.mock.stop(); }
});

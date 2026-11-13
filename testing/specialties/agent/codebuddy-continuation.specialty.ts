import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineSpecialty, hideHostAgentClis, seedScriptAgentRuntime } from "../../framework/public.ts";

// Vendor trace: old HY history loads in1.6s, then cache-expiry compaction streams
// internally for >90s before a live frame. The fixture models that external
// boundary; the delivered candidate must also recover the actual original HY.
defineSpecialty({
  id: "specialty.agent.codebuddy-continuation",
  title: "CodeBuddy context preparation survives the first-frame boundary without losing Stop or inputs",
  oracle: "same native SID completes an exactly-once continuation after95s with original provider resume ID; Stop retains its pending input; a genuinely silent fresh conversation still fails around90s",
  catches: ["90s watch kills productive pre-message compaction", "resume context or original history lost", "long continuation disables Stop", "fresh startup silently waits15minutes", "control replies pretend the turn answered"],
  tags: ["core", "agent", "codebuddy", "continuation"], llm: { default: "none" },
  expectedDurationMs: 215_000, timeoutMs: 300_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "script-agent", "workbench-client", "filesystem"],
  productInterfaces: ["@genehub/workbench/client", "agent-serve-protocol-1", "CodeBuddy stream-json"],
}, async t => {
  hideHostAgentClis(t.env);
  seedScriptAgentRuntime(t.env);
  const bin = path.join(t.env.data, "agents", "state", "codebuddy", "npm", "bin");
  mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, "cbc");
  copyFileSync(fileURLToPath(new URL("../../fixtures/codebuddy-continuation.cjs", import.meta.url)), cli);
  chmodSync(cli, 0o700);
  const config = path.join(t.env.root, "cbc-continuation.json");
  const journal = path.join(t.env.root, "cbc-continuation.ndjson");
  const configure = (silent: boolean) => writeFileSync(config, JSON.stringify({ journal, silent }));
  configure(false);
  t.env.env.GENEHUB_CBC_CONTINUATION = config;
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const entries = () => existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { event: string; at: number; resumed?: boolean; resumeId?: string; subtype?: string }) : [];
  const rounds = async (sessionId: string) => {
    const r = await opened.client.call({ type: "session.rounds", payload: { sessionId, throughRoundId: null, cursor: null, limit: 100 } });
    if (r?.type !== "sessionRounds") throw new Error("missing native rounds");
    return r.data.rounds;
  };
  const snapshot = async (sessionId: string) => {
    const r = await opened.client.call({ type: "session.get", payload: { sessionId } });
    if (r?.type !== "snapshot") throw new Error("missing native Session");
    return r.data.summary;
  };
  const create = async () => {
    const r = await opened.client.call({ type: "session.create", payload: { workspaceId: opened.workspaceId, agentId: "codebuddy", modelId: "hy4std", modeId: "bypassPermissions", title: null, cwd: null } });
    if (r?.type !== "session") throw new Error("missing created Session");
    return r.data.id;
  };
  try {
    await t.flows.branches.waitForAgent(opened.client, "codebuddy", t.flows.branches.agentReady, { timeoutMs: 30_000 });
    const id = await create();
    await t.flows.main.sendPrompt(opened.client, id, "Initial request", null, "initial-once");
    await t.tools.waitUntil(async () => (await rounds(id)).some(r => r.outcome === "completed"), 15_000);
    // Recycle the actual external CLI process, preserving the real native SID.
    await opened.client.call({ type: "agent.reload", payload: { agentId: "codebuddy" } });
    await t.flows.branches.waitForAgent(opened.client, "codebuddy", t.flows.branches.agentReady);
    const start = Date.now();
    await t.flows.main.sendPrompt(opened.client, id, "Continue original request", null, "continuation-once");
    await t.tools.waitUntil(async () => (await rounds(id)).filter(r => r.outcome !== "running").length >= 2, 120_000);
    const completed = await rounds(id);
    t.assertions.assert(completed.length === 2 && completed.every(r => r.outcome === "completed"), "continuation failed before CodeBuddy finished preparing context");
    t.assertions.assert(Date.now() - start >= 95_000, "did not exercise the real90s first-frame boundary");
    t.assertions.assert(entries().filter(e => e.event === "user").length === 2
      && entries().some(e => e.event === "launch" && e.resumed && e.resumeId === "preserved-provider-context"), "input replayed or provider context changed");
    const narrative = await opened.client.call({ type: "session.narrative", payload: { sessionId: id, itemId: null, cursor: null, throughRoundId: null, limit: 100 } });
    t.assertions.assert(narrative?.type === "sessionNarrative" && narrative.data.items.filter(i => i.type === "assistantMessage").length === 2, "prior reply lost or duplicated");
    await opened.client.call({ type: "agent.reload", payload: { agentId: "codebuddy" } });
    await t.flows.branches.waitForAgent(opened.client, "codebuddy", t.flows.branches.agentReady);
    await t.flows.main.sendPrompt(opened.client, id, "Stop this preparation", null, "stop-preserved");
    await t.tools.waitUntil(() => entries().filter(e => e.event === "user").length === 3, 10_000);
    await opened.client.call({ type: "session.interrupt", payload: { sessionId: id } });
    await t.tools.waitUntil(async () => (await snapshot(id)).inputSummary?.paused === true, 20_000);
    const stopped = await snapshot(id);
    t.assertions.assert(stopped.inputSummary?.pendingMessageIds.includes("stop-preserved"), "Stop lost the retained original input");
    configure(true);
    const fresh = await create();
    const silentStart = Date.now();
    await t.flows.main.sendPrompt(opened.client, fresh, "Genuinely silent fresh start", null, "fresh-silent");
    await t.tools.waitUntil(async () => (await rounds(fresh)).some(r => r.outcome === "failed"), 110_000);
    const failed = await rounds(fresh);
    const elapsed = Date.now() - silentStart;
    t.assertions.assert(failed[0]?.failureCode === "timeout" && elapsed >= 90_000 && elapsed < 110_000, "fresh startup lost its bounded90s failure");
    t.assertions.assert((await snapshot(fresh)).inputSummary?.pendingMessageIds.includes("fresh-silent"), "timeout lost pending input");
    t.note("Real95s external continuation, original SID/resume/history and exactly-once input; Stop retains pending input; fresh silence times out90s. Vendor original HY still requires delivered canary.");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

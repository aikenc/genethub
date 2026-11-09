import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TimelineItem } from "@genehub/proto";
import { defineSpecialty, parseJson, runGenetAsync, seedScriptAgentRuntime } from "../../framework/public.ts";

// A small real-model sample, not a deterministic replay of prescribed CLI calls.
// The model receives a visible title and a business goal, never commands, cursor
// hints, hidden session IDs or the answer. Existing interface specialties own the
// exhaustive pagination, failure and metadata-only-read assertions.
defineSpecialty({
  id: "specialty.cli.query-discovery.real-model",
  title: "A real Agent finds an older conversation and its delivered result without re-running work",
  oracle: "a conversation absent from the first default page is found from its title; a random acceptance code stored only in its historical reply and its idle state reach the report; the original conversation and session inventory remain unchanged",
  catches: ["one page mistaken for all history", "state mistaken for transcript", "old get JSON shape treated as empty", "read failure causes duplicate dispatch"],
  tags: ["cli", "cli-usability", "real-model", "codex"],
  llm: { default: "real" },
  resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 0, pool: "real-llm" },
  expectedDurationMs: 60_000, timeoutMs: 240_000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["genet-cli", "daemon", "real-codex-cli", "real-model"],
  productInterfaces: ["genet-cli", "session.create", "session.send", "session.get", "session.page"],
}, async t => {
  t.flows.main.seedHostCodexLogin(t.env, { includeMcpServers: false });
  seedScriptAgentRuntime(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const target = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const title = "旧项目交付核验-" + randomBytes(4).toString("hex");
    const acceptanceCode = "accepted-" + randomBytes(16).toString("hex");
    await opened.client.call({ type: "session.rename", payload: { sessionId: target, title } });
    const seedEvents = await t.flows.main.attachEventLog(opened.client, target);
    // Keep the answer outside bounded message previews as well as the prompt.
    opened.mock.script({ text: "交付说明与背景。".repeat(256) + `验收口令：${acceptanceCode}` + "附录与交付说明。".repeat(256) });
    await t.flows.main.sendPrompt(opened.client, target, "完成交付后告诉我验收口令。");
    await t.tools.waitUntil(() => seedEvents.some(e => e.type === "turnCompleted" || e.type === "turnFailed"), 30_000);
    t.assertions.assert(!seedEvents.some(e => e.type === "turnFailed"), "historical fixture did not complete");
    const snapshot = async (sessionId: string) => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("missing public snapshot");
      return reply.data;
    };
    const original = await snapshot(target);
    t.assertions.assert(original.summary.status === "idle" && original.items.some(item => item.type === "assistantMessage" && item.text.includes(acceptanceCode)), "oracle is not a saved completed delivery");
    const stateOnly = await runGenetAsync(opened.daemon.genet, ["session", "get", target], opened.daemon.env);
    t.assertions.assert(stateOnly.code === 0 && !stateOnly.stdout.includes(acceptanceCode), "answer leaked into the bounded state projection");
    for (let i = 0; i < 54; i++) await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const first = await runGenetAsync(opened.daemon.genet, ["session", "list"], opened.daemon.env);
    const page = parseJson(first.stdout).data as { complete: boolean; sessions: {id: string}[] };
    t.assertions.assert(first.code === 0 && !page.complete && !page.sessions.some(s => s.id === target), "older target is not beyond the default first page");

    const agent = await t.flows.main.requireAgentReady(opened.client, "codex", 60_000);
    const model = agent.catalog.models.find(m => m.id === "gpt-6-luna") ?? agent.catalog.models[0];
    t.assertions.assert(!!model, "real Codex offers no discovery model");
    const observer = await t.flows.main.createAgentSession(opened.client, { workspaceId: opened.workspaceId, agentId: "codex", modelId: model!.id });
    const events = await t.flows.main.attachEventLog(opened.client, observer);
    await t.flows.main.sendPrompt(opened.client, observer,
      `请在 GeneHub 中找到标题为「${title}」的旧会话，确认它现在是否仍在执行，并取回它最后一次回复中的验收口令。只核查已有记录，不续跑、不派新任务、不向原会话发送消息。把结论保存到当前项目的 delivery-audit.json，字段为 title、running（布尔值）、acceptanceCode。`);
    await t.tools.waitUntil(() => events.some(e => e.type === "turnCompleted" || e.type === "turnFailed"), 150_000);
    const observerState = await snapshot(observer);
    const reportFile = path.join(opened.workspaceRoot, "delivery-audit.json");
    t.assertions.assert(!events.some(e => e.type === "turnFailed") && existsSync(reportFile), "real Agent did not produce the requested audit; " + observerState.items.filter(item => item.type === "assistantMessage").map(item => item.text).join("\n").slice(-2500));
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    t.assertions.assert(report.title === title && report.running === false && report.acceptanceCode === acceptanceCode, "real Agent confused current state, missing history or delivered result");
    // Visible tool headers deliberately clip long commands. Resolve the existing
    // public process-detail blobs instead of drawing conclusions from that clip.
    const rounds = await opened.client.call({ type: "session.rounds", payload: { sessionId: observer, cursor: null, throughRoundId: null, limit: 20 } });
    if (rounds?.type !== "sessionRounds" || rounds.data.nextCursor) throw new Error("missing complete source rounds");
    const tools: TimelineItem[] = [];
    for (const round of rounds.data.rounds) {
      const layer = await opened.client.call({ type: "round.trunk.list", payload: { sessionId: observer, roundId: round.roundId, cursor: null, limit: 100 } });
      if (layer?.type !== "roundLayer" || layer.data.nextCursor) throw new Error("missing complete source trunks");
      for (const trunk of layer.data.trunks) {
        const detail = await opened.client.call({ type: "round.trunk.get", payload: { sessionId: observer, roundId: round.roundId, trunkIndex: trunk.index } });
        if (detail?.type !== "roundTrunk") throw new Error("missing source trunk");
        for (const row of detail.data.batches.flatMap(batch => batch.blobs)) {
          if (row.kind !== "toolCall" || !row.blob) continue;
          const blob = await opened.client.call({ type: "blob.get", payload: { sessionId: observer, blob: row.blob } });
          if (blob?.type !== "blob") throw new Error("missing source tool");
          tools.push(blob.data.value as TimelineItem);
        }
      }
    }
    const toolInputs = tools.filter(item => item.type === "toolCall").map(item => {
      if (item.detail.kind === "overview") return item.detail.input;
      if (item.detail.kind === "shell") return item.detail.command;
      if (item.detail.kind === "unknown") return JSON.stringify(item.detail.raw);
      return "";
    }).join("\n");
    t.assertions.assert(toolInputs.includes("session") && (toolInputs.includes("GENEHUB_CLI") || toolInputs.includes("genet")), "audit did not exercise the public CLI discovery path; inputs=" + toolInputs.slice(-2500));
    const after = await snapshot(target);
    const inventory = await opened.client.call({ type: "session.page", payload: { requests: [{ workspaceId: opened.workspaceId, cursor: null, limit: 100 }], includeArchived: true } });
    t.assertions.assert(JSON.stringify(after.items) === JSON.stringify(original.items) && after.summary.updatedAtMs === original.summary.updatedAtMs, "audit changed or resumed the original conversation");
    t.assertions.assert(inventory?.type === "sessionPages" && inventory.data[0]?.nextCursor == null && inventory.data[0]?.sessions.length === 56, "read-only audit created duplicate work or lost sessions");
    t.note(`model=${model!.id}; beyondFirstPage=true; currentStateAndHistoricalResult=true; originalUnchanged=true; sessions=56`);
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

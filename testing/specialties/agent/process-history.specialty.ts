import { readFileSync } from "node:fs";
import { defineSpecialty, registerScriptedCodex } from "../../framework/public.ts";

const frame = (method: string, body: Record<string, unknown>) => ({ method, params: { threadId: "$THREAD", turnId: "$TURN", ...body } });
const message = (id: string) => [
  frame("item/started", { item: { id, type: "agentMessage", text: "" } }),
  frame("item/agentMessage/delta", { itemId: id, delta: id }),
  frame("item/completed", { item: { id, type: "agentMessage", text: id } }),
];
const usage = (n: number) => frame("thread/tokenUsage/updated", { tokenUsage: {
  total: { inputTokens: n * 100, cachedInputTokens: n * 80, outputTokens: n * 10 },
  last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 },
} });
const tool = (id: string) => frame("item/completed", { item: {
  id, type: "commandExecution", command: `echo ${id}`, status: "completed", aggregatedOutput: id, exitCode: 0,
} });

defineSpecialty({
  id: "specialty.agent.process-history",
  title: "Codex turn usage, compaction history and fork process boundaries survive public reads",
  oracle: "scripted public app-server frames yield turn-local usage, all tool blobs on both sides of compaction, and identical inherited history after restart",
  catches: ["thread totals shown as turn usage", "duplicate usage inflates rounds", "started and completed compaction split twice", "thread and item compaction split twice", "compaction closing marker strands later tools", "terminal usage absent from trunks", "fork loses process access", "fork can read later parent blobs"],
  tags: ["core", "session", "process-history"],
  llm: { default: "none" },
  expectedDurationMs: 30_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent-adapter", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client", "codex-app-server-v2"],
}, async (t) => {
  const journal = registerScriptedCodex(t.env, [
    [...message("before"), usage(1), tool("before-tool"),
      frame("item/started", { item: { id: "compact-item", type: "contextCompaction" } }),
      frame("item/completed", { item: { id: "compact-item", type: "contextCompaction" } }),
      ...message("middle"), usage(2), tool("middle-tool"),
      frame("item/started", { item: { id: "compact-thread-first", type: "contextCompaction" } }),
      frame("thread/compacted", {}),
      frame("item/completed", { item: { id: "compact-thread-first", type: "contextCompaction" } }),
      ...message("after"), usage(3), usage(3), tool("after-tool"), ...message("final"), usage(4)],
    [...message("second-final"), usage(5)],
    [...message("later"), usage(6), tool("later-tool"),
      frame("item/started", { item: { id: "compact-item-first", type: "contextCompaction" } }),
      frame("item/completed", { item: { id: "compact-item-first", type: "contextCompaction" } }),
      frame("thread/compacted", {}), ...message("later-final"), usage(7)],
  ]);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let client = opened.client;
  let restarted: typeof opened | undefined;
  try {
    const created = await client.call({ type: "session.create", payload: {
      workspaceId: opened.workspaceId, agentId: "codex", modelId: "scripted", modeId: null, title: null, cwd: null,
    } });
    if (created?.type !== "session") throw new Error("Codex session was not created");
    const sessionId = created.data.id;
    const send = async (prompt: string) => {
      await t.flows.main.sendPrompt(client, sessionId, prompt);
      await t.tools.waitUntil(async () => {
        const state = await client.call({ type: "session.get", payload: { sessionId } });
        return state?.type === "snapshot" && state.data.summary.status === "idle";
      }, 30_000);
      const history = await client.call({ type: "session.narrative", payload: { itemId: null, sessionId, limit: 100, throughRoundId: null, cursor: null } });
      if (history?.type !== "sessionNarrative") throw new Error("missing narrative");
      const summary = history.data.items.filter((item) => item.type === "turnSummary").at(-1);
      if (summary?.type !== "turnSummary") throw new Error("missing completed turn");
      return summary.stats;
    };
    const first = await send("First request");
    t.assertions.assert(first.usage.inputTokens === 400 && first.usage.llmRounds === 4 && first.usage.compactionCount === 2,
      `first usage or duplicate counting: ${JSON.stringify(first.usage)}`);
    const rounds = await client.call({ type: "session.rounds", payload: { sessionId, limit: 100, throughRoundId: null, cursor: null } });
    if (rounds?.type !== "sessionRounds" || !rounds.data.rounds[0]) throw new Error("missing first round");
    const roundId = rounds.data.rounds[0].roundId;
    const readProcess = async (id: string) => {
      const layer = await client.call({ type: "round.trunk.list", payload: { sessionId: id, roundId, limit: 100, cursor: null } });
      if (layer?.type !== "roundLayer") throw new Error("missing process layer");
      const rows = [];
      for (const summary of layer.data.trunks) {
        const trunk = await client.call({ type: "round.trunk.get", payload: { sessionId: id, roundId, trunkIndex: summary.index } });
        if (trunk?.type !== "roundTrunk") throw new Error("missing trunk");
        rows.push(...trunk.data.batches.flatMap((batch) => batch.blobs));
      }
      t.assertions.assert(layer.data.trunks.length === 3, `two compactions did not close exactly two trunks: ${JSON.stringify(layer.data.trunks)}`);
      t.assertions.assert(layer.data.trunks.reduce((sum, trunk) => sum + (trunk.llmRounds ?? 0), 0) === 4,
        "trunk request counts do not reconcile with turn usage");
      t.assertions.assert(rows.length === 3 && rows.some((row) => row.itemId === "before-tool") && rows.some((row) => row.itemId === "middle-tool") && rows.some((row) => row.itemId === "after-tool"),
        "lost tool before or after compaction");
      for (const row of rows) {
        if (!row.blob) throw new Error("tool has no blob reference");
        const payload = await client.call({ type: "blob.get", payload: { sessionId: id, blob: row.blob } });
        t.assertions.assert(payload?.type === "blob" && JSON.stringify(payload.data.value).includes(row.itemId), "tool source is unreadable");
      }
      return rows;
    };
    await readProcess(sessionId);
    const second = await send("Second request");
    t.assertions.assert(second.usage.inputTokens === 100 && second.usage.outputTokens === 10 && second.usage.llmRounds === 1 && second.usage.compactionCount === 0 && second.toolCalls === 0,
      `second turn inherited history: ${JSON.stringify(second)}`);
    const forked = await client.call({ type: "session.fork", payload: { sessionId, turnId: second.turnId,
      target: { agentId: "codex", modelId: "scripted" } } });
    if (forked?.type !== "session") throw new Error("fork failed");
    const forkId = forked.data.id;
    await readProcess(forkId);
    await send("Parent work after fork");
    const laterRounds = await client.call({ type: "session.rounds", payload: { sessionId, limit: 100, throughRoundId: null, cursor: null } });
    if (laterRounds?.type !== "sessionRounds") throw new Error("missing later rounds");
    const laterId = laterRounds.data.rounds.at(-1)!.roundId;
    let rejected = false;
    try { await client.call({ type: "round.trunk.list", payload: { sessionId: forkId, roundId: laterId, limit: 100, cursor: null } }); }
    catch { rejected = true; }
    t.assertions.assert(rejected, "fork exposed a later parent round");
    const laterTrunk = await client.call({ type: "round.trunk.get", payload: { sessionId, roundId: laterId, trunkIndex: 0 } });
    if (laterTrunk?.type !== "roundTrunk") throw new Error("missing later trunk");
    const laterLayer = await client.call({ type: "round.trunk.list", payload: { sessionId, roundId: laterId, limit: 100, cursor: null } });
    t.assertions.assert(laterLayer?.type === "roundLayer" && laterLayer.data.trunks.length === 2,
      "item-first compaction notification created a duplicate trunk");
    const laterBlob = laterTrunk.data.batches.flatMap((batch) => batch.blobs)[0]?.blob;
    if (!laterBlob) throw new Error("missing later tool blob");
    rejected = false;
    try { await client.call({ type: "blob.get", payload: { sessionId: forkId, blob: laterBlob } }); }
    catch { rejected = true; }
    t.assertions.assert(rejected, "fork exposed a later parent blob");
    t.assertions.assert(readFileSync(journal, "utf8").trim().split("\n").length === 3, "fixture path did not execute three requests");
    client.close(); opened.daemon.stop();
    restarted = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    client = restarted.client;
    await readProcess(forkId);
  } finally {
    client.close(); opened.daemon.stop(); await opened.mock.stop();
    if (restarted) { restarted.daemon.stop(); await restarted.mock.stop(); }
  }
});

import { readFileSync } from "node:fs";
import { daemonEndpoint, defineSpecialty, registerScriptedCodex } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.agent.fork-load",
  title: "Long fork history reads stay bounded and leave subscriptions responsive",
  oracle: "50 warm detail reads do not reread 50 copies of ancestor narrative; concurrent title changes arrive on the subscribed client",
  catches: ["ancestor history reparsed per trunk request", "history traffic blocks state updates", "reconnect loses fork process access"],
  tags: ["core", "session", "fork-load"],
  expectedDurationMs: 30_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client", "codex-app-server-v2"],
}, async (t) => {
  const count = 25;
  registerScriptedCodex(t.env, Array.from({ length: count }, (_, n) => [
    { method: "item/completed", params: { threadId: "$THREAD", turnId: "$TURN", item: {
      id: `answer-${n}`, type: "agentMessage", text: `history-${n} ` + "narrative ".repeat(4096),
    } } },
  ]));
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let reader = await t.flows.main.openSecondClient(opened);
  try {
    const created = await opened.client.call({ type: "session.create", payload: {
      workspaceId: opened.workspaceId, agentId: "codex", modelId: "scripted", modeId: null, title: null, cwd: null,
    } });
    if (created?.type !== "session") throw new Error("missing source");
    const source = created.data.id;
    for (let i = 0; i < count; i++) {
      await t.flows.main.sendPrompt(opened.client, source, `request ${i}`);
      await t.tools.waitUntil(async () => {
        const r = await opened.client.call({ type: "session.get", payload: { sessionId: source } });
        return r?.type === "snapshot" && r.data.summary.status === "idle";
      }, 10_000);
    }
    const history = await opened.client.call({ type: "session.narrative", payload: { sessionId: source, itemId: null, cursor: null, limit: 100, throughRoundId: null } });
    if (history?.type !== "sessionNarrative") throw new Error("missing narrative");
    const last = history.data.items.filter((item) => item.type === "turnSummary").at(-1);
    if (last?.type !== "turnSummary") throw new Error("missing fork boundary");
    const fork = await opened.client.call({ type: "session.fork", payload: { sessionId: source, turnId: last.stats.turnId, target: { agentId: "codex", modelId: "scripted" } } });
    if (fork?.type !== "session") throw new Error("missing fork");
    const sessionId = fork.data.id;
    const rounds = await reader.call({ type: "session.rounds", payload: { sessionId, limit: 100, cursor: null, throughRoundId: null } });
    if (rounds?.type !== "sessionRounds" || rounds.data.rounds.length !== count) throw new Error("incomplete inherited rounds");
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    const pid = daemonEndpoint(opened.daemon).localServerProof.pid;
    const readChars = () => process.platform === "linux"
      ? Number(/^rchar:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/io`, "utf8"))?.[1] ?? NaN) : null;
    const before = readChars();
    const started = Date.now();
    for (let n = 0; n < 50; n++) {
      const roundId = rounds.data.rounds[n % count]!.roundId;
      const [detail] = await Promise.all([
        reader.call({ type: "round.trunk.get", payload: { sessionId, roundId, trunkIndex: 0 } }),
        opened.client.call({ type: "session.rename", payload: { sessionId, title: `responsive-${n}` } }),
      ]);
      t.assertions.assert(detail?.type === "roundTrunk", "detail read failed under load");
    }
    const elapsed = Date.now() - started;
    const after = readChars();
    // Each detail is about 40 KiB. Twelve MiB permits transport, details and
    // metadata overhead, but not 50 full reads of the 1 MiB ancestor narrative.
    if (before !== null && after !== null) t.assertions.assert(after - before < 12 * 1024 * 1024,
      `warm history reads amplified disk input: ${after - before} bytes`);
    t.assertions.assert(elapsed < 15_000, `history traffic took ${elapsed}ms`);
    await t.tools.waitUntil(() => events.some((e) => JSON.stringify(e.raw).includes("responsive-49")), 2000);
    t.assertions.assert(reader.connectionState === "ready" && opened.client.connectionState === "ready", "load disrupted connection");
    reader.close(); reader = await t.flows.main.openSecondClient(opened, "reconnected-history");
    const again = await reader.call({ type: "round.trunk.get", payload: { sessionId, roundId: rounds.data.rounds[0]!.roundId, trunkIndex: 0 } });
    t.assertions.assert(again?.type === "roundTrunk", "reconnected reader lost process access");
    t.note(`25 inherited rounds, 50 detail reads and title updates: ${elapsed}ms; input bytes=${before !== null && after !== null ? after - before : "OS counter unavailable"}; subscribed final title observed; reconnect passed`);
  } finally {
    reader.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

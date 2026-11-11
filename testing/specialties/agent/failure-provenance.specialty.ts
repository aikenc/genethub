import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  defineSpecialty, registerControlledAgent, readControlledAgentJournal,
  daemonEndpoint, parseJson, runGenet, type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

defineSpecialty({
  id: "specialty.agent.failure-provenance",
  title: "Native failure provenance survives history and recovery",
  oracle: "three external SDK errors retain their exact codes through public narrative and rounds across restart; success has none, legacy history stays unknown, and a real unowned crashed round reports only kernelUnsettled",
  catches: ["terminal code lost when folding history", "restart invents a provider error", "legacy missing code becomes a fabricated cause", "optional metadata changes outcomes or usage"],
  tags: ["core", "agent", "session", "failure-provenance", "fault-injection"],
  llm: { default: "none" }, expectedDurationMs: 35_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent-adapter", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
}, async (t) => {
  const codes = ["rateLimited", "upstream", "internal"] as const;
  const agents = codes.map(code => registerControlledAgent(t.env, { id: `failure-${code.toLowerCase()}`, profile: "coded-failure", failureCode: code }));
  const success = registerControlledAgent(t.env, { id: "failure-success", profile: "normal", chunks: 1,
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, llmRounds: 1, tokenUsageStatus: "reported" } });
  const silent = registerControlledAgent(t.env, { id: "failure-unsettled", profile: "accept-then-silent" });
  const opened: Opened[] = [];
  let current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  opened.push(current);
  const sessions: Array<{ id: string; code?: string }> = [];
  const create = async (agentId: string) => {
    await t.flows.branches.waitForAgent(current.client, agentId, t.flows.branches.agentReady, { timeoutMs: 30_000, what: "ready for native failure evidence" });
    const reply = await current.client.call({ type: "session.create", payload: {
      workspaceId: current.workspaceId, agentId, modelId: null, modeId: null, title: null, cwd: null,
    } });
    if (reply?.type !== "session") throw new Error("session.create did not create an actual Session");
    return reply.data.id;
  };
  const history = async (id: string) => {
    const reply = await current.client.call({ type: "session.narrative", payload: { sessionId: id, itemId: null, throughRoundId: null, cursor: null, limit: 100 } });
    if (reply?.type !== "sessionNarrative") throw new Error("missing public narrative");
    return reply.data.items.filter(item => item.type === "turnSummary");
  };
  const rounds = async (id: string) => {
    const reply = await current.client.call({ type: "session.rounds", payload: { sessionId: id, throughRoundId: null, cursor: null, limit: 100 } });
    if (reply?.type !== "sessionRounds") throw new Error("missing public rounds");
    return reply.data.rounds;
  };
  const verify = async (legacy = false) => {
    for (const item of sessions) {
      const turns = await history(item.id);
      const rows = await rounds(item.id);
      const expected = legacy && item.code === "upstream" ? undefined : item.code;
      t.assertions.assert(turns.length === 1 && turns[0].type === "turnSummary"
        && turns[0].stats.outcome === (item.code ? "failed" : "completed")
        && turns[0].stats.failureCode === expected, `native terminal evidence changed for ${item.code ?? "success"}`);
      t.assertions.assert(rows.length === 1 && rows[0].outcome === (item.code ? "failed" : "completed")
        && rows[0].failureCode === expected, `public round cause changed for ${item.code ?? "success"}`);
      if (!item.code && turns[0].type === "turnSummary") {
        t.assertions.assert(turns[0].stats.usage.inputTokens === 12 && turns[0].stats.usage.outputTokens === 7,
          "optional provenance changed actual successful usage");
      }
    }
  };
  let phase = "native terminal evidence";
  try {
    for (const [index, agent] of [...agents, success].entries()) {
      const id = await create(agent.agentId);
      sessions.push({ id, code: codes[index] });
      await t.flows.main.sendPrompt(current.client, id, "Return the configured native terminal result.");
      await t.tools.waitUntil(async () => (await history(id)).length === 1, 15_000);
    }
    await verify();
    phase = "opening interrupted native request";
    const silentId = await create(silent.agentId);
    // Direct native input has no durable replay request. A crash leaves one
    // persisted round without an owner, rather than scheduling a second run.
    await t.flows.main.sendPrompt(current.client, silentId, "Accept this request and stay silent.");
    await t.tools.waitUntil(async () => (await rounds(silentId)).some(row => row.outcome === "running"), 10_000);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    phase = "identifying isolated Host";
    const endpoint = daemonEndpoint(current.daemon);
    const status = parseJson(runGenet(current.daemon.genet, ["daemon", "status"], current.daemon.env).stdout);
    const pid = Number(status.pid);
    const protectedPids = new Set<number>();
    for (const seed of [process.pid, Number(process.env.GENEHUB_AGENT_PID), Number(process.env.GENEHUB_HOST_PID)]) {
      let next = seed;
      while (Number.isInteger(next) && next > 0 && !protectedPids.has(next)) {
        protectedPids.add(next);
        try { next = Number(readFileSync(`/proc/${next}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]); }
        catch { break; }
      }
    }
    t.assertions.assert(pid > 0 && Number.isInteger(pid) && pid === endpoint.localServerProof.pid && !protectedPids.has(pid),
      "isolated daemon process was not safely identified");
    current.client.close();
    process.kill(pid, "SIGKILL");
    phase = "waiting for automatic Host recovery";
    // The real supervisor owns recovery. Its transient CLI-unreachable gap
    // has no JSON reply; wait for a new owned Host, not a manual kickstart.
    await t.tools.waitUntil(() => {
      const probe = runGenet(current.daemon.genet, ["daemon", "status"], current.daemon.env);
      if (probe.code !== 0 || !probe.stdout.trim()) return false;
      const next = parseJson(probe.stdout);
      return next.running === true && Number(next.pid) !== pid;
    }, 15_000);
    phase = "reopening recovered workspace";
    current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
    phase = "verifying recovered native evidence";
    await verify();
    const unsettled = await rounds(silentId);
    t.assertions.assert(unsettled.length === 1 && unsettled[0].outcome === "failed" && unsettled[0].failureCode === "kernelUnsettled",
      "unowned crashed request did not retain its native settlement gap");
    t.assertions.assert(readControlledAgentJournal(silent).filter(entry => entry.event === "prompt").length === 1,
      "reading failure evidence replayed an interrupted direct input");
    current.client.close(); current.daemon.stop();
    phase = "constructing explicit legacy history fixture";
    // Explicit migration fixture: remove only a newly optional code from a
    // real isolated persisted summary, reproducing pre-instrumentation history.
    const legacyId = sessions[1].id;
    const chat = path.join(current.workspaceRoot, ".genethub", "sessions", legacyId, "chat.jsonl");
    let removed = 0;
    const legacy = readFileSync(chat, "utf8").split("\n").map(line => {
      // Native append batches deliberately contain blank separators. Keep
      // those and every unrelated row byte-for-byte in this migration fixture.
      if (!line.trim()) return line;
      const row = JSON.parse(line);
      const before = removed;
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const object = value as Record<string, unknown>;
        if (object.type === "turnSummary" && object.stats && typeof object.stats === "object") {
          const stats = object.stats as Record<string, unknown>;
          if (stats.failureCode === "upstream") { delete stats.failureCode; removed += 1; }
        }
        for (const child of Object.values(object)) visit(child);
      };
      visit(row); return removed > before ? JSON.stringify(row) : line;
    }).join("\n");
    t.assertions.assert(removed === 1, "legacy fixture did not remove exactly one optional terminal code");
    writeFileSync(chat, legacy);
    phase = "reopening legacy history";
    current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
    phase = "verifying legacy unknown cause";
    await verify(true);
    t.note("3 exact native failures, unchanged successful usage, SIGKILL settlement evidence and explicit legacy history verified through public APIs; no score or Team ledger changed.");
  } catch (error) {
    const detail = error instanceof Error ? error : new Error(String(error));
    const locations = (detail.stack ?? "").split("\n").filter(line => line.includes("failure-provenance.specialty.ts"));
    throw new Error(`${phase}: ${detail.message}\n${locations.join("\n")}`);
  } finally {
    for (const workspace of opened) { workspace.client.close(); }
    current.daemon.stop();
    for (const workspace of opened) await workspace.mock.stop();
  }
});

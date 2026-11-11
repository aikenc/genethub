import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-failed-support-settlement",
  title: "Native failed support reports its failure once and non-success conclusions retain unresolved work",
  oracle: "A genuinely failed SDK support remains paused with its original input, but its requester receives one truthful failure result without declaring business success. A separate unfinished, paused writer blocks success yet permits explicit blocked/failed settlement, retaining its real lease and accepting its eventual result.",
  catches: ["unfinished Task suppresses native failure forever", "failure notification resumes failed work", "blocked conclusion waits forever for running support", "non-success settlement releases a paused writer", "late support result is discarded"],
  tags: ["core", "team-result"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.get", "session.inspect"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "failed-support-settlement", [
    { id: "ctl-cli-command", profile: "cli-command" },
    { id: "ctl-failed-support", profile: "coded-failure", failureCode: "upstream" },
  ]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const select = (id: string) => writeFileSync(config, readFileSync(config, "utf8")+"\nTEAM_AGENT="+id+"\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let seq = 0;
    const cli = async (sid: string, args: string[], expected = 0) => {
      const requestId = "settlement."+(++seq);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId }));
      await idle(sid);
      const last = (await r.snapshot(sid)).items.filter(x => {
        if (x.type !== "assistantMessage") return false;
        try { return JSON.parse(x.text).requestId === requestId; } catch { return false; }
      }).at(-1);
      if (last?.type !== "assistantMessage") throw new Error("native task command receipt missing");
      const v = JSON.parse(last.text);
      t.assertions.assert(expected === 0 ? v.code === 0 : v.code !== 0, v.out+v.err);
      return expected === 0 ? JSON.parse(v.out.trim().split("\n").at(-1)!) : v;
    };
    const front = await r.create("ctl-cli-command");
    const task = await cli(front, ["task", "start", "--space", "leader", "--desc", "failure result check", "--request-id", "failure.goal", "Inspect a bounded support failure"]);
    const owner = task.owner.sessionId as string; await idle(owner);
    select("ctl-failed-support");
    const support = await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "native failed support", "--request-id", "failure.support", "Perform a bounded external check"]);
    const child = support.collaborator as string;
    await t.tools.waitUntil(async () => (await r.snapshot(child)).summary.status === "failed", 20000);
    const before = (await r.snapshot(child)).summary.inputSummary;
    t.assertions.assert(before?.paused && before.pendingMessageIds.length > 0, "external failure did not retain real paused input");
    // A native unload/rehydration can project Idle while retaining the kernel's
    // paused failure and original input. This is not a person-initiated pause.
    await r.client.call({ type: "session.close", payload: { sessionId: child } });
    const restored = (await r.snapshot(child)).summary;
    t.assertions.assert(restored.status === "idle" && restored.inputSummary?.paused && restored.inputSummary.error,
      "real native close did not retain the historical failure boundary");
    const record = () => {
      const pending = r.state("pending", child+".json");
      return JSON.parse(readFileSync(existsSync(pending) ? pending : r.state("done", child+".json"), "utf8"));
    };
    r.ok(["tick"]); await idle(owner);
    const first = record();
    t.assertions.assert(first.resultDelivery?.queued === true && first.done?.outcome === "failed",
      "native failed unfinished support never produced a truthful result receipt");
    const matches = async () => (await r.snapshot(owner)).items.filter(x => x.type === "userMessage" && x.id === first.resultDelivery.messageId);
    t.assertions.assert((await matches()).length === 1, "native failure result was not delivered exactly once");
    r.ok(["tick"]); await idle(owner);
    const after = (await r.snapshot(child)).summary.inputSummary;
    t.assertions.assert((await matches()).length === 1 && after?.paused
      && JSON.stringify(after.pendingMessageIds) === JSON.stringify(before.pendingMessageIds),
      "reconciliation resumed failed work, dropped input or replayed its result");
    const nativeTask = JSON.parse(readFileSync(r.state("tasks", task.taskId+".json"), "utf8"));
    t.assertions.assert(!nativeTask.finished && !nativeTask.collaborators[0].finished, "execution failure fabricated a business conclusion");
    await cli(owner, ["task", "finish", task.taskId, "--outcome", "blocked", "Failed external check; business not accepted"]);

    for (const outcome of ["blocked", "failed"]) {
      select("ctl-cli-command");
      const parent = await cli(front, ["task", "start", "--space", "leader", "--desc", outcome+" with pending work", "--request-id", "pending."+outcome, "Conclude honestly with unfinished support"]);
      const coordinator = parent.owner.sessionId as string; await idle(coordinator);
      const writer = await cli(coordinator, ["task", "support", parent.taskId, "--space", "qa", "--desc", "unfinished writer", "--request-id", "writer."+outcome, "Keep a bounded independent writer obligation"]);
      const sid = writer.collaborator as string; await idle(sid);
      const dir = join(r.root, "writer-"+outcome); mkdirSync(dir);
      await cli(sid, ["task", "bind-directory", parent.taskId, "--directory", dir]);
      await r.client.call({ type: "session.interrupt", payload: { sessionId: sid } });
      const pending = JSON.parse(readFileSync(r.state("pending", sid+".json"), "utf8"));
      t.assertions.assert(existsSync(pending.lock), "actual writer lock absent");
      await cli(coordinator, ["task", "finish", parent.taskId, "--outcome", "success", "Must not ignore missing support"], 1);
      await cli(coordinator, ["task", "finish", parent.taskId, "--outcome", outcome, "Unfinished support retained; no success claimed"]);
      const concluded = JSON.parse(readFileSync(r.state("tasks", parent.taskId+".json"), "utf8"));
      t.assertions.assert(concluded.finished?.outcome === outcome
        && concluded.finished.unresolvedWork?.pending.some((x: any) => x.sessionId === sid), "non-success conclusion lost its outstanding support evidence");
      r.ok(["tick"]); await idle(front);
      t.assertions.assert(existsSync(pending.lock) && (await r.snapshot(sid)).summary.inputSummary?.paused,
        "parent non-success conclusion released or resumed its paused writer");
      await cli(sid, ["task", "finish", parent.taskId, "--outcome", "success", "Actual late independent support result"]);
      r.ok(["tick"]); await idle(coordinator);
      const delivered = (await r.snapshot(coordinator)).items.some(x => x.type === "userMessage" && x.text.startsWith("用途: result\n") && x.text.includes("Actual late independent support result"));
      t.assertions.assert(delivered && !existsSync(pending.lock), "late result or actual safe writer release was lost after parent settlement");
    }
    t.note("Actual external SDK failure/native pause/real task and lease; no live Team state mutation, no failure interpreted as business success.");
  } finally { await r.dispose(); }
});

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-conclusion-delivery",
  title: "Explicit task conclusions survive an advanced reply baseline and incomplete legacy archival",
  oracle: "Real Agent-bound task finish produces one native result even when the reply baseline already advanced; a restored incomplete archive recovers through the public timer, preserves requester pause and original conclusion time, and never replays completed delivery.",
  catches: ["reply baseline hides an explicit conclusion", "legacy archive permanently loses a result", "recovery resumes Human pause", "repeated recovery duplicates result or business", "quiet or superseded archives are rearmed"],
  tags: ["core", "team-result"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.get", "Team persisted pending/done ledger"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "conclusion-delivery", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = path.join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const front = await r.create("ctl-cli-command");
    const ok = async (sid: string, args: string[]) => {
      await r.send(sid, JSON.stringify({ argv: ["python3", path.join(r.root, "tools/run.py"), ...args], cwd: r.root }));
      await idle(sid);
      const last = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage").at(-1);
      if (last?.type !== "assistantMessage") throw new Error("native caller has no command result");
      const result = JSON.parse(last.text);
      t.assertions.assert(result.code === 0, "public task failed: " + result.out + result.err);
      return JSON.parse(result.out.trim().split("\n").at(-1)!);
    };
    const copies = async (marker: string) => (await r.snapshot(front)).items.filter(x =>
      x.type === "userMessage" && x.text.startsWith("用途: result\n") && x.text.includes(marker));
    const completed = async (id: string, marker: string) => {
      const task = await ok(front, ["task", "start", "--space", "leader", "--desc", id, "--request-id", id, "Complete a bounded check"]);
      const sid = task.owner.sessionId as string; await idle(sid);
      await ok(sid, ["task", "finish", task.taskId, "--outcome", "success", marker]);
      const taskPath = r.state("tasks", task.taskId + ".json");
      const state = JSON.parse(readFileSync(taskPath, "utf8"));
      const pending = r.state("pending", sid + ".json"), done = r.state("done", sid + ".json");
      const record = JSON.parse(readFileSync(pending, "utf8"));
      // Explicit persisted-state boundary fixture: a prior reconciliation has
      // already observed this real reply while the task was still unfinished.
      record.baseline = (await r.snapshot(sid)).summary.latestReply!.itemId;
      writeFileSync(pending, JSON.stringify(record));
      return { sid, taskPath, state, record, pending, done };
    };
    const first = await completed("conclusion.current", "DECLARED_CONCLUSION_CURRENT");
    r.ok(["tick"]); await idle(front);
    t.assertions.assert((await copies("DECLARED_CONCLUSION_CURRENT")).length === 1,
      "an already observed reply hid the actual explicit task conclusion");
    t.assertions.assert(!existsSync(first.pending) && JSON.parse(readFileSync(first.done, "utf8")).done,
      "explicit conclusion was not durably archived with its delivered result");

    const old = await completed("conclusion.legacy", "DECLARED_CONCLUSION_LEGACY");
    // Actual old-format migration boundary, not a manufactured native status:
    // the old timer archived a real concluded task without a result payload.
    old.record.taskConclusion = old.state.finished;
    writeFileSync(old.pending, JSON.stringify(old.record));
    mkdirSync(path.dirname(old.done), { recursive: true }); renameSync(old.pending, old.done);
    writeFileSync(old.taskPath, JSON.stringify({ ...old.state, state: "delivered" }));
    await r.send(old.sid, JSON.stringify({ argv: ["/bin/echo", "UNRELATED_LATER_REPLY"], cwd: r.root }));
    await idle(old.sid);
    await r.client.call({ type: "session.interrupt", payload: { sessionId: old.sid } });
    await r.client.call({ type: "session.interrupt", payload: { sessionId: front } });
    r.ok(["tick"]);
    t.assertions.assert((await r.snapshot(front)).summary.inputSummary?.paused,
      "historical conclusion recovery lifted the requester's Human pause");
    const recovered = JSON.parse(readFileSync(old.done, "utf8"));
    t.assertions.assert(recovered.done?.text.includes("DECLARED_CONCLUSION_LEGACY")
      && !recovered.done.text.includes("UNRELATED_LATER_REPLY")
      && recovered.taskConclusion.atMs === old.state.finished.atMs
      && (await r.snapshot(old.sid)).summary.inputSummary?.paused,
      "legacy recovery lost its evidence or rewrote the original conclusion time");
    await r.send(front, "Collect the queued result without redoing the check"); await idle(front);
    r.ok(["tick"]); await idle(front);
    t.assertions.assert((await copies("DECLARED_CONCLUSION_LEGACY")).length === 1,
      "legacy result did not arrive once after explicit continuation");
    const facts = JSON.parse(r.ok(["quality", "facts"]));
    const delivered = facts.workItems.find((x: any) => x.sessionId === old.sid);
    t.assertions.assert(delivered.deliveryCoverageKnown && typeof delivered.deliveredAtMs === "number"
      && delivered.deliveredAtMs >= old.state.finished.atMs,
      "native collector lost the recovered conclusion's real delivery receipt");
    const originalReply = (await r.snapshot(old.sid)).summary.latestReply!.itemId;
    r.ok(["tick"]); await idle(front);
    t.assertions.assert((await copies("DECLARED_CONCLUSION_CURRENT")).length === 1
      && (await copies("DECLARED_CONCLUSION_LEGACY")).length === 1
      && (await r.snapshot(old.sid)).summary.latestReply!.itemId === originalReply,
      "repeated timer duplicated a result or resumed original business work");
    for (const flag of ["quiet", "superseded", "taskCanceled"] as const) {
      const guarded = { ...old.record, [flag]: true };
      writeFileSync(old.done, JSON.stringify(guarded));
      const before = readFileSync(old.done);
      r.ok(["tick"]);
      t.assertions.assert(!existsSync(old.pending) && readFileSync(old.done).equals(before),
        "archive recovery changed an explicitly guarded generation: " + flag);
    }
    t.note("Real native finish/result and explicit historical ledger fixture; one delivery, unchanged conclusion timestamp, Human pause and archived control guards preserved.");
  } finally { await r.dispose(); }
});

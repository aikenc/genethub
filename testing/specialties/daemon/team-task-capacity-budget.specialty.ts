import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-task-capacity-budget",
  title: "A long Task can receive an explicit original-front capacity decision without resetting spent work or user controls",
  oracle: "Real SDK Tasks hit their cumulative creation cap after a genuine completed support. Public budget inspection distinguishes the cap from expiry and global active capacity. Only the original front records an explicit idempotent/CAS capacity decision; the same Task then creates one real support. Original creation time, spent intents, user pause, global cap and terminal conclusion stay intact.",
  catches: ["long goal requires a new Task ID to bypass a spent budget", "finished support refunds lifetime spending", "budget automatically grows", "Owner changes original front budget", "replay renews or duplicates a decision", "stale decision overwrites current limits", "task capacity overrides global active ceiling", "capacity change resumes paused work"],
  tags: ["core", "team-task"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.get", "session.interrupt"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 30000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "task-capacity-budget", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_TASK_MAX_SESSIONS=2\nTEAM_TASK_MAX_AGE_SECONDS=3600\nTEAM_WAKE_ROUNDS=999999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let sequence = 0;
    const cli = async (sid: string, args: string[], expected = 0) => {
      const requestId = "capacity." + (++sequence);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId })); await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage" && x.text.includes(JSON.stringify(requestId))).at(-1);
      if (item?.type !== "assistantMessage") throw Error("actual command receipt missing");
      const reply = JSON.parse(item.text); t.assertions.assert(expected === 0 ? reply.code === 0 : reply.code !== 0, reply.err + reply.out);
      return expected === 0 ? JSON.parse(reply.out.trim().split("\n").at(-1)!) : reply;
    };
    const front = await r.create("ctl-cli-command");
    const task = await cli(front, ["task", "start", "--space", "leader", "--desc", "bounded continuing goal", "--request-id", "capacity.goal", "Continue this original goal within its existing user scope"]);
    const owner = task.owner.sessionId as string; await idle(owner);
    const ledger = () => JSON.parse(readFileSync(r.state("tasks", task.taskId + ".json"), "utf8"));
    const original = ledger();
    const first = await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "first bounded support", "--request-id", "capacity.first", "Complete one original support"]); await idle(first.collaborator);
    await cli(first.collaborator, ["task", "finish", task.taskId, "--outcome", "success", "Genuine first support completed"]);
    r.ok(["tick"]); await idle(owner);
    const pendingSupport = ["task", "support", task.taskId, "--space", "qa", "--desc", "continued support", "--request-id", "capacity.continued", "Continue original bounded goal"];
    await cli(owner, pendingSupport, 1);
    const initial = await cli(front, ["task", "budget", task.taskId]);
    t.assertions.assert(initial.revision === 0 && initial.usage.taskIntentCount === 2
      && initial.limits.taskMaximumSessions === 2 && initial.limits.teamMaximumActiveSessions === 64
      && initial.blockedReasons.includes("task-session-limit"), "spent support was refunded or original limits were not observable");
    const expired = Date.now() - 1;
    await cli(owner, ["task", "budget", task.taskId, "--max-sessions", "4", "--request-id", "not-front", "--expected-budget-revision", "0", "--reason", "Owner cannot replace front decision"], 1);
    const pausedBudget = await cli(front, ["task", "budget", task.taskId, "--expires-at-ms", String(expired), "--request-id", "stop-new-creates", "--expected-budget-revision", "0", "--reason", "Explicitly stop new creations while retaining original work"]);
    t.assertions.assert(pausedBudget.revision === 1 && pausedBudget.blockedReasons.includes("task-age-limit"), "explicit expiry was hidden or reset the original Task");
    await cli(owner, pendingSupport, 1);
    const expires = Date.now() + 120000;
    const decision = ["task", "budget", task.taskId, "--max-sessions", "4", "--expires-at-ms", String(expires), "--request-id", "continue-original", "--expected-budget-revision", "1", "--reason", "Original front explicitly allocates capacity within the unchanged user goal"];
    const renewed = await cli(front, decision);
    t.assertions.assert(renewed.revision === 2 && renewed.usage.taskIntentCount === 2 && renewed.limits.taskMaximumSessions === 4
      && renewed.taskCreatedAtMs === original.createdAtMs && renewed.decision.countsAsHumanApproval === false,
      "explicit capacity decision reset spending/age or claimed Human approval");
    const second = await cli(owner, pendingSupport); await idle(second.collaborator);
    const again = await cli(owner, pendingSupport); t.assertions.assert(again.collaborator === second.collaborator, "same support retry created another native Session");
    await r.client.call({ type: "session.interrupt", payload: { sessionId: second.collaborator } });
    const before = (await r.snapshot(second.collaborator)).summary.inputSummary;
    const replay = await cli(front, decision);
    t.assertions.assert(replay.replayed === true && replay.revision === 2 && replay.usage.taskIntentCount === 3, "replay renewed a decision or refunded used intents");
    await cli(front, decision.map(x => x === "4" ? "5" : x), 1);
    await cli(front, ["task", "budget", task.taskId, "--max-sessions", "5", "--request-id", "stale", "--expected-budget-revision", "1", "--reason", "Stale decision must reject"], 1);
    const after = (await r.snapshot(second.collaborator)).summary.inputSummary;
    t.assertions.assert(after?.paused === true && JSON.stringify(after.pendingMessageIds) === JSON.stringify(before?.pendingMessageIds)
      && ledger().createdAtMs === original.createdAtMs && ledger().owner.sessionId === owner
      && JSON.stringify(ledger().request) === JSON.stringify(original.request),
      "capacity decisions changed the original Task or resumed its paused support");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_MAX_ACTIVE_SESSIONS=1\n");
    const global = await cli(front, ["task", "budget", task.taskId]);
    t.assertions.assert(global.blockedReasons.includes("team-active-session-limit"), "per-Task allocation hid global active ceiling");
    await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "global cap", "--request-id", "capacity.global", "Must retain global active ceiling"], 1);
    await cli(owner, ["task", "finish", task.taskId, "--outcome", "blocked", "Honest conclusion retaining paused support"]);
    await cli(front, ["task", "budget", task.taskId, "--max-sessions", "5", "--request-id", "after-conclusion", "--expected-budget-revision", "2", "--reason", "Cannot reopen a concluded task"], 1);
    t.assertions.assert(ledger().finished.outcome === "blocked" && ledger().createdAtMs === original.createdAtMs,
      "capacity operation reopened or relabelled an honest conclusion");
    t.note("Real SDK/CLI tasks, completed work, native pause and new support; explicit case-owned capacity settings only. No User deadline, global ceiling, original creation time or historical native record is reset.");
  } finally { await r.dispose(); }
});

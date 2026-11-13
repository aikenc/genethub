import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-task-capacity-budget",
  title: "A long Task can receive an explicit original-front capacity decision without resetting spent work or user controls",
  oracle: "Real SDK Tasks retain cumulative/age/global limits and native pauses. Only an explicit original-front capacity decision permits more work. A supplementary message never resumes a concluded Task; explicit continuation preserves both prior conclusions and original identity, retains independently paused supports and really dispatches remaining work after a separate capacity decision. Capability status occurs once and cannot supply Human approval.",
  catches: ["long goal requires a new Task ID to bypass a spent budget", "finished support refunds lifetime spending", "budget automatically grows", "Owner changes original front budget", "replay renews or duplicates a decision", "stale decision overwrites current limits", "task capacity overrides global active ceiling", "capacity change resumes paused work"],
  tags: ["core", "team-task"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.get", "session.interrupt"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 45000, timeoutMs: 180000,
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
    const concluded = ledger().finished;
    const supplement = await cli(front, ["task", "send", task.taskId, "--request-id", "continued-requirement", "Human continues the same goal; retain the previous blocked result and standards"]);
    t.assertions.assert(ledger().finished.outcome === "blocked"
      && (await r.snapshot(second.collaborator)).summary.inputSummary?.paused,
      "accepting a supplementary message resumed the Task or its paused support");
    const notices = () => r.snapshot(front).then(s => s.items.filter(x => x.type === "userMessage"
      && x.text.startsWith("用途: status\n") && x.text.includes("task-continuation/1")));
    await r.client.call({ type: "session.interrupt", payload: { sessionId: front } });
    r.ok(["tick"]);
    t.assertions.assert((await r.snapshot(front)).summary.inputSummary?.paused === true,
      "capability status or the original blocked result resumed a Human-paused front");
    await cli(front, ["task", "status", task.taskId]);
    await t.tools.waitUntil(async () => {
      r.ok(["tick"]); await idle(front); return (await notices()).length === 1;
    }, 15000);
    const resume = ["task", "resume", task.taskId, "--request-id", "continue-preserving-history", "--expected-revision", "1", "Human explicitly continues remaining work under the unchanged goal and standard"];
    await r.client.call({ type: "session.interrupt", payload: { sessionId: owner } });
    await cli(front, resume); await idle(owner);
    const resumed = ledger();
    t.assertions.assert(!resumed.finished && resumed.revision === 2
      && JSON.stringify(resumed.conclusionHistory?.[0]?.conclusion) === JSON.stringify(concluded),
      "explicit continuation erased the genuine prior blocked conclusion instead of preserving its full history");
    t.assertions.assert(resumed.conclusionHistory[0].control.requestId === "continue-preserving-history"
      && resumed.createdAtMs === original.createdAtMs && resumed.owner.sessionId === owner
      && JSON.stringify(resumed.request) === JSON.stringify(original.request), "continuation reset the original Task or lost its source decision");
    await cli(front, resume);
    const deliveredNotices = await notices();
    t.assertions.assert(ledger().conclusionHistory.length === 1 && deliveredNotices.length === 1,
      "continuation history/notice mismatch: " + JSON.stringify({ history: ledger().conclusionHistory.length,
        delivered: deliveredNotices.length, localNoticeIds: Object.keys(ledger().settlementNotices || {}) }));
    t.assertions.assert((await r.snapshot(second.collaborator)).summary.inputSummary?.paused === true
      && JSON.stringify((await r.snapshot(second.collaborator)).summary.inputSummary?.pendingMessageIds) === JSON.stringify(before?.pendingMessageIds),
      "continuing a blocked Owner resumed or discarded an independently paused support");
    t.assertions.assert(supplement.accepted === true && supplement.recordedOutcome === "blocked"
      && supplement.conclusionPolicy?.messageAcceptanceResumesTask === false
      && supplement.capacityBudgetView?.blockedReasons.includes("task-concluded"),
      "message acceptance hid the continuing Task conclusion/dispatch gate");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_MAX_ACTIVE_SESSIONS=64\n");
    const capacityAfterResume = await cli(front, ["task", "budget", task.taskId]);
    t.assertions.assert(capacityAfterResume.usage.taskIntentCount === 3 && capacityAfterResume.revision === 2,
      "explicit resume refunded cumulative work or silently renewed capacity");
    await cli(front, ["task", "budget", task.taskId, "--max-sessions", "5", "--expires-at-ms", String(Date.now() + 120000), "--request-id", "continue-capacity", "--expected-budget-revision", "2", "--reason", "Original front allocates remaining work within the continued Human goal"]);
    const third = await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "real remaining verification", "--request-id", "after-explicit-resume", "Run the remaining real verification without changing old failures"]); await idle(third.collaborator);
    t.assertions.assert(third.collaborator !== second.collaborator && ledger().conclusionHistory.length === 1,
      "explicit continuation could not dispatch a genuinely new remaining support");
    const captured = r.command(["quality", "facts"]);
    t.assertions.assert(captured.code === 0, captured.err);
    const facts = JSON.parse(captured.out), unit = facts.acceptanceUnits.find((x: any) => x.taskId === task.taskId);
    const snapshot = join(r.root, "continued-native-facts.json"); writeFileSync(snapshot, JSON.stringify(facts));
    const card = JSON.parse(r.ok(["quality", "card", "--snapshot", snapshot]));
    const measured = card.taskParallelism.find((x: any) => x.unitId === unit.unitId);
    const gap = resumed.conclusionHistory[0].control.atMs - concluded.atMs;
    t.assertions.assert(unit.excluded.length === 0 && measured.totalEffectiveMs === unit.endedAtMs - unit.openedAtMs - gap,
      "continued Task counted its concluded waiting gap as effective unit age or reset the original clock: " + JSON.stringify({ measured: measured.totalEffectiveMs, opened: unit.openedAtMs, end: unit.endedAtMs, gap }));
    const older = { ...facts, r6Basis: "task-agent-hours/2" }; writeFileSync(snapshot, JSON.stringify(older));
    const olderCard = JSON.parse(r.ok(["quality", "card", "--snapshot", snapshot]));
    const originalTree = facts.taskTrees.find((x: any) => x.taskId === task.taskId);
    t.assertions.assert(olderCard.taskParallelism.find((x: any) => x.taskId === task.taskId).totalEffectiveMs === originalTree.endedAtMs - originalTree.openedAtMs,
      "the optional continuation fact silently changed old /2 replay semantics");
    const person = unit.sessions.find((x: any) => x.sessionId === owner);
    const nativeGapRun = person.runs.find((x: any) => x.startAtMs < resumed.conclusionHistory[0].control.atMs && x.endAtMs > concluded.atMs);
    t.assertions.assert(!!nativeGapRun, "actual supplementary Owner work during the concluded gap was not captured");
    const left = Math.max(nativeGapRun.startAtMs, concluded.atMs), right = Math.min(nativeGapRun.endAtMs, resumed.conclusionHistory[0].control.atMs);
    // Explicit partial replay of one genuine captured interval, not a native
    // complete cost claim or a mutation of the experimental Team.
    const partial = { ...facts, captureKind: "case-owned-native-interval-slice", acceptanceUnits: [{ ...unit,
      sessions: [{ ...person, runs: [{ startAtMs: left, endAtMs: right }], backgroundRuns: [], executionCoverageKnown: false }] }] };
    writeFileSync(snapshot, JSON.stringify(partial));
    const partialCost = JSON.parse(r.ok(["quality", "card", "--snapshot", snapshot])).unitTimeCost.units[0];
    t.assertions.assert(right > left && partialCost.observedMs === right - left && partialCost.completed === false,
      "excluding inactive goal wall erased actual Agent effort or promoted partial evidence to a complete cost");
    await cli(owner, ["task", "finish", task.taskId, "--outcome", "blocked", "Second honest conclusion, independent of the first"]);
    const secondConclusion = ledger().finished;
    r.ok(["tick"]); await idle(front);
    await cli(front, ["task", "resume", task.taskId, "--request-id", "second-continuation", "--expected-revision", "2", "Human explicitly continues the remaining verification again"]); await idle(owner);
    t.assertions.assert(ledger().conclusionHistory.length === 2
      && JSON.stringify(ledger().conclusionHistory[0].conclusion) === JSON.stringify(concluded)
      && JSON.stringify(ledger().conclusionHistory[1].conclusion) === JSON.stringify(secondConclusion),
      "later continuation overwrote or relabelled an earlier failed stage");
    r.ok(["tick"]); await idle(front);
    t.assertions.assert((await notices()).length === 1, "ordinary ticks replayed the continuation capability");
    t.note("Real SDK/CLI tasks, completed work, native pause and new support; explicit case-owned capacity settings only. No User deadline, global ceiling, original creation time or historical native record is reset.");
  } finally { await r.dispose(); }
});

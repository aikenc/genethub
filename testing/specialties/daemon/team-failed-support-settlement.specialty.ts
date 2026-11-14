import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, registerControlledAgent, writeScriptAgentControl } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-failed-support-settlement",
  title: "Execution failure status and a recovered support result retain their distinct native meanings",
  oracle: "A genuinely failed SDK support retains its paused input and reports one execution status per failed Round, never a task conclusion. Original-requester recovery after the external SDK fault is resolved delivers one real task result in the same Session without a duplicate R3; legacy failure wire notices remain distinguishable from quoted text and true duplicate results. Handled anomalies, original leases and non-success settlement retain their existing guarantees.",
  catches: ["unfinished Task suppresses native failure forever", "handled anomaly suppresses later failure in the same Session", "new native failure never wakes reflection", "same-Round retry repeats the urgent anomaly", "failure notification resumes failed work", "blocked conclusion waits forever for running support", "non-success settlement releases a paused writer", "late support result is discarded", "failure status contaminates final-result timing or duplicate scoring", "quoted failure text exempts a genuine result duplicate"],
  tags: ["core", "team-result"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "tools/run.py quality facts", "tools/run.py quality card", "session.get", "session.inspect", "session.close", "session.send", "agent.reload"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 35000, timeoutMs: 180000,
}, async t => {
  const failedAgent = registerControlledAgent(t.env, { id: "ctl-failed-support", profile: "coded-failure", failureCode: "upstream" });
  const r = await openTeam(t, "failed-support-settlement", [
    { id: "ctl-cli-command", profile: "cli-command" },
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
      if (expected !== 0) return v;
      try { return JSON.parse(v.out.trim().split("\n").at(-1)!); } catch { return v; }
    };
    const front = await r.create("ctl-cli-command");
    const task = await cli(front, ["task", "start", "--space", "leader", "--desc", "failure result check", "--request-id", "failure.goal", "Inspect a bounded support failure"]);
    const owner = task.owner.sessionId as string; await idle(owner);
    select("ctl-failed-support");
    const failedDirectory = join(r.root, "failed-writer"); mkdirSync(failedDirectory);
    const support = await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "native failed support", "--directory", failedDirectory, "--request-id", "failure.support", "Perform a bounded external check"]);
    const child = support.collaborator as string;
    const failedRound = async (except?: string) => {
      const reply = await r.client.call({ type: "session.rounds", payload: { sessionId: child, throughRoundId: null, cursor: null, limit: 100 } });
      if (reply?.type !== "sessionRounds") throw Error("native failed Round history missing");
      const found = reply.data.rounds.findLast(x => x.outcome === "failed" && x.roundId !== except);
      t.assertions.assert(Boolean(found), "actual external Agent did not produce a distinct failed Round");
      return found!.roundId;
    };
    const anomalies = (round: string) => ["notes", "notes-done"].flatMap(dir => existsSync(r.state(dir))
      ? readdirSync(r.state(dir)).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(r.state(dir, name), "utf8"))) : [])
      .filter(note => note.kind === "anomaly" && note.session === child && note.turn?.roundId === round);
    const reflection = async (noteId: string) => {
      const state = JSON.parse(readFileSync(r.state("reflect.json"), "utf8")); await idle(state.sessionId);
      const prompts = (await r.snapshot(state.sessionId)).items.filter(x => x.type === "userMessage");
      t.assertions.assert(prompts.some(x => {
        if (x.type !== "userMessage") return false;
        const path = x.text.match(/简报: ([^\n]+)/u)?.[1]?.trim();
        return path?.startsWith(r.root + "/") && readFileSync(path, "utf8").includes(noteId);
      }), "new anomaly did not reach an actual native reflection brief");
      return state.sessionId as string;
    };
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
    select("ctl-normal"); // A real reflecting Agent can finish without changing the failed worker.
    r.ok(["tick"]); await idle(owner);
    const first = record();
    t.assertions.assert(first.resultDelivery?.queued === true && first.done?.outcome === "failed",
      "native failed unfinished support never produced a truthful result receipt");
    const matches = async () => (await r.snapshot(owner)).items.filter(x => x.type === "userMessage" && x.id === first.resultDelivery.messageId);
    t.assertions.assert((await matches()).length === 1, "native failure result was not delivered exactly once");
    const firstMessage = (await matches())[0];
    t.assertions.assert(first.resultDelivery.purpose === "status" && firstMessage.type === "userMessage"
      && firstMessage.text.startsWith("用途: status\n"), "unfinished execution failure was published as a task result");
    r.ok(["tick"]); await idle(owner);
    const after = (await r.snapshot(child)).summary.inputSummary;
    t.assertions.assert((await matches()).length === 1 && after?.paused
      && JSON.stringify(after.pendingMessageIds) === JSON.stringify(before.pendingMessageIds),
      "reconciliation resumed failed work, dropped input or replayed its result");
    const nativeTask = JSON.parse(readFileSync(r.state("tasks", task.taskId+".json"), "utf8"));
    t.assertions.assert(!nativeTask.finished && !nativeTask.collaborators[0].finished, "execution failure fabricated a business conclusion");
    t.assertions.assert(existsSync(first.lock) && existsSync(r.state("pending", child+".json")),
      "a paused failed writer was released or archived before explicit recovery");
    const firstRound = await failedRound(), firstNotes = anomalies(firstRound);
    t.assertions.assert(firstNotes.length === 1, "first native failure did not create exactly one anomaly");
    const firstNote = firstNotes[0], firstReflection = await reflection(firstNote.id);
    await cli(owner, ["notes", "done", firstNote.id]);
    const handledNote = r.state("notes-done", firstNote.id+".json"), handledBytes = readFileSync(handledNote);
    const resumeId = "failure.support.resume", resumeGoal = "Retry the original unfinished external check";
    const resumeArgs = ["send", "--to", child, "--kind", "human", "--resume", "--message-id", resumeId, resumeGoal];
    const outsider = await r.create("ctl-cli-command");
    await cli(outsider, resumeArgs, 1);
    t.assertions.assert((await r.snapshot(child)).summary.inputSummary?.paused && existsSync(first.lock),
      "a different requester changed the failed writer before the original Owner decided");
    await cli(owner, resumeArgs);
    await cli(owner, resumeArgs);
    await cli(owner, [...resumeArgs.slice(0, -1), "CONFLICTING RETRY"], 1);
    await t.tools.waitUntil(async () => {
      const snap = await r.snapshot(child);
      return snap.summary.status === "failed" && snap.items.some(x => x.type === "userMessage" && x.id === resumeId);
    }, 20000);
    const resumed = await r.snapshot(child);
    const continuation = resumed.items.filter(x => x.type === "userMessage" && x.id === resumeId);
    t.assertions.assert(continuation.length === 1 && continuation[0].type === "userMessage"
      && continuation[0].origin?.sessionId === owner && continuation[0].text.includes(resumeGoal),
      "failure recovery changed the Session, lost requester attribution or replayed its input");
    const receipts = (await import("node:fs")).readdirSync(r.state("resumes")).filter(n => n.endsWith(".json"))
      .map(n => JSON.parse(readFileSync(r.state("resumes", n), "utf8")));
    const receipt = receipts.find(x => x.id === resumeId);
    t.assertions.assert(receipt?.state === "accepted"
      && JSON.stringify(receipt.previousPending.done) === JSON.stringify(first.done)
      && receipt.previousPending.resultDelivery.messageId === first.resultDelivery.messageId
      && receipt.previousPending.executionFailure.roundId
      && existsSync(first.lock), "recovery discarded the immutable failure, result receipt or writer obligation");
    r.ok(["tick"]); await idle(owner);
    const second = record();
    t.assertions.assert(second.done?.outcome === "failed" && second.resultDelivery?.queued
      && second.done.reply !== first.done.reply && second.resultDelivery.messageId !== first.resultDelivery.messageId,
      "the new failed round reused the previous failure generation or lost its notification");
    const secondRound = await failedRound(firstRound), secondNotes = anomalies(secondRound);
    t.assertions.assert(secondNotes.length === 1 && secondNotes[0].id !== firstNote.id,
      "a handled anomaly suppressed the next genuine failed Round in the same Session");
    const secondReflection = await reflection(secondNotes[0].id);
    t.assertions.assert(secondReflection !== firstReflection && readFileSync(handledNote).equals(handledBytes),
      "new failure reused an old reflection or rewrote its handled anomaly");
    const originalResult = first.resultDelivery.messageId, newResult = second.resultDelivery.messageId;
    r.ok(["tick"]); await idle(owner);
    t.assertions.assert(anomalies(secondRound).length === 1
      && JSON.parse(readFileSync(r.state("reflect.json"), "utf8")).sessionId === secondReflection
      && readFileSync(handledNote).equals(handledBytes), "same-Round tick replay duplicated reflection or changed old evidence");
    const inputs = (await r.snapshot(owner)).items;
    t.assertions.assert(inputs.filter(x => x.type === "userMessage" && x.id === originalResult).length === 1
      && inputs.filter(x => x.type === "userMessage" && x.id === newResult).length === 1
      && existsSync(first.lock) && (await r.snapshot(child)).summary.inputSummary?.paused,
      "new failure duplicated an earlier result, cleared its pause or released unfinished work");
    const secondMessage = inputs.find(x => x.type === "userMessage" && x.id === newResult);
    t.assertions.assert(second.resultDelivery.purpose === "status" && secondMessage?.type === "userMessage"
      && secondMessage.text.startsWith("用途: status\n"), "later failed Round was mistaken for a task result");
    // Resolve the real external SDK fault, not the product. The original
    // requester still has to recover the paused Session through the public CLI.
    writeScriptAgentControl(failedAgent, { profile: "cli-command" });
    await r.client.call({ type: "session.close", payload: { sessionId: child } });
    // The fixture SDK loads control at serve startup; reload the external
    // service through the public API before the requester resumes its Session.
    await r.client.call({ type: "agent.reload", payload: { agentId: failedAgent.agentId } });
    await cli(owner, ["send", "--to", child, "--kind", "human", "--resume", "--message-id", "failure.recovered", "Continue the original unfinished support after its external service recovered"]);
    await idle(child);
    await cli(child, ["task", "finish", task.taskId, "--outcome", "success", "Recovered support candidate; business acceptance remains with requester"]);
    r.ok(["tick"]); await idle(owner);
    const completed = record();
    const finalInput = (await r.snapshot(owner)).items.find(x => x.type === "userMessage" && x.id === completed.resultDelivery.messageId);
    t.assertions.assert(finalInput?.type === "userMessage" && finalInput.text.startsWith("用途: result\n")
      && completed.resultDelivery.messageId !== originalResult && completed.resultDelivery.messageId !== newResult,
      "same-Session recovered support did not deliver its actual final result");
    const file = join(t.env.root, "external-failure-notification-facts.json");
    const card = (facts: any) => { writeFileSync(file, JSON.stringify(facts)); return JSON.parse(r.ok(["quality", "card", "--snapshot", file])); };
    const facts = JSON.parse(r.ok(["quality", "facts"]));
    const item = facts.workItems.find((x: any) => x.id === first.operationId);
    t.assertions.assert(facts.resultAudienceBasis === "source-result-generation/2"
      && item.deliveryEvents.length === 1 && item.deliveryEvents[0].messageId === completed.resultDelivery.messageId
      && item.deliveredAtMs >= item.conclusionAtMs && card(facts).redLines.R3.triggered === false,
      "execution statuses contaminated the actual final-result timing or duplicate scoring");
    const failureNotice = "执行回合已失败，业务任务尚未结论；原输入、未完成支持及资源义务保留。";
    // Public compatibility wire input, explicitly representing an older
    // producer's status-in-result envelope; no daemon internals are patched.
    const legacyHeader = `用途: result\n发送方: ${child}\nref: ghref:session:${child}\n\n`;
    await r.send(owner, legacyHeader + "[并行决策信息] Legacy wire compatibility fixture\n" + failureNotice + "\n原生错误：historical SDK failure fixture"); await idle(owner);
    const migrated = JSON.parse(r.ok(["quality", "facts"]));
    const migratedItem = migrated.workItems.find((x: any) => x.id === first.operationId);
    t.assertions.assert(migratedItem.deliveryEvents.length === 1 && card(migrated).redLines.R3.triggered === false
      && migrated.executionStatusNotifications.filter((x: any) => x.sourceSessionId === child).length >= 3,
      "legacy execution status became another task result or disappeared from evidence");
    const legacy = structuredClone(migrated); legacy.fixture = "labelled legacy scoring projection of actual native notifications";
    legacy.resultAudienceBasis = "source-result-generation/1";
    const oldItem = legacy.workItems.find((x: any) => x.id === first.operationId);
    for (const notice of migrated.executionStatusNotifications.filter((x: any) => x.sourceSessionId === child)) {
      oldItem.deliveryEvents.push({ recipient: owner, messageId: notice.messageId, acceptedAtMs: notice.receivedAtMs, ref: notice.ref });
    }
    const old = card(legacy);
    t.assertions.assert(old.redLines.R3.triggered === true && JSON.stringify(card(legacy)) === JSON.stringify(old)
      && old.streakCompatibilityKey !== card(migrated).streakCompatibilityKey, "old failure/result projection was silently reinterpreted or mixed into a new streak");
    const finalHeader = `用途: result\n发送方: ${child}\nref: ${completed.done.ref}\n\n`;
    await r.send(owner, finalHeader + "Quoted example, not an execution status:\n```\n" + failureNotice + "\n```"); await idle(owner);
    const duplicated = JSON.parse(r.ok(["quality", "facts"]));
    t.assertions.assert(card(duplicated).redLines.R3.instances.some((x: any) => x.reason === "duplicate-result"),
      "ordinary result quoting the failure marker evaded genuine duplicate-result detection");
    await cli(owner, ["task", "finish", task.taskId, "--outcome", "blocked", "Recovered support delivered; overall business goal not accepted"]);

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
      const ownerPending = r.state("pending", coordinator+".json");
      const ownerRecord = JSON.parse(readFileSync(existsSync(ownerPending) ? ownerPending : r.state("done", coordinator+".json"), "utf8"));
      const resultId = ownerRecord.resultDelivery?.messageId;
      const frontResults = (await r.snapshot(front)).items.filter(x => x.type === "userMessage" && x.id === resultId);
      t.assertions.assert(ownerRecord.done?.outcome === outcome && ownerRecord.resultDelivery?.queued === true
        && frontResults.length === 1 && frontResults[0].type === "userMessage"
        && frontResults[0].text.includes("Unfinished support retained; no success claimed"),
        "recorded non-success owner conclusion was withheld from its actual requester by unfinished support");
      r.ok(["tick"]); await idle(front);
      t.assertions.assert((await r.snapshot(front)).items.filter(x => x.type === "userMessage" && x.id === resultId).length === 1,
        "retained support replayed its owner's recorded conclusion");
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

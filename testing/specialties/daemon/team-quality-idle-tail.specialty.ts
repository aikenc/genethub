import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-idle-tail",
  title: "Minute observations end at a genuine conclusion or a proven read-in failure replacement",
  oracle: "A real SDK Task concludes through the public Agent CLI. A labelled isolated historical dispatch and minute-observation fixture ends 66.2 seconds before its genuine conclusion. Diagnostic facts must judge this continuous interval; removing an interior sample or extending the unsampled tail beyond 125 seconds must remain unknown. Native timestamps, pause and retained inputs are never rewritten.",
  catches: ["a normal minute timer boundary makes R2 unjudgeable", "an actual sampling hole becomes healthy", "a stale tail manufactures negative idle evidence", "new observation semantics reuse an old card streak"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py quality facts", "tools/run.py quality card", "session.get"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 15000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "idle-tail", [{ id: "ctl-cli-command", profile: "cli-command" },
    { id: "ctl-idle-failure", profile: "coded-failure", failureCode: "upstream" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let sequence = 0;
    const cli = async (sid: string, args: string[]) => {
      const requestId = "idle-tail." + (++sequence);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId })); await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage" && x.text.includes(JSON.stringify(requestId))).at(-1);
      if (item?.type !== "assistantMessage") throw Error("actual command receipt missing");
      const reply = JSON.parse(item.text); t.assertions.assert(reply.code === 0, reply.err + reply.out);
      return JSON.parse(reply.out.trim().split("\n").at(-1)!);
    };
    const front = await r.create("ctl-cli-command");
    const task = await cli(front, ["task", "start", "--space", "leader", "--desc", "bounded observation", "--request-id", "idle-tail.goal", "Conclude a real bounded task"]);
    const owner = task.owner.sessionId as string; await idle(owner);
    await cli(owner, ["task", "finish", task.taskId, "--outcome", "blocked", "Genuine bounded conclusion for observation fixture"]);
    const taskPath = r.state("tasks", task.taskId + ".json"), taskBytes = readFileSync(taskPath);
    const ledger = JSON.parse(taskBytes.toString()), stop = ledger.finished.atMs;
    const intentFile = readdirSync(r.state("task-dispatch")).find(file => file.endsWith(".json")
      && JSON.parse(readFileSync(r.state("task-dispatch", file), "utf8")).sessionId === owner);
    if (!intentFile) throw Error("genuine Owner dispatch missing");
    const intentPath = r.state("task-dispatch", intentFile);
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    const begin = stop - 3666200;
    // Labelled external time-domain input only. The actual native Session,
    // activation, execution, conclusion time and inbox remain untouched.
    ledger.createdAtMs = begin; intent.createdAtMs = begin;
    writeFileSync(taskPath, JSON.stringify(ledger)); writeFileSync(intentPath, JSON.stringify(intent));
    const eventFile = r.state("events", "events.jsonl"), savedEvents = readFileSync(eventFile, "utf8");
    const original = savedEvents.trim().split("\n").map(x => JSON.parse(x)).filter(x => x.kind !== "session-observed");
    const samples = Array.from({ length: 61 }, (_, i) => ({ schema: "team-process-event/1", eventId: "fixture.idle-tail." + i,
      kind: "session-observed", sessionId: owner, atMs: begin + i * 60000, recordedAtMs: Date.now(),
      status: "idle", paused: false, waitingForUser: false, fixture: "labelled historical observation boundary; not native timer evidence" }));
    const capture = (rows: typeof samples) => {
      writeFileSync(eventFile, [...original, ...rows].map(x => JSON.stringify(x)).join("\n") + "\n");
      return JSON.parse(r.ok(["quality", "facts"]));
    };
    const known = capture(samples);
    t.assertions.assert(known.captureKind === "diagnostic" && known.issues.length === 0 && known.coverage.idleObligations === true,
      "continuous minute observations ending 66.2 seconds before genuine conclusion became unknown");
    t.assertions.assert(known.idleObservationBasis === "native-minute-freshness/2", "changed observation interpretation has no explicit basis");
    const card = JSON.parse(r.ok(["quality", "card", "--snapshot", (() => { const p = join(t.env.root, "known-facts.json"); writeFileSync(p, JSON.stringify(known)); return p; })()]));
    t.assertions.assert(card.measurementVersion?.includes("native-minute-freshness/2"), "new measurement basis could reuse an older streak");
    t.assertions.assert(capture(samples.filter((_, i) => i < 25 || i > 26)).coverage.idleObligations === false,
      "a genuine three-minute interior observation hole became healthy");
    t.assertions.assert(capture(samples.slice(0, -1)).coverage.idleObligations === false,
      "a tail older than the existing 125-second freshness bound became healthy");
    t.assertions.assert(JSON.parse(readFileSync(taskPath, "utf8")).finished.atMs === stop,
      "measurement fixture changed the genuine conclusion timestamp");
    writeFileSync(eventFile, savedEvents);
    const select = (id: string) => writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=" + id + "\n");
    const parent = await cli(front, ["task", "start", "--space", "leader", "--desc", "native replacement", "--request-id", "idle.replacement", "Recover one failed external check"]);
    const requester = parent.owner.sessionId as string; await idle(requester);
    select("ctl-idle-failure");
    const failed = await cli(requester, ["task", "support", parent.taskId, "--space", "qa", "--desc", "original failed check", "--request-id", "idle.failed", "Attempt the external check"]);
    const failedId = failed.collaborator as string;
    await t.tools.waitUntil(async () => (await r.snapshot(failedId)).summary.status === "failed", 20000);
    await r.client.call({ type: "session.close", payload: { sessionId: failedId } });
    const failedInput = (await r.snapshot(failedId)).summary.inputSummary;
    r.ok(["tick"]); await idle(requester);
    const dispatch = () => readdirSync(r.state("task-dispatch")).map(file => JSON.parse(readFileSync(r.state("task-dispatch", file), "utf8")));
    const failedOperation = dispatch().find(x => x.sessionId === failedId);
    if (!failedOperation) throw Error("native failed operation missing");
    const originalBytes = readFileSync(r.state("task-dispatch", failedOperation.operationId + ".json"));
    const factsBefore = JSON.parse(r.ok(["quality", "facts"]));
    t.assertions.assert(!factsBefore.workItems.find((x: any) => x.id === failedOperation.operationId)?.idleObligationEnd,
      "failure alone ended an unfinished obligation");
    select("ctl-cli-command");
    const replacement = await cli(requester, ["task", "support", parent.taskId, "--space", "qa", "--desc", "replacement check", "--request-id", "idle.successor", "--follows", failedOperation.operationId, "Complete an independent replacement check"]);
    const successorId = replacement.collaborator as string; await idle(successorId);
    const unread = JSON.parse(r.ok(["quality", "facts"]));
    t.assertions.assert(!unread.workItems.find((x: any) => x.id === failedOperation.operationId)?.idleObligationEnd,
      "a dispatched successor without a read-in conclusion cleared the old obligation");
    await cli(successorId, ["task", "finish", parent.taskId, "--outcome", "success", "Independent replacement check completed"]);
    r.ok(["tick"]); await idle(requester);
    const recovered = JSON.parse(r.ok(["quality", "facts"]));
    const old = recovered.workItems.find((x: any) => x.id === failedOperation.operationId);
    const next = recovered.workItems.find((x: any) => x.sessionId === successorId);
    const nativeFailed = recovered.turns.filter((x: any) => x.sessionId === failedId && x.outcome === "failed");
    t.assertions.assert(old?.idleObligationEnd?.basis === "native-read-in-successor/1"
      && old.idleObligationEnd.successorOperationId === next?.id
      && old.idleObligationEnd.atMs >= next.consumedAtMs && next.outcome === "success",
      "genuine native read-in replacement did not end the old R2 observation obligation");
    t.assertions.assert(old.conclusionAtMs === null && nativeFailed.length > 0
      && readFileSync(r.state("task-dispatch", failedOperation.operationId + ".json")).equals(originalBytes)
      && JSON.stringify((await r.snapshot(failedId)).summary.inputSummary) === JSON.stringify(failedInput),
      "measurement changed the genuine failure, input, business conclusion or original dispatch");
    await r.send(failedId, "A genuine later execution fails after the old replacement was accepted");
    await t.tools.waitUntil(async () => {
      const summary = (await r.snapshot(failedId)).summary;
      return summary.status === "failed" && JSON.stringify(summary.inputSummary) !== JSON.stringify(failedInput);
    }, 20000);
    const newerFailure = JSON.parse(r.ok(["quality", "facts"]));
    t.assertions.assert(!newerFailure.workItems.find((x: any) => x.id === failedOperation.operationId)?.idleObligationEnd,
      "a previously accepted replacement cleared a newer native execution failure");
    t.note("Only isolated historical dispatch/observation input is frozen; public real Task and native Session evidence are preserved. No live Team, official card, clock or deadline mutation.");
  } finally { await r.dispose(); }
});

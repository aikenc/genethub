import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

const python = process.env.GENEHUB_PYTHON!;
const requirements = [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }];

defineSpecialty({
  id: "specialty.daemon.team-quality-live-replay",
  title: "Read-only frozen quality replay warns before red, preserves unknown and escalates consecutive hours",
  oracle: "Independent timestamp fixtures cross the three-minute warning and ten-minute delivery boundary, then the fifteen-minute triage deadline. Two same-basis consecutive R6 hours escalate; different bases do not stitch. No external replay becomes an official capture or writes live Team state.",
  catches: ["hourly-only redline detection", "triage deadline missing", "unknown clears an observed incident", "cross-basis consecutive escalation", "replay mutates native quality history"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py quality alerts --snapshot", "spacebuilder.py build"],
  surfaces: ["team-template", "filesystem"], requiredArtifacts: [], requirements,
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0 },
  expectedDurationMs: 7000, timeoutMs: 90000,
}, async t => {
  const refs = join(t.openRoot, "apps/daemon/builtin-skills/genehub/references");
  const source = join(t.env.root, "definition"), output = join(t.env.root, "compiled");
  cpSync(join(refs, "team-template"), source, { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: join(t.env.root, "home") }; mkdirSync(env.HOME, { recursive: true });
  const built = spawnSync(python, [join(refs, "spacebuilder/spacebuilder.py"), "build", source, "--output", output, "--require-no-post-commands"], { env, encoding: "utf8", timeout: 30000 });
  t.assertions.assert(built.status === 0, built.stdout+built.stderr);
  const h = 3600000, base = Date.UTC(2026, 10, 11), ready = base+4*h+5*60000;
  const facts = (end: number): any => ({ schema: "team-quality-facts/1", scoringModel: "tq/2", team: "independent-live-work",
    window: { startAtMs: end-h, endAtMs: end }, measurementWindow: { startAtMs: end-h, endAtMs: end }, capturedAtMs: end,
    versions: {}, coverage: { dispatches: true, starts: true, deliveries: true, observations: true, goals: true, resources: true, turns: true, inputs: true },
    workItems: [], taskTrees: [], taskTreesSourceComplete: true, turns: [], wakes: [], inputs: [], failures: [], stalls: [], goalIntervals: [],
  });
  const delivery = (end: number) => ({ ...facts(end), workItems: [{ id: "work.delivery", hasReceipt: true, requester: "parent", dispatchAtMs: ready-60000,
    confirmedAtMs: ready-60000, startedAtMs: ready-59000, conclusionAtMs: ready, deliveryCoverageKnown: true, resourceRequired: false }] });
  const file = join(t.env.root, "frozen-replay.json");
  const replay = (samples: any[]) => {
    writeFileSync(file, JSON.stringify({ schema: "team-quality-alert-samples/1", samples }));
    const r = spawnSync(python, [join(output, "tools/run.py"), "quality", "alerts", "--snapshot", file], { env, cwd: output, encoding: "utf8", timeout: 15000 });
    t.assertions.assert(r.status === 0, r.stdout+r.stderr); return JSON.parse(r.stdout);
  };
  const warning = delivery(ready+3*60000), red = delivery(ready+10*60000+1), late = delivery(ready+25*60000+1);
  const projected = replay([warning, red, late]);
  t.assertions.assert(projected.officialCapture === false && projected.steps[0].new.length === 0
    && projected.steps[0].warnings.some((x: any) => x.rule === "R3") && projected.steps[1].new.length === 1
    && projected.steps[2].escalated.length === 1, "R3 warning/red/triage boundaries did not produce one episode and escalation");
  const id = projected.steps[1].new[0];
  t.assertions.assert(projected.state.incidents[id].platformEscalation === "triage-timeout", "fifteen-minute untriaged incident was not escalated");
  const unknown = facts(ready+26*60000); unknown.coverage.deliveries = false;
  const kept = replay([red, unknown]);
  t.assertions.assert(kept.state.incidents[id].status === "open" && kept.steps[1].unknown.some((x: any) => x.rule === "R3"), "unknown evidence cleared an observed redline");
  const parallel = (end: number) => {
    const f = facts(end); f.captureKind = "native-hour";
    f.taskTrees = [{ taskId: "task.long", openedAtMs: base+19*h, endedAtMs: end, excluded: [],
      sessions: [{ sessionId: "worker.one", readable: true, runs: [{ startAtMs: base+19*h, endAtMs: end }] }] }];
    return f;
  };
  const first = parallel(base+20*h), second = parallel(base+21*h), repeated = replay([first, second]);
  t.assertions.assert(repeated.steps[1].new.length === 0 && repeated.steps[1].escalated.length === 1
    && Object.values(repeated.state.incidents).some((x: any) => x.rule === "R6" && x.platformEscalation === "consecutive-hours"), "same-basis consecutive R6 hours did not escalate one instance");
  second.resourceObligationBasis = "dispatch-resource-obligation/2";
  const different = replay([first, second]);
  t.assertions.assert(!Object.values(different.state.incidents).some((x: any) => x.platformEscalation === "consecutive-hours"), "different measurement versions stitched consecutive hours");
  const clear = facts(ready+2*h), auto = replay([red,unknown,clear]);
  t.assertions.assert(auto.state.incidents[id].status === "closed" && auto.state.incidents[id].resolution.basis === "native-hourly-facts/2"
    && auto.state.incidents[id].resolution.nativeFactsSha256 && !auto.state.measurementEpochs?.length,
    "a complete clean native observation did not close and retain evidence automatically, or opened a measurement epoch");
  const recurred = replay([red,clear,delivery(ready+3*h)]);
  t.assertions.assert(recurred.steps[2].new.length===1 && recurred.steps[2].new[0]!==id
    && Object.values(recurred.state.incidents).some((x:any)=>x.status==="open"),
    "a genuinely recurring native breach was suppressed by its archived instance");
  const quiet = replay([facts(base+22*h)]);
  t.assertions.assert(!Object.keys(quiet.state.incidents).length && !existsSync(join(output, ".genethub/team/quality/live-alerts.json")), "quiet external replay created an incident or wrote native Team state");
  t.note("Frozen external timestamp algebra, not historical live Team execution or official score; no internal product import/mocking.");
});

defineSpecialty({
  id: "specialty.daemon.team-quality-live-native-wake",
  title: "An actual Team tick produces one urgent redline and native reflection, with immediate platform triage feedback",
  oracle: "A restored unconfirmed source intent references a real Agent-owned task and no invented execution. Actual tick detects its elapsed acknowledgement obligation, persists one urgent note and wakes native reflection; public native triage immediately registers one platform feedback. Repeated ticks preserve identities and no-redline ticks add no redline wake.",
  catches: ["redline remains a passive hourly card", "urgent redline obeys ordinary wake delay", "duplicate redline notes or platform feedback", "platform triage is never reported", "diagnostic failure erases the previous alert"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "tools/run.py quality alerts", "tools/run.py quality triage", "session.get"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], requirements,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "live-native-wake", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WAKE_GAP=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => { const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length; }, 30000);
    let seq = 0;
    const cli = async (sid: string, args: string[]) => {
      const requestId = "live."+(++seq); await r.send(sid, JSON.stringify({ argv: [python, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId })); await idle(sid);
      const msg = (await r.snapshot(sid)).items.filter(x => { if (x.type !== "assistantMessage") return false; try { return JSON.parse(x.text).requestId === requestId; } catch { return false; } }).at(-1);
      if (msg?.type !== "assistantMessage") throw new Error("actual task command receipt missing");
      const v = JSON.parse(msg.text); t.assertions.assert(v.code === 0, v.out+v.err); return JSON.parse(v.out.trim().split("\n").at(-1)!);
    };
    r.ok(["tick"]);
    const redNotes = () => ["notes", "notes-done"].flatMap(area => existsSync(r.state(area)) ? readdirSync(r.state(area)).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(r.state(area, f), "utf8"))) : []).filter(x => x.kind === "redline");
    t.assertions.assert(redNotes().length === 0, "quiet native tick generated a redline note");
    const front = await r.create("ctl-cli-command");
    const task = await cli(front, ["task", "start", "--space", "leader", "--desc", "bounded receipt observation", "--request-id", "live.goal", "Observe an unresolved preparation"]);
    const owner = task.owner.sessionId as string; await idle(owner);
    // Documented restored source-intent boundary, as after lost/unknown prepare.
    // Its original task and requester are real. No Session, result, successful
    // prepare, resource or native time is fabricated or manually completed.
    const operation = "taskop.restored.unconfirmed";
    writeFileSync(r.state("task-dispatch", operation+".json"), JSON.stringify({ version: 1, operationId: operation, state: "creating", createdAtMs: Date.now()-11*60000,
      request: { taskId: task.taskId, requester: owner, role: "qa", desc: "restored unknown acknowledgement", machine: null } }));
    r.ok(["tick"]);
    const alerts = JSON.parse(r.ok(["quality", "alerts"]));
    const incident = alerts.redLines.find((x: any) => x.rule === "R1" && x.workItemId === operation);
    t.assertions.assert(incident && redNotes().filter(x => x.id === incident.noteId).length === 1 && existsSync(join(r.root, incident.evidence.path)), "one actual tick did not persist one urgent redline with evidence");
    const reflect = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
    t.assertions.assert(reflect.sessionId && reflect.notifiedNotes.includes(incident.noteId), "urgent redline did not reach native reflection in its detecting tick");
    await t.tools.waitUntil(async () => !!(await r.snapshot(reflect.sessionId)).summary.latestReply, 20000);
    const taskView = await cli(owner, ["task", "status", task.taskId]);
    t.assertions.assert(taskView.liveQuality.redLines.some((x: any) => x.id === incident.id), "Owner public brief omitted its current redline");
    await cli(owner, ["quality", "triage", incident.id, "--attribution", "platform-template", "--evidence", incident.evidence.path]);
    const feedback = JSON.parse(r.ok(["feedback", "ls", "--open"]));
    t.assertions.assert(JSON.stringify(feedback).includes("quality-redline:"+incident.id), "platform triage did not immediately create platform feedback");
    r.ok(["tick"]); r.ok(["tick"]);
    const final = JSON.parse(r.ok(["quality", "alerts"]));
    t.assertions.assert(final.redLines.find((x: any) => x.id === incident.id)?.feedbackId
      && redNotes().filter(x => x.id === incident.noteId).length === 1 && redNotes().length === 1,
      "repeated ticks or platform escalation duplicated the urgent redline");
    // External append-tail crash fault in the diagnostic event file. Scheduling
    // does not read that log; capture failure must not erase the open episode.
    appendFileSync(r.state("events", "events.jsonl"), "{truncated diagnostic append\n");
    r.ok(["tick"]);
    const unavailable = JSON.parse(r.ok(["quality", "alerts"]));
    t.assertions.assert(unavailable.redLines.some((x: any) => x.id === incident.id)
      && unavailable.unknown.some((x: any) => x.rule === "live-capture"), "failed diagnostic read erased a known open redline or claimed health");
    t.note("Actual native task/timer/reflection and platform feedback, with one explicit restored source-intent fixture; no observation reminder, no live Team writes or official quality80 claim.");
  } finally { await r.dispose(); }
});

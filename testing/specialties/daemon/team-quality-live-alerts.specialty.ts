import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

const python = process.env.GENEHUB_PYTHON!;
const requirements = [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }];

defineSpecialty({
  id: "specialty.daemon.team-quality-live-replay",
  title: "Read-only quality replay routes automatic attribution without triage timers or repeat-hour escalation",
  oracle: "Independent timestamp fixtures cross warning/red boundaries and route automatic responsibility. A fresh verified resource return closes only its matching occurrence despite unrelated unknown resources, retaining the historical breach and global unknown coverage. Missing, upper-bound, future, mismatched or currently-held evidence cannot close it. No external replay becomes an official capture or writes live Team state.",
  catches: ["hourly-only redline detection", "manual triage gate returns", "unknown clears an observed incident", "unrelated unknown evidence keeps a verified return open", "historical release alone closes current unresolved debt", "repeat-hour responsibility changes without evidence", "replay mutates native quality history"],
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
    versions: {}, attributionContext: { schema: "team-quality-attribution-context/1", dispatch: "builtin-task/1", resultQueue: "template-native-inbox/1", resourceReturn: "template-reconciler/1" }, coverage: { dispatches: true, starts: true, deliveries: true, observations: true, goals: true, resources: true, turns: true, inputs: true },
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
    && projected.steps[2].escalated.length === 0, "R3 warning/red boundaries changed or introduced mandatory triage escalation");
  const id = projected.steps[1].new[0];
  t.assertions.assert(projected.state.incidents[id].notification.target === "platform-development"
    && !projected.state.incidents[id].triageDueAtMs && !projected.state.incidents[id].platformEscalation,
    "automatic platform responsibility was not routed directly, or requires timed triage");
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
  t.assertions.assert(repeated.steps[1].new.length === 0 && repeated.steps[1].escalated.length === 0
    && Object.values(repeated.state.incidents).some((x: any) => x.rule === "R6" && x.notification.target === "team" && !x.platformEscalation), "repeated genuine R6 did not remain one Team responsibility instance");
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
  const resources = (end: number, released?: number, basis?: string, held: boolean | null = true): any => {
    const f = delivery(end), item = f.workItems[0];
    Object.assign(item, { id: "resource.returned", deliveredAtMs: ready+60000,
      resourceRequired: true, resourceHeld: held, releasedAtMs: released, releaseTimeBasis: basis });
    f.workItems.push({ ...item, id: "resource.other", resourceHeld: end === ready+11*60000 ? true : null,
      releasedAtMs: undefined, releaseTimeBasis: undefined });
    return f;
  };
  const owed = resources(ready+11*60000), returned = resources(ready+30*60000, ready+20*60000, "verified-release", null);
  const outstanding = replay([owed]);
  const resourceId = (work: string) => Object.values(outstanding.state.incidents).find((x: any) => x.rule === "R5" && x.workItemId === work) as any;
  const returnedId = resourceId("resource.returned").id, otherId = resourceId("resource.other").id;
  const partial = replay([owed, returned]);
  t.assertions.assert(partial.state.incidents[returnedId].status === "closed"
    && partial.state.incidents[returnedId].closedAtMs === ready+20*60000
    && partial.state.incidents[returnedId].resolution.nativeFactsSha256
    && partial.state.incidents[returnedId].resolution.ruleCoverageKnown === false
    && partial.state.incidents[otherId].status === "open",
    "verified return stayed open behind unrelated unknown evidence, or cleared unrelated debt/global coverage");
  writeFileSync(file, JSON.stringify(returned));
  const historical = spawnSync(python, [join(output, "tools/run.py"), "quality", "alerts", "--snapshot", file], { env, cwd: output, encoding: "utf8", timeout: 15000 });
  t.assertions.assert(historical.status === 0, historical.stdout+historical.stderr);
  const physical = JSON.parse(historical.stdout);
  t.assertions.assert(physical.ruleCoverage.R5 === false && physical.redLines.some((x: any) => x.rule === "R5" && x.workItemId === "resource.returned"),
    "closing current debt erased the observed historical R5 breach or promoted unknown coverage");
  const noItem = resources(ready+31*60000); noItem.workItems.shift();
  const wrongOperation = structuredClone(returned); wrongOperation.workItems[0].id = "resource.different";
  const wrongDue = structuredClone(returned); wrongDue.workItems[0].conclusionAtMs += 60000;
  for (const uncertain of [noItem, wrongOperation, wrongDue,
    resources(ready+30*60000, ready+20*60000, "observed-absence-upper-bound", null),
    resources(ready+30*60000, ready+20*60000, undefined, null),
    resources(ready+30*60000, ready+40*60000, "verified-release", null),
    resources(ready+30*60000, ready+20*60000, "verified-release", true)]) {
    t.assertions.assert(replay([owed, uncertain]).state.incidents[returnedId].status === "open",
      "missing, unverified, mismatched, future or currently-held resource evidence closed an observed obligation");
  }
  const staleResolution = replay([owed, resources(ready+30*60000, ready+40*60000, "verified-release", null), resources(ready+45*60000, undefined, undefined, null)]);
  t.assertions.assert(staleResolution.state.incidents[returnedId].status === "open", "a stored resolution timestamp replaced fresh return evidence");
  const heldAgain = replay([owed, returned, resources(ready+45*60000)]);
  t.assertions.assert(heldAgain.steps[2].new.length === 1 && heldAgain.state.incidents[returnedId].status === "closed"
    && Object.values(heldAgain.state.incidents).some((x: any) => x.rule === "R5" && x.workItemId === "resource.returned" && x.status === "open" && x.id !== returnedId),
    "a genuinely observed new resource obligation was suppressed by its resolved historical occurrence");
  const quiet = replay([facts(base+22*h)]);
  t.assertions.assert(!Object.keys(quiet.state.incidents).length && !existsSync(join(output, ".genethub/team/quality/live-alerts.json")), "quiet external replay created an incident or wrote native Team state");
  const shortTier=parallel(base+19*h+30*60000);shortTier.r6Basis="task-agent-hours/2";
  const tiered=replay([shortTier]);
  t.assertions.assert(!Object.keys(tiered.state.incidents).length,"one Agent on a half-hour task incorrectly opened a live R6 redline");
  const nextTier=parallel(base+20*h);nextTier.r6Basis="task-agent-hours/2";
  const tierFailure=replay([shortTier,nextTier]);
  t.assertions.assert(tierFailure.steps[1].new.length===1 && Object.values(tierFailure.state.incidents).some((x:any)=>x.rule==="R6" && x.measurementVersion.includes("task-agent-hours/2")),"a genuine next-duration-tier deficit did not open a versioned live redline");
  const unitFacts=(end:number)=>{
    const f=facts(end);f.r6Basis="acceptance-unit-agent-hours/3";
    f.acceptanceUnitBasis="dispatch-acceptance-unit/1";f.executionBasis="registered-native-execution-union/2";
    f.acceptanceUnits=["unit.a","unit.b"].map(id=>({unitId:id,taskId:"same-root",boundaryKnown:true,
      boundaryBasis:"dispatch-acceptance-unit/1",openedAtMs:base+19*h,endedAtMs:end,excluded:[],
      sessions:[{sessionId:id+".worker",readable:true,runs:[{startAtMs:end-h,endAtMs:end}]}]}));
    return f;
  };
  const unitFirst=unitFacts(base+22*h),unitNext=unitFacts(base+22*h+60000);
  unitNext.acceptanceUnits=unitNext.acceptanceUnits.filter((x:any)=>x.unitId==="unit.b");
  unitNext.acceptanceUnits.push({unitId:"legacy-container",taskId:"same-root",boundaryKnown:false,
    openedAtMs:base,endedAtMs:unitNext.window.endAtMs,
    excluded:[{startAtMs:unitNext.window.startAtMs,endAtMs:unitNext.window.endAtMs}],sessions:[]});
  const unitReplay=replay([unitFirst,unitNext]),incidents=Object.values(unitReplay.state.incidents)as any[];
  t.assertions.assert(unitReplay.steps[0].new.length===2 && unitReplay.steps[1].new.length===0
    && incidents.some(x=>x.workItemId==="unit.a" && x.status==="closed")
    && incidents.some(x=>x.workItemId==="unit.b" && x.status==="open"),
    "independent units in one root collided or an ineligible unknown container blocked natural closure");
  const working=unitFacts(base+23*h);working.acceptanceUnits=[];
  working.taskTrees=[{taskId:"background-root",openedAtMs:base+22*h,endedAtMs:base+23*h,excluded:[],
    sessions:[{sessionId:"native-worker",readable:true,runs:[],backgroundRuns:[{startAtMs:base+22*h,endAtMs:base+23*h,
      jobId:"registered-build",basis:"registered-native-process-runtime/1"}]}]}];
  working.stalls=[{taskId:"background-root",startAtMs:base+22*h,endAtMs:base+23*h}];
  const workingReplay=replay([working]);
  t.assertions.assert(!workingReplay.steps[0].warnings.some((x:any)=>x.rule==="R4")
    && !Object.values(workingReplay.state.incidents).some((x:any)=>x.rule==="R4"),
    "registered real work cleared the formal stall but left an incompatible live R4 warning");
  t.note("Frozen external timestamp algebra, not historical live Team execution or official score; no internal product import/mocking.");
});

defineSpecialty({
  id: "specialty.daemon.team-quality-live-native-wake",
  title: "An actual Team tick routes redlines once, supports mutable correction notes and never duplicates platform feedback",
  oracle: "A restored unconfirmed source intent references a real Agent-owned task and no invented execution. Actual tick detects its elapsed acknowledgement obligation and routes directly to the platform alert without feedback or Team wake. Optional attribution corrections route Team work to its real Owner and native reflection, preserve correction history and allow further correction. Repeated ticks preserve identities and no-redline ticks add no redline wake.",
  catches: ["redline remains a passive hourly card", "urgent redline obeys ordinary wake delay", "duplicate redline notes or platform feedback", "automatic responsibility blocked on triage", "diagnostic failure erases the previous alert"],
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
    t.assertions.assert(incident && incident.notification.target === "platform-development"
      && redNotes().length === 0 && existsSync(join(r.root, incident.evidence.path)),
      "platform responsibility did not route directly, or woke Team reflection for mandatory triage");
    const taskView = await cli(owner, ["task", "status", task.taskId]);
    t.assertions.assert(taskView.liveQuality.redLines.some((x: any) => x.id === incident.id), "Owner public brief omitted its current redline");
    const feedback = () => JSON.parse(r.ok(["feedback", "ls", "--open"]));
    t.assertions.assert(!JSON.stringify(feedback()).includes("quality-redline:"+incident.id), "automatic redline created a duplicate platform feedback record");
    await cli(owner, ["quality", "triage", incident.id, "--attribution", "team", "--evidence", "case-owned optional correction of responsibility"]);
    r.ok(["tick"]); await idle(owner);
    const corrected = JSON.parse(r.ok(["quality", "alerts"])).redLines.find((x: any) => x.id === incident.id);
    const reflect = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
    t.assertions.assert(corrected.notification.target === "team" && corrected.corrections.length === 1
      && redNotes().filter(x => x.id === corrected.noteId).length === 1
      && reflect.sessionId && reflect.notifiedNotes.includes(corrected.noteId),
      "Team correction did not reach native reflection once in its detecting tick");
    const ownerMessageId = "quality-redline."+incident.id+"."+owner;
    t.assertions.assert((await r.snapshot(owner)).items.filter(x => x.type === "userMessage" && x.id === ownerMessageId).length === 1,
      "Team redline did not reach its real native Task Owner exactly once");
    await t.tools.waitUntil(async () => !!(await r.snapshot(reflect.sessionId)).summary.latestReply, 20000);
    await cli(owner, ["quality", "triage", incident.id, "--attribution", "kernel", "--evidence", "case-owned revised correction with new evidence"]);
    await cli(owner, ["quality", "triage", incident.id, "--attribution", "kernel", "--evidence", "case-owned revised correction with new evidence"]);
    r.ok(["tick"]); r.ok(["tick"]); await idle(owner);
    const final = JSON.parse(r.ok(["quality", "alerts"]));
    const last = final.redLines.find((x: any) => x.id === incident.id);
    t.assertions.assert(last.notification.target === "platform-development" && last.corrections.length === 2
      && last.attribution.component === "platform-template" && !last.feedbackId
      && !JSON.stringify(feedback()).includes("quality-redline:"+incident.id)
      && redNotes().length === 1
      && (await r.snapshot(owner)).items.filter(x => x.type === "userMessage" && x.id === ownerMessageId).length === 1,
      "correction rewrote automatic evidence, became immutable or replayed redline/feedback notifications");
    // External append-tail crash fault in the diagnostic event file. Scheduling
    // does not read that log; capture failure must not erase the open episode.
    appendFileSync(r.state("events", "events.jsonl"), "{truncated diagnostic append\n");
    r.ok(["tick"]);
    const unavailable = JSON.parse(r.ok(["quality", "alerts"]));
    t.assertions.assert(unavailable.redLines.some((x: any) => x.id === incident.id)
      && unavailable.unknown.some((x: any) => x.rule === "live-capture"), "failed diagnostic read erased a known open redline or claimed health");
    t.note("Actual native task/timer, platform alert, Team Owner/reflection routing and optional correction history, with one explicit restored source-intent fixture; no observation reminder, no live Team writes or official quality80 claim.");
  } finally { await r.dispose(); }
});

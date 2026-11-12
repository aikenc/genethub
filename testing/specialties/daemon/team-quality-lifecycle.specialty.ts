import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-archived-failed-owner",
  title: "An archived native failure notification does not stop observing an unfinished Task Owner",
  oracle: "An actual native Owner fails upstream and its normal failure notification is delivered and archived. Across a real wall-clock minute boundary the normal Team tick records another actual paused observation while preserving the original input, stable failure result and unfinished business Task. No clock or observation fixture is substituted.",
  catches: ["failure result archiving stops Task observations", "paused native failure becomes missing R2/R4 coverage", "sampling resumes failed input", "diagnostic repair fabricates business completion or repeats failure result"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task start", "tools/run.py tick", "session.get", "filesystem"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 75000, timeoutMs: 150000,
}, async t => {
  const r = await openTeam(t, "archived-failed-owner", [{ id: "ctl-cli-command", profile: "cli-command" },
    { id: "ctl-failed-owner", profile: "coded-failure", failureCode: "upstream" }]);
  try {
    const config = path.join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-failed-owner\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const front = await r.create("ctl-cli-command"), requestId = "failed-owner.goal";
    await r.send(front, JSON.stringify({ requestId, cwd: r.root,
      argv: [process.env.GENEHUB_PYTHON!, path.join(r.root, "tools/run.py"), "task", "start", "--space", "leader", "--desc", "failed native Owner", "--request-id", requestId, "Attempt a bounded external check"] }));
    let task: any;
    await t.tools.waitUntil(async () => {
      const view = await r.snapshot(front), item = view.items.findLast(x => x.type === "assistantMessage" && x.text.includes(JSON.stringify(requestId)));
      if (item?.type === "assistantMessage") { const v = JSON.parse(item.text); t.assertions.assert(v.code === 0, v.err); task = JSON.parse(v.out); }
      return Boolean(task) && view.summary.status === "idle";
    }, 20000);
    const owner = task.owner.sessionId;
    await t.tools.waitUntil(async () => (await r.snapshot(owner)).summary.status === "failed", 20000);
    const input = (await r.snapshot(owner)).summary.inputSummary;
    r.ok(["tick"]);
    await t.tools.waitUntil(async () => (await r.snapshot(front)).summary.status === "idle", 20000);
    r.ok(["tick"]);
    const done = r.state("done", owner + ".json"), pending = r.state("pending", owner + ".json");
    t.assertions.assert(existsSync(done) && !existsSync(pending), "native failure result did not reach the archived observation boundary");
    const receipt = readFileSync(done), archived = JSON.parse(receipt.toString()), afterArchive = Date.now();
    t.assertions.assert(archived.resultDelivery?.queued && input?.paused && input.pendingMessageIds.length > 0,
      "native failure or original result is missing");
    await t.tools.waitUntil(async () => Math.floor(Date.now() / 60000) > Math.floor(afterArchive / 60000), 65000);
    r.ok(["tick"]);
    const events = readFileSync(r.state("events", "events.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x));
    t.assertions.assert(events.some(x => x.kind === "session-observed" && x.sessionId === owner && x.atMs > afterArchive && x.paused === true),
      "normal tick stopped observing the failed Owner after result archiving");
    const current = (await r.snapshot(owner)).summary.inputSummary, ledger = JSON.parse(readFileSync(r.state("tasks", task.taskId + ".json"), "utf8"));
    t.assertions.assert(JSON.stringify(current) === JSON.stringify(input) && !ledger.finished && readFileSync(done).equals(receipt)
      && (await r.snapshot(front)).items.filter(x => x.type === "userMessage" && x.id === archived.resultDelivery.messageId).length === 1,
      "measurement repair resumed input, settled the Task or repeated/rewrote the original failure result");
  } finally { await r.dispose(); }
});

defineSpecialty({
  id: "specialty.daemon.team-quality-lifecycle",
  title: "Real task commands preserve optional quality metadata and business completion when the event destination fails",
  oracle: "A real Agent caller dispatches supports, replays follows/standing once, binds a native writer lease and finishes through a filesystem fault of both event persistence sinks; public diagnostic capture then matches native handoff IDs/timestamps without changing business records.",
  catches: ["new default fields invalidate old operations", "follows points outside the Team ledger", "optional metadata changes under retry", "diagnostic write failure prevents actual conclusion", "quality capture invents a read-in or mutates business"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py quality facts", "genet-cli", "session.inspect"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "quality-lifecycle", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const decode = (value: string, label: string) => {
      try { return JSON.parse(value); } catch (error) {
        throw new Error(label+" returned malformed JSON: "+String(error)+"; lines="+value.split("\n").length+"; firstCodePoints="+JSON.stringify([...value.slice(0,10)].map(x=>x.codePointAt(0))));
      }
    };
    const config=path.join(r.root,".genethub/open.env");
    writeFileSync(config, readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle = (sid:string) => t.tools.waitUntil(async () => {
      const summary=(await r.snapshot(sid)).summary;
      return summary.status==="idle" && !summary.inputSummary?.pendingMessageIds.length;
    },30000);
    const captureScript=path.join(r.root,"agent-quality-capture.py");
    writeFileSync(captureScript,"import subprocess,sys\nwith open(sys.argv[1],'w') as stream:\n r=subprocess.run(sys.argv[2:],stdout=stream)\nraise SystemExit(r.returncode)\n");
    let requestSequence=0;
    const cli = async (sid:string,args:string[]) => {
      const requestId="quality-lifecycle."+(++requestSequence);
      const output=args[0]==="quality"?path.join(r.root,requestId+".json"):null;
      const argv=output?["python3",captureScript,output,"python3",path.join(r.root,"tools/run.py"),...args]:["python3",path.join(r.root,"tools/run.py"),...args];
      await r.send(sid,JSON.stringify({argv,cwd:r.root,requestId}));
      await idle(sid);
      const last=(await r.snapshot(sid)).items.filter(x=>{
        if(x.type!=="assistantMessage")return false;
        try{return JSON.parse(x.text).requestId===requestId;}catch{return false;}
      }).at(-1);
      if(last?.type!=="assistantMessage") throw new Error("real caller returned no command outcome");
      const value=decode(last.text,"Agent command "+args.slice(0,2).join(" ")) as {code:number,out:string,err:string};
      if(output && existsSync(output))value.out=readFileSync(output,"utf8");
      return value;
    };
    const ok = async (sid:string,args:string[]) => {
      const value=await cli(sid,args);
      t.assertions.assert(value.code===0,"public task failed: "+value.out+value.err);
      return decode(value.out.trim().split("\n").at(-1)!,"CLI "+args.slice(0,2).join(" "));
    };
    const front=await r.create("ctl-cli-command");
    const task=await ok(front,["task","start","--space","leader","--desc","bounded observation fixture","--request-id","quality.goal","Coordinate independent bounded checks"]);
    const owner=task.owner.sessionId as string;await idle(owner);
    // A paused native Owner still owns an unfinished user goal. A documented
    // age limit must not archive its observation or silently resolve the task.
    const ownerPending=r.state("pending",owner+".json");
    const originalConfig=readFileSync(config,"utf8");
    try {
      writeFileSync(config,originalConfig+"\nTEAM_GIVEUP_AFTER=0\n");
      await r.client.call({type:"session.interrupt",payload:{sessionId:owner}});
      await t.tools.waitUntil(async()=>Boolean((await r.snapshot(owner)).summary.inputSummary?.paused),10000);
      r.ok(["hook"]);
      t.assertions.assert(existsSync(ownerPending)
        && !JSON.parse(readFileSync(r.state("tasks",task.taskId+".json"),"utf8")).finished,
        "age limit archived a paused Owner with an unfinished user goal");
      const observed=JSON.parse(readFileSync(ownerPending,"utf8")).observedAtMs;
      r.ok(["hook"]);
      t.assertions.assert(existsSync(ownerPending)
        && JSON.parse(readFileSync(ownerPending,"utf8")).observedAtMs>observed
        && (await r.snapshot(owner)).summary.inputSummary?.paused===true,
        "unresolved paused Owner lost ongoing observation or was automatically resumed");
    } finally { writeFileSync(config,originalConfig); }
    const continued=await ok(owner,["task","status",task.taskId]);
    t.assertions.assert(continued.owner.sessionId===owner,"explicit continuation replaced the original Owner");
    const first=await ok(owner,["task","support",task.taskId,"--space","qa","--desc","original check","--request-id","quality.original","Check a bounded artifact"]);
    await idle(first.collaborator);
    const status=await ok(owner,["task","status",task.taskId]);
    const original=status.collaborators.find((x:any)=>x.sessionId===first.collaborator).operationId as string;
    const follow=["task","support",task.taskId,"--space","qa","--desc","standing follow-up","--request-id","quality.follow","--follows",original,"--standing","Continue a declared standing check"];
    const second=await ok(owner,follow);await idle(second.collaborator);
    const duplicate=await ok(owner,follow);
    t.assertions.assert(second.collaborator===duplicate.collaborator,"metadata retry created another native support");
    const intentFiles=()=>readdirSync(r.state("task-dispatch")).filter(x=>x.endsWith(".json"));
    const followIntent=intentFiles().map(x=>JSON.parse(readFileSync(r.state("task-dispatch",x),"utf8"))).find(x=>x.sessionId===second.collaborator);
    t.assertions.assert(followIntent.request.follows===original && followIntent.request.standing===true,"follows/standing disappeared before the durable request");
    const changed=await cli(owner,follow.filter(x=>x!=="--standing"));
    t.assertions.assert(changed.code!==0,"same request identity accepted changed optional metadata");
    const beforeCount=intentFiles().length;
    const invalid=await cli(owner,["task","support",task.taskId,"--space","qa","--desc","invalid reference","--request-id","quality.invalid","--follows","outside-team","No new work may be created"]);
    t.assertions.assert(invalid.code!==0 && intentFiles().length===beforeCount,"invalid follows mutated the dispatch ledger");
    const directory=path.join(r.root,"bounded-writer");mkdirSync(directory);
    await ok(first.collaborator,["task","bind-directory",task.taskId,"--directory",directory]);
    const roundReply=await r.client.call({type:"session.rounds",payload:{sessionId:first.collaborator,throughRoundId:null,cursor:null,limit:100}});
    if(roundReply?.type!=="sessionRounds") throw new Error("public native rounds unavailable for idle fixture");
    const bindRound=roundReply.data.rounds.filter(x=>typeof x.endedAtMs==="number").sort((a,b)=>b.startedAtMs-a.startedAtMs)[0];
    if(!bindRound || typeof bindRound.endedAtMs!=="number") throw new Error("real bind-directory execution did not end");
    const afterBind=bindRound.endedAtMs+1;
    await t.tools.waitUntil(()=>Date.now()>=afterBind,1000);
    const eventFile=r.state("events","events.jsonl");
    // Explicit frozen observation input, not claimed as native timer evidence.
    // The real public Round independently proves work between these samples.
    for(const [label,atMs] of [["before",bindRound.startedAtMs-1],["after",afterBind]] as const)
      appendFileSync(eventFile,JSON.stringify({schema:"team-process-event/1",eventId:"fixture.idle."+label,kind:"session-observed",
        sessionId:first.collaborator,atMs,recordedAtMs:Date.now(),status:"idle",paused:false,waitingForUser:false,fixture:"frozen-observation-input"})+"\n");
    const idleReadback=r.command(["quality","facts"]);
    t.assertions.assert(idleReadback.code===0,"public collector rejected bounded observation fixture: "+idleReadback.err);
    const idleFacts=decode(idleReadback.out,"idleReadback public capture");
    t.assertions.assert(idleFacts.attributionContext?.schema==="team-quality-attribution-context/1" && idleFacts.attributionContext.dispatch==="builtin-task/1", "native capture lacks attribution provenance for automatic dispatch/result/resource obligations");
    t.assertions.assert(idleFacts.coverage.resources===true,
      "work without a conclusion manufactured an unknown overdue resource obligation");
    const idleItem=idleFacts.workItems.find((x:any)=>x.id===original);
    t.assertions.assert(Array.isArray(idleItem?.idlePeriods) && idleItem.idlePeriods.some((x:any)=>x.resolvedAtMs===bindRound.startedAtMs)
      && idleItem.idlePeriods.some((x:any)=>x.startAtMs>=afterBind),"sampled idle was joined across a genuine native execution");
    await r.client.call({type:"session.interrupt",payload:{sessionId:first.collaborator}});
    await t.tools.waitUntil(async()=>Boolean((await r.snapshot(first.collaborator)).summary.inputSummary?.paused),10000);
    r.ok(["hook"]);
    const pauseEvent=readFileSync(eventFile,"utf8").trim().split("\n").map(x=>JSON.parse(x))
      .find(x=>x.kind==="session-observed" && x.sessionId===first.collaborator && x.paused===true && !x.fixture);
    t.assertions.assert(Boolean(pauseEvent),"real public interruption did not yield a native pause observation");
    const pauseReadback=r.command(["quality","facts"]);
    t.assertions.assert(pauseReadback.code===0,"native paused-work capture failed: "+pauseReadback.err);
    const pausedItem=decode(pauseReadback.out,"pauseReadback public capture").workItems.find((x:any)=>x.id===original);
    t.assertions.assert(pausedItem?.workActivity?.excluded.some((x:any)=>x.startAtMs<=pauseEvent.atMs && x.endAtMs>pauseEvent.atMs)
      && pausedItem.workActivity.active.some((x:any)=>x.startAtMs<=bindRound.startedAtMs && x.endAtMs>=bindRound.endedAtMs),
      "native pause was counted as effective work or actual native execution was lost");
    // Explicit stale waiting observation: genuine native execution is the
    // independent stronger evidence, not the diagnostic sample's claim.
    const savedSamples=readFileSync(eventFile);
    try {
      writeFileSync(eventFile,savedSamples.toString().trim().split("\n").map(x=>JSON.parse(x))
        .filter(x=>x.kind!=="session-observed" || x.sessionId!==first.collaborator).map(x=>JSON.stringify(x)).join("\n")+"\n");
      appendFileSync(eventFile,JSON.stringify({schema:"team-process-event/1",eventId:"fixture.stale.wait",kind:"session-observed",
        sessionId:first.collaborator,atMs:bindRound.startedAtMs-1,recordedAtMs:Date.now(),status:"idle",paused:false,
        waitingForUser:true,fixture:"frozen-observation-input"})+"\n");
      const stale=r.command(["quality","facts"]);
      t.assertions.assert(stale.code===0,"stale observation capture failed");
      const activity=decode(stale.out,"stale public capture").workItems.find((x:any)=>x.id===original).workActivity;
      t.assertions.assert(activity.active.some((x:any)=>x.startAtMs<=bindRound.startedAtMs && x.endAtMs>=bindRound.endedAtMs)
        && !activity.excluded.some((x:any)=>x.startAtMs<bindRound.endedAtMs && x.endAtMs>bindRound.startedAtMs),
        "stale waiting sample erased independently observed native work");
      const staleRows=readFileSync(eventFile,"utf8").trim().split("\n").map(x=>JSON.parse(x));
      staleRows.find(x=>x.eventId==="fixture.stale.wait").atMs=idleItem.startedAtMs-126000;
      writeFileSync(eventFile,staleRows.map(x=>JSON.stringify(x)).join("\n")+"\n");
      const expired=r.command(["quality","facts"]);
      t.assertions.assert(expired.code===0 && decode(expired.out,"expired public capture").workItems.find((x:any)=>x.id===original)
        .workActivity.excluded.length===0,"expired pause observation erased later unobserved time");
    } finally {writeFileSync(eventFile,savedSamples);}
    await ok(first.collaborator,["task","finish",task.taskId,"--outcome","success","Actual first check has concluded"]);
    const historicalSupport=await ok(owner,["task","support",task.taskId,"--space","qa","--desc","no resource check","--request-id","quality.noresource","Conclude without taking a resource"]);
    await idle(historicalSupport.collaborator);
    await ok(historicalSupport.collaborator,["task","finish",task.taskId,"--outcome","success","No resource was acquired"]);
    const historicalIntent=intentFiles().map(x=>JSON.parse(readFileSync(r.state("task-dispatch",x),"utf8"))).find(x=>x.sessionId===historicalSupport.collaborator);
    // Explicit historical ledger fixture, before the separate event failure.
    // Native idle sessions/process absence stay real; restore all changed bytes.
    const historicalTask=r.state("tasks",task.taskId+".json");
    const historicalPath=r.state("task-dispatch",historicalIntent.operationId+".json");
    const savedTask=readFileSync(historicalTask),savedIntent=readFileSync(historicalPath),savedEvents=readFileSync(eventFile);
    const savedChecks=[original,historicalIntent.operationId].map(id=>{
      const file=r.state("quality","resource-checks",id+".json");
      return {file,bytes:existsSync(file)?readFileSync(file):null};
    });
    try {
      const historical=JSON.parse(savedTask.toString());
      const finishedAt=Date.now()-660000;
      historical.collaborators.find((x:any)=>x.sessionId===historicalSupport.collaborator).finished.atMs=finishedAt;
      writeFileSync(historicalTask,JSON.stringify(historical));
      writeFileSync(historicalPath,JSON.stringify({...JSON.parse(savedIntent.toString()),createdAtMs:finishedAt-60000}));
      const withoutRelease=savedEvents.toString().trim().split("\n").map(x=>JSON.parse(x))
        .filter(x=>!(x.kind==="resource-released" && x.operationId===historicalIntent.operationId));
      writeFileSync(eventFile,withoutRelease.map(x=>JSON.stringify(x)).join("\n")+"\n");
      const noResource=r.command(["quality","facts"]);
      t.assertions.assert(noResource.code===0,"historical no-resource capture failed: "+noResource.err);
      const noResourceFacts=decode(noResource.out,"noResource public capture");
      const noResourceItem=noResourceFacts.workItems.find((x:any)=>x.sessionId===historicalSupport.collaborator);
      t.assertions.assert(noResourceItem?.resourceRequired===false && noResourceItem.releasedAtMs>finishedAt+600000,
        "fixture did not reach late native absence for non-resource work");
      t.assertions.assert(noResourceFacts.coverage.resources===true,
        "a no-resource conclusion manufactured uncertain resource return coverage: "+JSON.stringify(noResourceFacts.issues));
      historical.collaborators.find((x:any)=>x.sessionId===first.collaborator).finished.atMs=finishedAt;
      writeFileSync(historicalTask,JSON.stringify(historical));
      writeFileSync(eventFile,withoutRelease.filter(x=>!(x.kind==="resource-released" && x.operationId===original))
        .map(x=>JSON.stringify(x)).join("\n")+"\n");
      const leased=r.command(["quality","facts"]);
      t.assertions.assert(leased.code===0 && decode(leased.out,"leased public capture").coverage.resources===false,
        "a real resource obligation lost uncertainty about its historical release time");
    } finally {
      writeFileSync(historicalTask,savedTask);writeFileSync(historicalPath,savedIntent);writeFileSync(eventFile,savedEvents);
      for(const {file,bytes} of savedChecks) {
        if(bytes) writeFileSync(file,bytes);
        else if(existsSync(file)) unlinkSync(file);
      }
    }
    // Explicit real filesystem fault, after the first genuine conclusion.
    const saved=eventFile+".preserved";
    renameSync(eventFile,saved);mkdirSync(eventFile);
    // Append alone is recoverable. Fault both actual persistence sinks to
    // keep this case's genuine missing-event and conservative coverage oracle.
    const eventSpool=r.state("events","spool"),savedSpool=eventSpool+".preserved";
    renameSync(eventSpool,savedSpool);writeFileSync(eventSpool,"case-owned unavailable spool destination");
    try {
      await ok(second.collaborator,["task","finish",task.taskId,"--outcome","success","Business conclusion survives event storage failure"]);
    } finally {
      unlinkSync(eventSpool);renameSync(savedSpool,eventSpool);
      rmdirSync(eventFile);renameSync(saved,eventFile);
    }
    r.ok(["tick"]);await idle(owner);
    const rows=readFileSync(eventFile,"utf8").trim().split("\n").map(x=>JSON.parse(x));
    t.assertions.assert(new Set(rows.map(x=>x.eventId)).size===rows.length,"stable process event identities duplicated under retry");
    for(const kind of ["dispatch","dispatch-confirmed","input-accepted","conclusion","resource-released"])
      t.assertions.assert(rows.some(x=>x.kind===kind),"genuine public lifecycle missed "+kind);
    t.assertions.assert(readdirSync(r.state("events","failures")).length>0,"event failure was silently erased");
    const taskPath=r.state("tasks",task.taskId+".json"),businessBefore=readFileSync(taskPath);
    const nested=await ok(owner,["task","start","--space","leader","--desc","internal maintenance","--request-id","quality.internal","Coordinate a role-internal maintenance check"]);
    await idle(nested.owner.sessionId);
    // Isolated migration fixture: remove only the optional diagnostic release
    // event. The real conclusion, durable release flag and actual writer unlock
    // remain untouched; this is explicitly not historical native timer proof.
    const legacyEvents=readFileSync(eventFile,"utf8").trim().split("\n").map(x=>JSON.parse(x));
    writeFileSync(eventFile,legacyEvents.filter(x=>!(x.kind==="resource-released" && x.operationId===original)).map(x=>JSON.stringify(x)).join("\n")+"\n");
    const boundFile=r.state("quality","resource-checks",original+".json");
    const priorBound=existsSync(boundFile)?JSON.parse(readFileSync(boundFile,"utf8")).legacyReleaseObservedAtMs:null;
    const beforeLegacyCapture=Date.now();
    const facts=await ok(owner,["quality","facts"]);
    t.assertions.assert(readFileSync(taskPath).equals(businessBefore),"diagnostic capture rewrote the actual task record");
    const observed=facts.workItems.find((x:any)=>x.id===original);
    t.assertions.assert(observed.sessionId===first.collaborator && typeof observed.startedAtMs==="number"
      && typeof observed.deliveredAtMs==="number" && typeof observed.consumedAtMs==="number",
      "public capture did not match actual native start/delivery/read-in facts: "+JSON.stringify(observed));
    const absence=JSON.parse(readFileSync(boundFile,"utf8"));
    t.assertions.assert(observed.legacyReleaseStateKnown===true && typeof observed.releasedAtMs==="number"
      && observed.releaseTimeBasis==="observed-absence-upper-bound"
      && observed.releasedAtMs===absence.legacyReleaseObservedAtMs
      && absence.firstAbsentAtMs<=observed.releasedAtMs
      && (typeof priorBound==="number"?observed.releasedAtMs===priorBound:observed.releasedAtMs>=beforeLegacyCapture)
      &&observed.releasedAtMs<=Date.now(),
      "legacy release did not retain its actual observed absence upper bound: "+JSON.stringify(observed));
    const repeatedFacts=await ok(owner,["quality","facts"]);
    t.assertions.assert(repeatedFacts.workItems.find((x:any)=>x.id===original).releasedAtMs===observed.releasedAtMs,
      "repeated capture moved the first-observed legacy absence upper bound");
    t.assertions.assert(facts.captureKind==="diagnostic" && facts.coverage.observations===false,
      "a partial diagnostic observation became complete hourly evidence");
    t.assertions.assert(facts.goalBasis?.taskIds?.includes(task.taskId) && !facts.goalBasis.taskIds.includes(nested.taskId),
      "an internal role Task manufactured user-goal exposure");
    t.assertions.assert(facts.r6Basis==="task-agent-hours/2","actual native capture omitted its duration-tier scoring basis");
    const tick=await ok(owner,["quality","tick"]);
    const savedCard=readFileSync(tick.card,"utf8");
    const readCard=await cli(owner,["quality","card"]);
    t.assertions.assert(readCard.code===0 && readCard.out===savedCard && JSON.parse(savedCard).formal===false
      && JSON.parse(savedCard).officialCapture===true,
      "saved native card and frozen recomputation differ, or empty priorhour became formal");
    const resaved=await cli(owner,["quality","card","--save"]);
    t.assertions.assert(resaved.code===0 && resaved.out===savedCard,"official frozen re-save changed the card");
    const history=await ok(owner,["quality","history"]);
    t.assertions.assert(history.cards.length===1 && history.cards[0].factsSha256===JSON.parse(savedCard).factsSha256,
      "hour history did not retain its frozen facts identity");
    r.ok(["reflect","now","--model","fixture","Inspect current measured quality losses"],{TEAM_AGENT:"ctl-normal",GENEHUB_SESSION_ID:front});
    const briefings=readdirSync(r.state("briefings")).filter(x=>x.endsWith(".md")).sort();
    const brief=readFileSync(r.state("briefings",briefings.at(-1)!),"utf8");
    const latestCardRef=JSON.parse(readFileSync(r.state("quality","latest.json"),"utf8"));
    const attribution=JSON.parse(savedCard).attribution;
    t.assertions.assert([...brief].length<=5000 && brief.includes(latestCardRef.card) && brief.includes(latestCardRef.snapshot)
      && attribution?.schema==="team-quality-loss-attribution/1" && attribution.allLossesCount===true
      && typeof attribution.totalAccountedLoss==="number" && Object.keys(attribution.lossByComponent).length>0,
      "bounded reflection briefing lost its native card/facts references or referenced full-card attribution totals");
    const pointer=r.state("quality","latest.json"),pointerBefore=readFileSync(pointer);
    const ready=path.join(r.root,"capture-lock-ready");
    const lockScript=`import os,pathlib,sys
p=pathlib.Path(sys.argv[1]);f=p.open('a+b')
if os.name=='nt':
 import msvcrt
 if p.stat().st_size==0:f.write(b'0');f.flush()
 f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_LOCK,1)
else:
 import fcntl
 fcntl.flock(f.fileno(),fcntl.LOCK_EX)
pathlib.Path(sys.argv[2]).write_text('locked')
sys.stdin.read(1)
`;
    const locker=spawn(process.env.GENEHUB_PYTHON!,["-c",lockScript,r.state("inbox","quality-capture.lock"),ready],{env:r.env,stdio:["pipe","ignore","ignore"]});
    try {
      await t.tools.waitUntil(async()=>existsSync(ready),5000);
      t.assertions.assert(locker.exitCode===null,"OS contention fixture exited before the public call");
      const busy=r.command(["quality","tick"]);
      t.assertions.assert(busy.code===0 && JSON.parse(busy.out).status==="busy" && JSON.parse(busy.out).cardProduced===false
        && readFileSync(pointer).equals(pointerBefore),"concurrent quality capture failed the hook or claimed another card");
    } finally {
      locker.stdin?.end();
      await t.tools.waitUntil(async()=>locker.exitCode!==null,5000);
    }

    // Case-owned durable receipt loss, while the actual daemon is stopped.
    // Preserve genuine history, rounds and the Team's real acceptance event;
    // the public native reader must expose the fault before capture uses it.
    await idle(owner);
    const acceptance=readFileSync(eventFile,"utf8").trim().split("\n").map(x=>JSON.parse(x))
      .find(x=>x.kind==="input-accepted" && x.purpose==="result" && x.sessionId===owner
        && (x.ref||"").includes(first.collaborator));
    t.assertions.assert(Boolean(acceptance),"real accepted result event missing before receipt-loss fixture");
    const ownerWorkspaceId=(await r.snapshot(owner)).summary.workspaceId;
    const ownerWorkspace=r.spaces.find(x=>x.id===ownerWorkspaceId);
    if(!ownerWorkspace) throw new Error("actual owner workspace not found");
    const metaPath=path.join(ownerWorkspace.root,".genethub/sessions",owner,"meta.json");
    const stopped=await runGenetAsync(r.daemon.genet,["daemon","stop"],r.daemon.env);
    t.assertions.assert(stopped.code===0,"isolated daemon did not stop for durable loss fixture");
    const meta=JSON.parse(readFileSync(metaPath,"utf8"));
    t.assertions.assert(meta.inbox.entries.some((x:any)=>x.messageId===acceptance.messageId),"target receipt absent before fault");
    meta.inbox.entries=meta.inbox.entries.filter((x:any)=>x.messageId!==acceptance.messageId);
    writeFileSync(metaPath,JSON.stringify(meta));
    const cache=r.state("quality","native",owner+".json");if(existsSync(cache)) unlinkSync(cache);
    const restarted=await runGenetAsync(r.daemon.genet,["daemon","start"],r.daemon.env);
    t.assertions.assert(restarted.code===0,"isolated daemon failed to restart");
    await t.tools.waitUntil(()=>r.client.connectionState==="ready",30000);
    const inspected=await r.client.call({type:"session.inspect",payload:{sessionId:owner,throughRoundId:null}});
    if(inspected?.type!=="sessionInspection") throw new Error("native loss inspection unavailable: "+inspected?.type);
    t.assertions.assert(!inspected.data.retainedInputs?.some(x=>x.messageId===acceptance.messageId),
      "fault did not remove the real native receipt");
    const historical=r.command(["quality","facts"]);
    t.assertions.assert(historical.code===0,"public historical delivery capture failed: "+historical.err);
    const bounded=decode(historical.out,"historical public capture").workItems.find((x:any)=>x.id===original);
    t.assertions.assert(bounded.deliveredAtMs==null && bounded.consumedAtMs==null
      && bounded.deliveryBounds?.some((x:any)=>x.messageId===acceptance.messageId
        && x.recipient===owner && x.acceptedUpperBoundMs===acceptance.atMs),
      "native history and acceptance event lost their bound or manufactured exact delivery/read time");
    const savedDeliveryEvents=readFileSync(eventFile);
    try {
      writeFileSync(eventFile,savedDeliveryEvents.toString().trim().split("\n").map(x=>JSON.parse(x))
        .filter(x=>x.eventId!==acceptance.eventId).map(x=>JSON.stringify(x)).join("\n")+"\n");
      const withoutEvent=r.command(["quality","facts"]);
      t.assertions.assert(withoutEvent.code===0,"header-only capture failed");
      const unproven=decode(withoutEvent.out,"withoutEvent public capture").workItems.find((x:any)=>x.id===original);
      t.assertions.assert(!unproven.deliveryBounds?.length && unproven.deliveryCoverageKnown===false,
        "history without a matching acceptance event invented a timed delivery bound");
    } finally {writeFileSync(eventFile,savedDeliveryEvents);}

  } finally { await r.dispose(); }
});

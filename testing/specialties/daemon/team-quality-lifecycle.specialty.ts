import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-lifecycle",
  title: "Real task commands preserve optional quality metadata and business completion when the event destination fails",
  oracle: "A real Agent caller dispatches supports, replays follows/standing once, binds a native writer lease and finishes through a filesystem event fault; public diagnostic capture then matches native handoff IDs/timestamps without changing business records.",
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
    const config=path.join(r.root,".genethub/open.env");
    writeFileSync(config, readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle = (sid:string) => t.tools.waitUntil(async () => {
      const summary=(await r.snapshot(sid)).summary;
      return summary.status==="idle" && !summary.inputSummary?.pendingMessageIds.length;
    },30000);
    const cli = async (sid:string,args:string[]) => {
      await r.send(sid,JSON.stringify({argv:["python3",path.join(r.root,"tools/run.py"),...args],cwd:r.root}));
      await idle(sid);
      const last=(await r.snapshot(sid)).items.filter(x=>x.type==="assistantMessage").at(-1);
      if(last?.type!=="assistantMessage") throw new Error("real caller returned no command outcome");
      return JSON.parse(last.text) as {code:number,out:string,err:string};
    };
    const ok = async (sid:string,args:string[]) => {
      const value=await cli(sid,args);
      t.assertions.assert(value.code===0,"public task failed: "+value.out+value.err);
      return JSON.parse(value.out.trim().split("\n").at(-1)!);
    };
    const front=await r.create("ctl-cli-command");
    const task=await ok(front,["task","start","--space","leader","--desc","bounded observation fixture","--request-id","quality.goal","Coordinate independent bounded checks"]);
    const owner=task.owner.sessionId as string;await idle(owner);
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
    const idleFacts=JSON.parse(idleReadback.out);
    t.assertions.assert(idleFacts.coverage.resources===true,
      "work without a conclusion manufactured an unknown overdue resource obligation");
    const idleItem=idleFacts.workItems.find((x:any)=>x.id===original);
    t.assertions.assert(Array.isArray(idleItem?.idlePeriods) && idleItem.idlePeriods.some((x:any)=>x.resolvedAtMs===bindRound.startedAtMs)
      && idleItem.idlePeriods.some((x:any)=>x.startAtMs>=afterBind),"sampled idle was joined across a genuine native execution");
    await ok(first.collaborator,["task","finish",task.taskId,"--outcome","success","Actual first check has concluded"]);
    // Explicit real filesystem fault, after the first genuine conclusion.
    const saved=eventFile+".preserved";
    renameSync(eventFile,saved);mkdirSync(eventFile);
    await ok(second.collaborator,["task","finish",task.taskId,"--outcome","success","Business conclusion survives event append failure"]);
    rmdirSync(eventFile);renameSync(saved,eventFile);
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
    const beforeLegacyCapture=Date.now();
    const facts=await ok(owner,["quality","facts"]);
    t.assertions.assert(readFileSync(taskPath).equals(businessBefore),"diagnostic capture rewrote the actual task record");
    const observed=facts.workItems.find((x:any)=>x.id===original);
    t.assertions.assert(observed.sessionId===first.collaborator && typeof observed.startedAtMs==="number"
      && typeof observed.deliveredAtMs==="number" && typeof observed.consumedAtMs==="number",
      "public capture did not match actual native start/delivery/read-in facts: "+JSON.stringify(observed));
    t.assertions.assert(observed.legacyReleaseStateKnown===true && typeof observed.releasedAtMs==="number"
      && observed.releaseTimeBasis==="observed-absence-upper-bound" && observed.releasedAtMs>=beforeLegacyCapture,
      "legacy durable release was ignored or a historical exact timestamp was invented: "+JSON.stringify(observed));
    const repeatedFacts=await ok(owner,["quality","facts"]);
    t.assertions.assert(repeatedFacts.workItems.find((x:any)=>x.id===original).releasedAtMs===observed.releasedAtMs,
      "repeated capture moved the first-observed legacy absence upper bound");
    t.assertions.assert(facts.captureKind==="diagnostic" && facts.coverage.observations===false,
      "a partial diagnostic observation became complete hourly evidence");
    t.assertions.assert(facts.goalBasis?.taskIds?.includes(task.taskId) && !facts.goalBasis.taskIds.includes(nested.taskId),
      "an internal role Task manufactured user-goal exposure");
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

  } finally { await r.dispose(); }
});

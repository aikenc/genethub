import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-history-cache",
  title: "Native history survives cache checkpoints and genuine running-Round progress between pages",
  oracle: "Real native Task/Owner histories are read through the public collector. A transparent CLI forwarder records actual calls. Two real Tasks and 101 additional archived native Sessions require fresh bounded header pages past the first 100 rows without one get per unchanged history. Labelled cache-only horizon and prior guest-version checkpoints cannot force complete stable histories to be re-inspected; foreign or missing machine identity, legacy completeness gaps and new genuine inputs require fresh histories. A real public deletion stays unknown despite cached history and preserves its native refusal identifier and remaining budget. 101 genuine completed Rounds and a real held child force public history pagination; completing that child between actual unchanged CLI replies must retain coherent history and actual current execution. The next fresh observation must include its genuine completion. Native histories are never fabricated; the version checkpoint is not an actual guest upgrade claim.",
  catches: ["live cache narrows the hourly history horizon", "guest patch rereads all closed histories and exhausts capture budget", "foreign machine history is reused", "legacy incomplete history is trusted", "new native inputs reuse stale history", "failed fresh read reuses healthy cached history", "native refusal cause is lost", "stable histories exhaust observation budget with one header RPC each", "only the first header page or unarchived rows are read", "corrupt local header hint aborts every source", "genuine running-Round progress invalidates stable historical pages", "pinning history silently drops current execution"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py quality facts", "session.get", "session.list", "session.create", "session.archive", "session.inspect", "session.rounds", "session.narrative", "session.delete"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 45000, timeoutMs: 180000,
}, async t => {
  const r=await openTeam(t,"history-cache",[{id:"ctl-cli-command",profile:"cli-command"}]);
  try {
    const config=join(r.root,".genethub/open.env");
    writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\n");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;},30000);
    const caller=await r.create("ctl-cli-command");
    await r.send(caller,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),"task","start","--space","leader","--desc","bounded history capture","--request-id","history.goal","Assess one bounded goal"],cwd:r.root,requestId:"history.start"}));await idle(caller);
    const receipt=(await r.snapshot(caller)).items.filter(x=>x.type==="assistantMessage"&&x.text.includes('"history.start"')).at(-1);
    if(receipt?.type!=="assistantMessage")throw Error("real task receipt missing");
    const started=JSON.parse(receipt.text);t.assertions.assert(started.code===0,started.err);
    const task=JSON.parse(started.out.trim().split("\n").at(-1)!);const owner=task.owner.sessionId as string;await idle(owner);
    // A second real Task shares the Owner workspace; both histories must stay
    // independently observable while their unchanged headers are read together.
    await r.send(caller,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),"task","start","--space","leader","--desc","second bounded history","--request-id","history.second","Assess another bounded goal"],cwd:r.root,requestId:"history.second.start"}));await idle(caller);
    const secondReceipt=(await r.snapshot(caller)).items.filter(x=>x.type==="assistantMessage"&&x.text.includes('"history.second.start"')).at(-1);
    if(secondReceipt?.type!=="assistantMessage")throw Error("second real task receipt missing");
    const secondStarted=JSON.parse(secondReceipt.text);t.assertions.assert(secondStarted.code===0,secondStarted.err);
    const secondOwner=JSON.parse(secondStarted.out.trim().split("\n").at(-1)!).owner.sessionId as string;await idle(secondOwner);
    const ownerWorkspace=(await r.snapshot(owner)).summary.workspaceId;

    const log=join(t.env.root,"actual-cli-calls.jsonl"),proxy=join(t.env.root,"forward-native-cli.py");
    writeFileSync(log,"");
    writeFileSync(proxy,`#!${process.env.GENEHUB_PYTHON}\nimport os,sys,json\nwith open(${JSON.stringify(log)},'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\nos.execv(${JSON.stringify(r.daemon.genet)},[${JSON.stringify(r.daemon.genet)}]+sys.argv[1:])\n`);chmodSync(proxy,0o700);
    const facts=()=>JSON.parse(r.ok(["quality","facts"],{GENEHUB_CLI:proxy}));
    const calls=()=>readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x) as string[]);
    const heavy=()=>calls().filter(x=>x[0]==="session"&&["inspect","rounds","narrative"].includes(x[1]));
    const first=facts();t.assertions.assert(first.issues.length===0&&heavy().some(x=>x[2]===owner),"first capture did not read actual native history");
    // Real public metadata, not a mocked page. Newer archived Sessions push the
    // older cached Owners past the first page while contributing no work.
    for(let i=0;i<101;i++){
      const extra=await r.create("ctl-normal",ownerWorkspace);
      await r.client.call({type:"session.archive",payload:{sessionId:extra,archived:true}});
    }
    const ownerPages=()=>calls().filter(x=>x[0]==="session"&&x[1]==="list"&&x.includes(ownerWorkspace));

    const native=r.state("quality","native");
    // Explicit restored cache checkpoint: only its requested horizon changes.
    // All original native history, identities and timestamps remain byte values
    // from the genuine first capture. This is not a historical execution claim.
    const narrow=()=>{for(const f of readdirSync(native)){const p=join(native,f),v=JSON.parse(readFileSync(p,"utf8"));v.sinceAtMs=first.window.endAtMs;writeFileSync(p,JSON.stringify(v));}};
    narrow();writeFileSync(log,"");const second=facts();
    t.assertions.assert(second.issues.length===0&&heavy().length===0&&ownerPages().length>=2&&ownerPages().every(x=>x.includes("--limit")&&x.includes("100")&&x.includes("--include-archived"))&&!calls().some(x=>x[0]==="session"&&x[1]==="get"&&x[2]===owner),
      "unchanged histories still use per-session header reads instead of complete fresh archived header pages");
    const ownerCache=readdirSync(native).map(f=>join(native,f)).find(p=>JSON.parse(readFileSync(p,"utf8")).sessionId===owner);
    if(!ownerCache)throw Error("actual Owner cache missing");
    const checkpoint=JSON.parse(readFileSync(ownerCache,"utf8"));
    t.assertions.assert(checkpoint.historyCoverage?.roundsComplete===true&&checkpoint.historyCoverage?.narrativeComplete===true,"actual Owner history must be fully paged");
    // Old complete history must be reprojected once for integration evidence;
    // a complete old round list alone cannot stand in for the new read basis.
    const oldProjection={...checkpoint,historyCoverage:{...checkpoint.historyCoverage,basis:"native-page-completion/1"}};
    delete oldProjection.integrationReferenceBasis;delete oldProjection.integrationReferences;
    writeFileSync(ownerCache,JSON.stringify(oldProjection));writeFileSync(log,"");const reprojected=facts();
    t.assertions.assert(reprojected.issues.length===0 && heavy().some(x=>x[2]===owner)
      && JSON.parse(readFileSync(ownerCache,"utf8")).integrationReferenceBasis==="native-owner-use-reference/1",
      "old cached projection hid native integration evidence");
    writeFileSync(log,"");facts();
    t.assertions.assert(!heavy().some(x=>x[2]===owner),"refreshed integration projection rereads unchanged history every time");
    // Explicit cache metadata fixture, not a fabricated native upgrade. All
    // original rounds, inputs, timestamps and machine identity stay unchanged.
    const oldPatch={...checkpoint,kernel:{...checkpoint.kernel,version:"prior-guest-patch-checkpoint"}};
    writeFileSync(ownerCache,JSON.stringify(oldPatch));writeFileSync(log,"");const patched=facts();
    t.assertions.assert(patched.issues.length===0&&!heavy().some(x=>x[2]===owner)&&ownerPages().length>=2,
      "guest patch invalidated unchanged complete native history and forced full reads");
    t.assertions.assert(JSON.stringify(patched.turns.filter((x:any)=>x.sessionId===owner))===JSON.stringify(second.turns.filter((x:any)=>x.sessionId===owner)),"cache reuse changed genuine native turns");
    for(const machineId of ["foreign-machine-checkpoint",null]){
      writeFileSync(ownerCache,JSON.stringify({...oldPatch,kernel:{...oldPatch.kernel,machineId}}));writeFileSync(log,"");const foreign=facts();
      t.assertions.assert(foreign.issues.length===0&&heavy().some(x=>x[2]===owner),"foreign or missing machine identity reused native history");
    }
    writeFileSync(ownerCache,JSON.stringify({...oldPatch,historyCoverage:{...oldPatch.historyCoverage,narrativeComplete:false}}));writeFileSync(log,"");const partial=facts();
    t.assertions.assert(partial.issues.length===0&&heavy().some(x=>x[2]===owner),"guest patch trusted a partial native history");
    // Pre-upgrade cache has no complete-pagination proof. Its declared narrow
    // horizon alone must never certify an earlier requested range.
    narrow();
    for(const f of readdirSync(native)){const p=join(native,f),v=JSON.parse(readFileSync(p,"utf8"));delete v.historyCoverage;writeFileSync(p,JSON.stringify(v));}
    writeFileSync(log,"");const legacy=facts();
    t.assertions.assert(legacy.issues.length===0&&heavy().some(x=>x[2]===owner),"legacy cache without completeness proof was trusted across an unproven range");
    // A corrupt local cache is an evidence failure for that source, not a
    // reason to abort every other Session observation while grouping hints.
    const healthyCache=readFileSync(ownerCache);
    for(const damaged of ["{invalid cache checkpoint",JSON.stringify({...JSON.parse(healthyCache.toString()),kernel:"invalid structure checkpoint"})]){
      writeFileSync(ownerCache,damaged);
      const corrupt=facts();
      t.assertions.assert(corrupt.evidenceCoverage.nativeComplete===false&&!corrupt.turns.some((x:any)=>x.sessionId===owner)&&corrupt.issues.some((x:any)=>x.kind==="native-read-unavailable"&&x.sessionId===owner),"corrupt cache hint aborted all native observations or reused healthy history");
    }
    writeFileSync(ownerCache,healthyCache);
    writeFileSync(log,"");const before=legacy.turns.filter((x:any)=>x.sessionId===owner).length;
    await r.send(owner,"A new genuine input must be included in the next observation");await idle(owner);
    const changed=facts();
    t.assertions.assert(changed.issues.length===0&&heavy().some(x=>x[2]===owner)&&changed.turns.filter((x:any)=>x.sessionId===owner).length>before,
      "fresh native input reused stale cached turns");
    // Advance a genuine running Round between actual public history pages.
    // The external child and transparent transport belong to this isolated
    // fixture; every native reply is forwarded byte-for-byte, never fabricated.
    const historyIds:string[]=[];
    const latestRound=async()=>{
      const reply=await r.client.call({type:"session.rounds",payload:{sessionId:owner,throughRoundId:null,cursor:null,limit:1}});
      if(reply?.type!=="sessionRounds"||!reply.data.rounds[0])throw Error("public Owner Round missing");
      return reply.data.rounds[0];
    };
    for(let i=0;i<101;i++){
      await r.send(owner,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,"-c","print('real history checkpoint')"],cwd:r.root,requestId:"history.page."+i}));await idle(owner);
      historyIds.push((await latestRound()).roundId);
    }
    const childStarted=join(t.env.root,"history-child-started"),childRelease=join(t.env.root,"history-child-release");
    const childCode=["import pathlib,time","pathlib.Path("+JSON.stringify(childStarted)+").touch()",
      "while not pathlib.Path("+JSON.stringify(childRelease)+").exists(): time.sleep(.01)","print('genuine child completed')"].join("\n");
    await r.send(owner,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,"-c",childCode],cwd:r.root,requestId:"history.active"}));
    await t.tools.waitUntil(()=>existsSync(childStarted),10000);
    const activeRound=await latestRound();
    t.assertions.assert(!activeRound.endedAtMs,"external child did not keep the genuine Round running");
    const raceProof=join(t.env.root,"actual-page-progress.json"),raceOnce=join(t.env.root,"history-race-once");
    const transparent=readFileSync(proxy,"utf8");
    writeFileSync(proxy,["#!"+process.env.GENEHUB_PYTHON,"import sys,json,pathlib,subprocess,time",
      "cli="+JSON.stringify(r.daemon.genet),"args=sys.argv[1:]",
      "with open("+JSON.stringify(log)+",'a') as f:f.write(json.dumps(args)+'\\n')",
      "reply=subprocess.run([cli]+args,capture_output=True)",
      "if args[:3]==['session','rounds',"+JSON.stringify(owner)+"] and '--cursor' not in args and '--through-round' not in args and not pathlib.Path("+JSON.stringify(raceOnce)+").exists():",
      " before=json.loads(reply.stdout)['data']['page']",
      " if before.get('nextCursor'):",
      "  pathlib.Path("+JSON.stringify(raceOnce)+").touch()",
      "  pathlib.Path("+JSON.stringify(childRelease)+").touch()",
      "  stop=time.monotonic()+10",
      "  while time.monotonic()<stop:",
      "   state=subprocess.run([cli,'session','get',"+JSON.stringify(owner)+"],capture_output=True,check=True)",
      "   summary=json.loads(state.stdout)['data']['summary']",
      "   if summary['status']=='idle' and not (summary.get('inputSummary') or {}).get('pendingMessageIds'):break",
      "   time.sleep(.01)",
      "  after=json.loads(subprocess.run([cli]+args,capture_output=True,check=True).stdout)['data']['page']",
      "  pathlib.Path("+JSON.stringify(raceProof)+").write_text(json.dumps({'before':before['source'],'after':after['source'],'idle':summary['status']=='idle'}))",
      "sys.stdout.buffer.write(reply.stdout)","sys.stderr.buffer.write(reply.stderr)","sys.exit(reply.returncode)",""].join("\n"));
    const concurrent=facts();
    const progress=JSON.parse(readFileSync(raceProof,"utf8"));
    t.assertions.assert(progress.idle&&progress.before.digest!==progress.after.digest,"real same-Round progress did not change the native source between pages");
    t.assertions.assert(concurrent.issues.length===0&&concurrent.evidenceCoverage.nativeComplete===true,
      "ordinary running-Round completion discarded coherent native history: "+JSON.stringify(concurrent.issues));
    const captured=JSON.parse(readFileSync(ownerCache,"utf8"));
    t.assertions.assert(captured.historyCoverage.roundsComplete===true&&historyIds.every(id=>captured.rounds.filter((x:any)=>x.roundId===id).length===1)
      &&captured.rounds.filter((x:any)=>x.roundId===activeRound.roundId).length===1,
      "bounded completed history or fresh active Round was lost or duplicated");
    const person=concurrent.taskTrees.flatMap((x:any)=>x.sessions).find((x:any)=>x.sessionId===owner);
    t.assertions.assert(person?.readable===true&&person.runs.some((x:any)=>
      x.startAtMs<=activeRound.startedAtMs&&x.endAtMs===concurrent.window.endAtMs),
      "coherent history discarded actual current execution from task Agent time");
    t.note("Genuine pagination progress: "+progress.before.digest+" -> "+progress.after.digest+"; 101 completed Rounds and current execution retained");
    writeFileSync(proxy,transparent);
    await idle(owner);const completed=facts();
    const refreshed=JSON.parse(readFileSync(ownerCache,"utf8"));
    t.assertions.assert(completed.issues.length===0&&refreshed.rounds.some((x:any)=>x.roundId===activeRound.roundId&&x.endedAtMs),
      "next fresh observation reused a stale running Round");
    // A real native read failure must stay unknown even with a healthy cache.
    // Delete only this case's own idle Session through its public action.
    await r.client.call({type:"session.delete",payload:{sessionId:owner}});
    const unavailable=facts();const issue=unavailable.issues.find((x:any)=>x.kind==="native-read-unavailable"&&x.sessionId===owner);
    t.assertions.assert(unavailable.evidenceCoverage.nativeComplete===false&&!unavailable.turns.some((x:any)=>x.sessionId===owner),"failed fresh native read reused cached healthy history");
    t.assertions.assert(issue?.errorCode==="targetNotFound"&&Number.isFinite(issue.captureBudgetRemainingMs)&&issue.captureBudgetRemainingMs>=0&&issue.captureBudgetRemainingMs<=100000,
      "native refusal code and remaining capture budget were lost behind an exception type");
    t.note("Actual isolated SDK sessions and transparent native CLI; cache requested-range checkpoint only, full native history is genuine. No live Team writes or official-score claim.");
  } finally {await r.dispose();}
});

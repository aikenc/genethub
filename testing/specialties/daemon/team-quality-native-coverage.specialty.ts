import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-native-coverage",
  title: "A ledger observation gap cannot invalidate independently read native executions",
  oracle: "Real system inputs execute a no-op and two note commands around a real event-file filesystem fault. Native turns/inputs remain covered; the missing ledger mutation remains unknown, independent bounded no-op and later genuine change remain known. An explicitly restored unknown failure retains conservative lifecycle coverage.",
  catches: ["one ledger failure erases every evidence domain", "missing ledger mutation scored as idle", "old gap invalidates all later positive work", "unknown legacy event failure ignored"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py note", "tools/run.py quality facts", "session.send", "session.inspect"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "native-coverage", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config=join(r.root,".genethub/open.env");
    writeFileSync(config, readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\nTEAM_NOTE_QUIET=999999\n");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{
      const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;
    },30000);
    let sequence=0;
    const invoke=async(sid:string,argv:string[],system=false)=>{
      const requestId="native-coverage."+(++sequence),text=JSON.stringify({argv,cwd:r.root,requestId});
      if(system){
        const sent=await runGenetAsync(r.daemon.genet,["session","send",sid,text,"--system","--message-id",requestId,"--no-wait"],r.env);
        t.assertions.assert(sent.code===0,"public system input rejected");
      }else await r.send(sid,text);
      await idle(sid);
      const last=(await r.snapshot(sid)).items.filter(x=>{
        if(x.type!=="assistantMessage")return false;
        try{return JSON.parse(x.text).requestId===requestId;}catch{return false;}
      }).at(-1);
      if(last?.type!=="assistantMessage")throw new Error("actual command reply missing");
      const result=JSON.parse(last.text);t.assertions.assert(result.code===0,result.out+result.err);
      return {result,messageId:requestId};
    };
    const command=(sid:string,args:string[],system=false)=>invoke(sid,[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),...args],system);
    const front=await r.create("ctl-cli-command");
    const created=await command(front,["task","start","--space","leader","--desc","native evidence coverage","--request-id","coverage.task","Observe independent evidence"]);
    const owner=JSON.parse(created.result.out).owner.sessionId as string;await idle(owner);
    r.ok(["snapshot","--refresh-platform"]);r.ok(["tick"]);
    const clean=await invoke(owner,[process.env.GENEHUB_PYTHON!,"-c","print('bounded no-op')"],true);
    r.ok(["tick"]);
    const eventFile=r.state("events","events.jsonl"),saved=eventFile+".before-fault";
    renameSync(eventFile,saved);mkdirSync(eventFile);
    let failedMutation: Awaited<ReturnType<typeof command>>;
    try {
      failedMutation=await command(owner,["note","--kind","idea","--quote","independent evidence","--context","real filesystem append fault","Keep the actual note"],true);
    } finally {rmdirSync(eventFile);renameSync(saved,eventFile);}
    const failureFiles=readdirSync(r.state("events","failures"));
    t.assertions.assert(failureFiles.length>0&&failureFiles.every(f=>JSON.parse(readFileSync(r.state("events","failures",f),"utf8")).kind==="ledger-changed"),"fixture failed a different evidence source");
    t.assertions.assert(readdirSync(r.state("notes")).some(f=>readFileSync(r.state("notes",f),"utf8").includes("Keep the actual note")),"business note disappeared with its optional event");
    r.ok(["tick"]);
    const goodMutation=await command(owner,["note","--kind","idea","--quote","independent evidence","--context","real later ledger change","Keep a later note"],true);
    r.ok(["tick"]);
    const facts=JSON.parse(r.ok(["quality","facts"]));
    t.assertions.assert(facts.issues.length===0&&facts.coverage.turns===true&&facts.coverage.inputs===true&&facts.coverage.dispatches===true,
      "a ledger-only event failure invalidated independently read native turns, inputs or dispatch receipts");
    const wake=(id:string)=>facts.wakes.find((x:any)=>x.messageId===id);
    t.assertions.assert(wake(clean.messageId)?.ledgerChanged===false,"an unrelated later gap erased bounded native no-op evidence");
    t.assertions.assert(wake(failedMutation!.messageId)?.ledgerChanged===null,"missing actual ledger mutation became an idle wake");
    t.assertions.assert(wake(goodMutation.messageId)?.ledgerChanged===true,"a past unrelated gap erased a later real ledger change");
    t.assertions.assert(facts.evidenceCoverageBasis==="per-source-failure-domain/1"&&facts.evidenceCoverage?.ledgerGapTimes?.length>0,
      "new evidence coverage basis or preserved failure gap missing");
    const file=join(r.root,"external-coverage-facts.json");writeFileSync(file,JSON.stringify(facts));
    const card=JSON.parse(r.ok(["quality","card","--snapshot",file]));
    t.assertions.assert(card.measurementVersion==="tq/2+dispatch-resource-obligation/2+per-source-failure-domain/1"&&card.streakCompatibilityKey===card.measurementVersion,
      "changed coverage was stitched to an old measurement");
    const unknownFailure=r.state("events","failures",Date.now()+"-restored-unknown");
    writeFileSync(unknownFailure,JSON.stringify({kind:"legacy-unclassified",error:"explicit-restored-unknown-failure"}));
    const unknown=JSON.parse(r.ok(["quality","facts"]));
    t.assertions.assert(unknown.coverage.dispatches===false&&unknown.coverage.turns===true&&unknown.coverage.inputs===true,
      "unknown legacy failure was ignored or independent native evidence was erased");
    const bad=structuredClone(facts);bad.evidenceCoverageBasis="unknown-basis";writeFileSync(file,JSON.stringify(bad));
    t.assertions.assert(r.command(["quality","card","--snapshot",file]).code!==0,"unknown evidence basis silently accepted");
    t.note("Actual native system commands and filesystem append fault; independent evidence retained, exact missing mutation remains unknown. Restored legacy marker explicitly labelled; no live Team or formal-card claim.");
  } finally {await r.dispose();}
});

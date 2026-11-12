import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-history-cache",
  title: "Complete unchanged native history survives horizon and guest-patch checkpoints without repeated full reads",
  oracle: "Real native Task/Owner histories are read through the public collector. A transparent CLI forwarder records actual calls. Labelled cache-only horizon and prior guest-version checkpoints cannot force complete stable histories to be re-inspected; foreign or missing machine identity, legacy completeness gaps and new genuine inputs require fresh histories. Native histories are never fabricated; the version checkpoint is not an actual guest upgrade claim.",
  catches: ["live cache narrows the hourly history horizon", "guest patch rereads all closed histories and exhausts capture budget", "foreign machine history is reused", "legacy incomplete history is trusted", "new native inputs reuse stale history"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py quality facts", "session.get", "session.inspect", "session.rounds", "session.narrative"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r=await openTeam(t,"history-cache",[{id:"ctl-cli-command",profile:"cli-command"}]);
  try {
    const config=join(r.root,".genethub/open.env");
    writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_BOARD_PORT=0\n");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;},30000);
    const caller=await r.create("ctl-cli-command");
    await r.send(caller,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),"task","start","--space","leader","--desc","bounded history capture","--request-id","history.goal","Assess one bounded goal"],cwd:r.root,requestId:"history.start"}));await idle(caller);
    const receipt=(await r.snapshot(caller)).items.filter(x=>x.type==="assistantMessage"&&x.text.includes('"history.start"')).at(-1);
    if(receipt?.type!=="assistantMessage")throw Error("real task receipt missing");
    const started=JSON.parse(receipt.text);t.assertions.assert(started.code===0,started.err);
    const task=JSON.parse(started.out.trim().split("\n").at(-1)!);const owner=task.owner.sessionId as string;await idle(owner);
    const log=join(t.env.root,"actual-cli-calls.jsonl"),proxy=join(t.env.root,"forward-native-cli.py");
    writeFileSync(log,"");
    writeFileSync(proxy,`#!${process.env.GENEHUB_PYTHON}\nimport os,sys,json\nwith open(${JSON.stringify(log)},'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\nos.execv(${JSON.stringify(r.daemon.genet)},[${JSON.stringify(r.daemon.genet)}]+sys.argv[1:])\n`);chmodSync(proxy,0o700);
    const facts=()=>JSON.parse(r.ok(["quality","facts"],{GENEHUB_CLI:proxy}));
    const calls=()=>readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x) as string[]);
    const heavy=()=>calls().filter(x=>x[0]==="session"&&["inspect","rounds","narrative"].includes(x[1]));
    const first=facts();t.assertions.assert(first.issues.length===0&&heavy().some(x=>x[2]===owner),"first capture did not read actual native history");
    const native=r.state("quality","native");
    // Explicit restored cache checkpoint: only its requested horizon changes.
    // All original native history, identities and timestamps remain byte values
    // from the genuine first capture. This is not a historical execution claim.
    const narrow=()=>{for(const f of readdirSync(native)){const p=join(native,f),v=JSON.parse(readFileSync(p,"utf8"));v.sinceAtMs=first.window.endAtMs;writeFileSync(p,JSON.stringify(v));}};
    narrow();writeFileSync(log,"");const second=facts();
    t.assertions.assert(second.issues.length===0&&heavy().length===0&&calls().some(x=>x[0]==="session"&&x[1]==="get"&&x[2]===owner),
      "unchanged complete native history was reread after a narrower live checkpoint, consuming the hourly budget");
    const ownerCache=readdirSync(native).map(f=>join(native,f)).find(p=>JSON.parse(readFileSync(p,"utf8")).sessionId===owner);
    if(!ownerCache)throw Error("actual Owner cache missing");
    const checkpoint=JSON.parse(readFileSync(ownerCache,"utf8"));
    t.assertions.assert(checkpoint.historyCoverage?.roundsComplete===true&&checkpoint.historyCoverage?.narrativeComplete===true,"actual Owner history must be fully paged");
    // Explicit cache metadata fixture, not a fabricated native upgrade. All
    // original rounds, inputs, timestamps and machine identity stay unchanged.
    const oldPatch={...checkpoint,kernel:{...checkpoint.kernel,version:"prior-guest-patch-checkpoint"}};
    writeFileSync(ownerCache,JSON.stringify(oldPatch));writeFileSync(log,"");const patched=facts();
    t.assertions.assert(patched.issues.length===0&&!heavy().some(x=>x[2]===owner)&&calls().some(x=>x[0]==="session"&&x[1]==="get"&&x[2]===owner),
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
    writeFileSync(log,"");const before=legacy.turns.filter((x:any)=>x.sessionId===owner).length;
    await r.send(owner,"A new genuine input must be included in the next observation");await idle(owner);
    const changed=facts();
    t.assertions.assert(changed.issues.length===0&&heavy().some(x=>x[2]===owner)&&changed.turns.filter((x:any)=>x.sessionId===owner).length>before,
      "fresh native input reused stale cached turns");
    t.note("Actual isolated SDK sessions and transparent native CLI; cache requested-range checkpoint only, full native history is genuine. No live Team writes or official-score claim.");
  } finally {await r.dispose();}
});

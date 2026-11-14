import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

async function prefixHash(file: string, bytes: number): Promise<string> {
  const hash=createHash("sha256");
  for await (const part of createReadStream(file,{start:0,end:bytes-1})) hash.update(part);
  return hash.digest("hex");
}

defineSpecialty({
  id:"specialty.daemon.team-quality-event-history",
  title:"Large append history does not permanently stop native quality capture",
  oracle:"A genuine native Task confirmation remains exactly once through public quality facts after more than64MiB of exact append-crash duplicate bytes. Old diagnostic encoding rows are bounded out of the current observation window; source bytes stay intact and an oversized or corrupt history record still refuses capture.",
  catches:["raw append size permanently invalidates current measurement","duplicates multiply real work","old diagnostic observations exhaust retained memory","streaming deletes original evidence","oversized or corrupt records become healthy evidence"],
  tags:["core","team-quality"],llm:{default:"none"},
  requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
  requirements:[{kind:"python",env:"GENEHUB_PYTHON",minVersion:[3,7],modules:[]}],
  resources:{environments:1,cpu:2,memoryMb:1024,io:1,browser:0},expectedDurationMs:25000,timeoutMs:180000,
  surfaces:["daemon","team-template","filesystem"],productInterfaces:["tools/run.py task start","tools/run.py quality facts","session.send","session.get"],
},async t=>{
  const r=await openTeam(t,"event-history",[{id:"ctl-cli-command",profile:"cli-command"}]);
  try{
    const caller=await r.create("ctl-cli-command");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{
      const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;
    },30000);
    await r.send(caller,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),"task","start","--space","leader","--desc","large history retains native evidence","--request-id","history.goal","Inspect a bounded goal"],cwd:r.root,requestId:"history.start"}));
    await idle(caller);
    const reply=(await r.snapshot(caller)).items.filter(x=>x.type==="assistantMessage"&&x.text.includes('"history.start"')).at(-1);
    if(reply?.type!=="assistantMessage")throw Error("actual task receipt missing");
    const receipt=JSON.parse(reply.text);t.assertions.assert(receipt.code===0,"native task did not start");
    const task=JSON.parse(receipt.out.trim().split("\n").at(-1)!);await idle(task.owner.sessionId);
    const baseline=JSON.parse(r.ok(["quality","facts"]));
    const original=baseline.workItems.find((x:any)=>x.sessionId===task.owner.sessionId);
    t.assertions.assert(typeof original?.confirmedAtMs==="number","native confirmation unavailable before history fault");
    const file=r.state("events","events.jsonl"),lines=readFileSync(file,"utf8").trim().split("\n");
    const native=lines.find(line=>JSON.parse(line).kind==="dispatch-confirmed");
    if(!native)throw Error("public Task did not create its append record");
    // Exact duplicate native bytes model interrupted append/unlink recovery.
    // These are not additional native executions or invented timestamps.
    const chunk=(native+"\n").repeat(2048);
    while(statSync(file).size<=65*1024*1024)appendFileSync(file,chunk);
    const bytes=statSync(file).size,before=await prefixHash(file,bytes);
    const current=JSON.parse(r.ok(["quality","facts"]));
    t.assertions.assert(current.captureKind==="diagnostic"&&current.evidenceCoverage.lifecycleEventsComplete===true
      &&current.workItems.filter((x:any)=>x.sessionId===task.owner.sessionId).length===1
      &&current.workItems.find((x:any)=>x.sessionId===task.owner.sessionId).confirmedAtMs===original.confirmedAtMs,
      "large append history lost or duplicated the original native confirmation");
    t.assertions.assert(await prefixHash(file,bytes)===before,"reader rewrote original event history");
    // Explicit persistent-format fixture, not observed Agent work: diagnostic
    // observations older than48h have no current-window negative evidence.
    const now=Date.now(),old=now-48*3600000;
    for(let n=0;n<128;n++){
      const archived=Array.from({length:2000},(_,i)=>JSON.stringify({schema:"team-process-event/1",eventId:createHash("sha256").update("archived-observation-"+n+"-"+i).digest("hex"),kind:i%2?"session-observed":"ledger-changed",atMs:old,recordedAtMs:old,basis:"task-and-note-ledger/1",diagnosticFixture:true})+"\n").join("");
      appendFileSync(file,archived);
    }
    const selected=JSON.parse(r.ok(["quality","facts"]));
    t.assertions.assert(selected.workItems.find((x:any)=>x.sessionId===task.owner.sessionId).confirmedAtMs===original.confirmedAtMs,
      "old diagnostic encoding hid the actual current receipt");
    appendFileSync(file," ".repeat(8193)+"\n");
    t.assertions.assert(r.command(["quality","facts"]).code!==0,"oversized history record bypassed the bounded reader");
    // A large unique current selection still fails the original memory cap;
    // streaming must not turn bounded capture into an unbounded collector.
    writeFileSync(file,"");
    for(let n=0;statSync(file).size<=65*1024*1024;n++){
      const selectedChunk=Array.from({length:2000},(_,i)=>JSON.stringify({schema:"team-process-event/1",eventId:createHash("sha256").update("current-observation-"+n+"-"+i).digest("hex"),kind:"ledger-observed",atMs:now,recordedAtMs:now,basis:"task-and-note-ledger/1",diagnosticFixture:true})+"\n").join("");
      appendFileSync(file,selectedChunk);
    }
    t.assertions.assert(statSync(file).size>64*1024*1024&&r.command(["quality","facts"]).code!==0,"unique selected history bypassed the retained memory cap");
    writeFileSync(file,"{broken\n");
    t.assertions.assert(r.command(["quality","facts"]).code!==0,"corrupt history became healthy evidence");
    t.note("Actual native Task plus exact duplicate append-crash bytes; separately labelled archived encoding fixture. Diagnostic capture only, no natural-card or historical execution claim.");
  }finally{await r.dispose();}
});

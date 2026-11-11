import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-settlement-notice",
  title: "Unverifiable legacy delivery of a real failure wakes its original Owner with one status contract",
  oracle: "A genuine SDK failure plus explicitly restored unknown legacy delivery cannot replay a business result. After normal publication remains unresolved, the idle original Owner gets one stable native status signal, discovers truthful non-success settlement, and can conclude while original failed input, delivery debt and child remain unchanged.",
  catches: ["old failure silently stalls an in-flight Owner after compatible upgrade", "status notice replays an unverifiable business result", "status notice fabricates support completion or resumes failure", "repeated timers spam the same capability", "non-success capability is invisible"],
  tags: ["core", "team-result"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.get", "session.inspect"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const r=await openTeam(t,"settlement-notice",[{id:"ctl-cli-command",profile:"cli-command"},{id:"ctl-failure",profile:"coded-failure",failureCode:"upstream"}]);
  try {
    const config=join(r.root,".genethub/open.env");
    writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WAKE_GAP=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;},30000);
    let seq=0;
    const cli=async(sid:string,args:string[])=>{
      const requestId="settlement-notice."+(++seq);
      await r.send(sid,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),...args],cwd:r.root,requestId}));await idle(sid);
      const last=(await r.snapshot(sid)).items.filter(x=>{if(x.type!=="assistantMessage")return false;try{return JSON.parse(x.text).requestId===requestId;}catch{return false;}}).at(-1);
      if(last?.type!=="assistantMessage")throw Error("actual native command receipt missing");
      const v=JSON.parse(last.text);t.assertions.assert(v.code===0,v.out+v.err);return JSON.parse(v.out.trim().split("\n").at(-1)!);
    };
    const front=await r.create("ctl-cli-command");
    const task=await cli(front,["task","start","--space","leader","--desc","legacy failure debt","--request-id","legacy.goal","Assess an external failure without discarding unknown delivery"]);
    const owner=task.owner.sessionId as string;await idle(owner);
    writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-failure\n");
    const support=await cli(owner,["task","support",task.taskId,"--space","qa","--desc","genuine failing support","--request-id","legacy.support","Run the bounded external check"]);
    const child=support.collaborator as string;
    await t.tools.waitUntil(async()=>(await r.snapshot(child)).summary.status==="failed",20000);
    const original=(await r.snapshot(child)).summary.inputSummary;
    t.assertions.assert(original?.paused&&original.pendingMessageIds.length>0,"native failure did not retain input");
    writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\n");
    const live=await cli(owner,["task","support",task.taskId,"--space","qa","--desc","independent unfinished writer","--request-id","parallel.writer","Keep this original independent writer obligation"]);
    await idle(live.collaborator);
    const dir=join(r.root,"independent-writer");mkdirSync(dir);
    await cli(live.collaborator,["task","bind-directory",task.taskId,"--directory",dir]);
    await r.client.call({type:"session.interrupt",payload:{sessionId:live.collaborator}});
    const writer=JSON.parse(readFileSync(r.state("pending",live.collaborator+".json"),"utf8"));
    t.assertions.assert(existsSync(writer.lock)&&(await r.snapshot(live.collaborator)).summary.inputSummary?.paused,"real independent paused writer missing");
    // Explicit legacy checkpoint fault, not a claim that a send really succeeded.
    // The failure, task and all Session identities remain genuine and untouched.
    const path=r.state("pending",child+".json"),pending=JSON.parse(readFileSync(path,"utf8"));
    const legacy={key:"unknown-prior-hash",state:"queued",to:owner,transport:"queue",resultHash:"0".repeat(64),atMs:Date.now()};
    pending.resultDelivery=legacy;writeFileSync(path,JSON.stringify(pending));
    r.ok(["tick"]);await idle(owner);r.ok(["tick"]);await idle(owner);
    const saved=JSON.parse(readFileSync(path,"utf8"));
    const signals=async()=>(await r.snapshot(owner)).items.filter(x=>x.type==="userMessage"&&x.text.startsWith("用途: status\n")&&x.text.includes("task-settlement/2"));
    t.assertions.assert((await signals()).length===1,"unresolved native failure never surfaced the new settlement capability while another support remained unfinished");
    const first=(await signals())[0].id;
    t.assertions.assert(saved.done?.outcome==="failed"&&JSON.stringify(saved.resultDelivery)===JSON.stringify(legacy),"status notice rewrote the legacy result obligation");
    const status=await cli(owner,["task","status",task.taskId]);
    t.assertions.assert(status.conclusionPolicy?.version==="task-settlement/2"&&status.conclusionPolicy.nonSuccessPreservesUnresolvedSupports===true,
      "public status did not expose the actual non-success contract");
    r.ok(["tick"]);await idle(owner);
    t.assertions.assert((await signals()).length===1&&(await signals())[0].id===first,"repeat tick duplicated the status signal");
    const childAfter=(await r.snapshot(child)).summary.inputSummary;
    t.assertions.assert(childAfter?.paused&&JSON.stringify(childAfter.pendingMessageIds)===JSON.stringify(original.pendingMessageIds),"status notification resumed or discarded the original failure");
    const results=(await r.snapshot(owner)).items.filter(x=>x.type==="userMessage"&&x.text.startsWith("用途: result\n"));
    t.assertions.assert(results.length===0,"unverifiable prior result was silently replayed");
    await cli(owner,["task","finish",task.taskId,"--outcome","failed","External failure prevented acceptance; legacy delivery and original child preserved"]);
    const ended=JSON.parse(readFileSync(r.state("tasks",task.taskId+".json"),"utf8"));
    t.assertions.assert(ended.finished?.outcome==="failed"&&ended.finished.unresolvedWork.pending.some((x:any)=>x.sessionId===child),"honest non-success lost its unresolved support");
    t.assertions.assert(existsSync(path)&&JSON.stringify(JSON.parse(readFileSync(path,"utf8")).resultDelivery)===JSON.stringify(legacy),"parent conclusion removed the original unknown delivery");
    t.assertions.assert(existsSync(writer.lock)&&(await r.snapshot(live.collaborator)).summary.inputSummary?.paused,"status or non-success conclusion released/resumed independent unfinished work");
    t.note("Actual SDK failed execution, native Owner status input and public non-success conclusion; only unknown legacy delivery metadata explicitly restored. No live experimental Team write or fake result acceptance.");
  } finally {await r.dispose();}
});

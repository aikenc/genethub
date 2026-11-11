import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, readScriptAgentJournal, registerControlledAgent } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-managed-runtime",
  title: "Managed CLI runtime PIDs stay alive while actual background work still guards the writer lease",
  oracle: "An actual external SDK Agent declares two real runtime children plus its unowned SDK ancestor. Public native inventory omits only the exact runtime PIDs, keeps their actual work grandchild, and retains a real bound writer until that child exits naturally. Clearing metadata restores legacy visibility; native cleanup still owns the entire tree.",
  catches: ["runtime PID blocks every finished writer", "runtime declaration hides a whole work subtree", "legacy caller inherits stale exclusions", "foreign PID becomes owned", "idle runtime exclusion kills the runtime"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["agent-serve-protocol-1 session.pid", "process.list", "tools/run.py task", "tools/run.py tick"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const marker=join(t.env.root,"actual-work-may-exit");
  const subject=registerControlledAgent(t.env,{id:"ctl-managed-runtime",profile:"cli-command",processTree:true,
    tool:"actual-runtime-tree",managedRuntimePids:true,runtimeWorkExitFile:marker});
  const r=await openTeam(t,"managed-runtime",[{id:"ctl-cli-command",profile:"cli-command"}]);
  try {
    const config=join(r.root,".genethub/open.env");
    writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-managed-runtime\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{
      const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;
    },30000);
    let sequence=0;
    const invoke=async(sid:string,args:string[],runtimeAction?:string)=>{
      const requestId="managed-runtime."+(++sequence);
      await r.send(sid,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),...args],cwd:r.root,requestId,runtimeAction}));
      await idle(sid);
      const last=(await r.snapshot(sid)).items.filter(x=>{
        if(x.type!=="assistantMessage")return false;
        try{return JSON.parse(x.text).requestId===requestId;}catch{return false;}
      }).at(-1);
      if(last?.type!=="assistantMessage")throw new Error("actual command result missing");
      const v=JSON.parse(last.text);t.assertions.assert(v.code===0,v.out+v.err);return JSON.parse(v.out.trim().split("\n").at(-1)!);
    };
    const front=await r.create("ctl-cli-command");
    const task=await invoke(front,["task","start","--space","leader","--desc","runtime work distinction","--request-id","runtime.goal","Conclude a bounded native process check"]);
    const owner=task.owner.sessionId as string;await idle(owner);
    const tree=readScriptAgentJournal(subject).find(x=>x.event==="tree-created");
    if(!tree)throw new Error("actual external SDK process tree absent");
    const root=Number(tree.rootPid),leaf=Number(tree.leafPid),sibling=Number(tree.siblingPid),foreign=Number(tree.pid);
    const inventory=async()=>{
      const p=await r.client.call({type:"process.list"});if(p?.type!=="processes")throw new Error("native process inventory missing");return p.data.filter(x=>x.sessionId===owner);
    };
    await t.tools.waitUntil(async()=>{const p=await inventory();return p.some(x=>x.pid===leaf)&&!p.some(x=>x.pid===root||x.pid===sibling);},15000);
    for(const pid of [root,sibling,foreign])process.kill(pid,0); // Read-only OS liveness, never a signal.
    const directory=join(r.root,"bound-writer");mkdirSync(directory);
    await invoke(owner,["task","bind-directory",task.taskId,"--directory",directory]);
    await invoke(owner,["task","finish",task.taskId,"--outcome","success","Native work result declared"]);
    r.ok(["tick"]);
    const intentFile=readdirSync(r.state("task-dispatch")).find(f=>JSON.parse(readFileSync(r.state("task-dispatch",f),"utf8")).sessionId===owner)!;
    const intent=()=>JSON.parse(readFileSync(r.state("task-dispatch",intentFile),"utf8"));
    const pending=JSON.parse(readFileSync(r.state("pending",owner+".json"),"utf8"));
    t.assertions.assert(existsSync(pending.lock)&&intent().resourceReleased!==true,"managed runtime declaration released a writer with genuine live work");
    await invoke(owner,["task","status",task.taskId],"clear");
    await t.tools.waitUntil(async()=>{const p=await inventory();return [root,leaf,sibling].every(pid=>p.some(x=>x.pid===pid));},15000);
    await invoke(owner,["task","status",task.taskId],"declare");
    await t.tools.waitUntil(async()=>{const p=await inventory();return p.some(x=>x.pid===leaf)&&!p.some(x=>x.pid===root||x.pid===sibling);},15000);
    writeFileSync(marker,"actual work may finish naturally\n");
    await t.tools.waitUntil(async()=>(await inventory()).length===0,15000);
    const ended=Date.now();r.ok(["tick"]);
    t.assertions.assert(intent().resourceReleased===true&&!existsSync(pending.lock)&&Date.now()-ended<60000,
      "idle managed runtimes prevented native resource return after actual work ended");
    for(const pid of [root,sibling,foreign])process.kill(pid,0);
    t.note("Actual SDK/native OS/runtime/lease transitions; work grandchild retained until natural exit; exact runtimes alive and unowned ancestor not claimed. No live Team mutation or process termination.");
  } finally {await r.dispose();}
});

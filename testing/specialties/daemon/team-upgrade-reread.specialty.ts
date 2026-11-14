import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-upgrade-reread-notices",
  title: "Verified adoption reaches the front and paused Owner once without resuming their work",
  oracle: "Real public upgrade retains Task and paused native input state, sends one version-specific reread notice to the front, queues one for the original Owner, and delivers it after explicit recovery. Cached upgrade and timer replay cannot duplicate either native input or rewrite original work.",
  catches: ["installed rules never reach active roles", "upgrade silently unpauses Owner", "cached adoption loses reread notice", "same version repeatedly wakes front", "new reminder rewrites Task"],
  tags: ["core", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py upgrade", "tools/run.py task", "tools/run.py hook", "session.send", "session.interrupt", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 35000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "adoption-reread", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const platform = join(t.env.root, "reread-platform"); cpSync(r.template, platform, { recursive: true });
    const marker = "docs/reread-version.txt";
    for (const root of [platform, r.root]) { mkdirSync(join(root,"docs"),{recursive:true}); writeFileSync(join(root,marker),"baseline\n"); }
    const config = join(r.root,".genethub/open.env");
    writeFileSync(config,readFileSync(config,"utf8")+`\nTEAM_TEMPLATE=${platform}\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WAKE_GAP=999999\n`);
    // Establish the real platform ancestor before task start snapshots local work.
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const front = await r.create("ctl-cli-command");
    await r.send(front,JSON.stringify({requestId:"reread.original",cwd:r.root,argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),"task","start","--space","leader","--desc","Original ongoing goal","--request-id","reread.original","Keep this original goal and its results"]}));
    let started:any;
    await t.tools.waitUntil(async()=>{
      const view=await r.snapshot(front);const reply=view.items.findLast(x=>x.type==="assistantMessage"&&x.text.includes('"reread.original"'));
      if(reply?.type==="assistantMessage"){const result=JSON.parse(reply.text);t.assertions.assert(result.code===0,"native front could not start original Task: "+result.err);started=JSON.parse(result.out);}
      return view.summary.status==="idle"&&Boolean(started);
    },20000);
    const owner=started.owner.sessionId;
    await t.tools.waitUntil(async()=>(await r.snapshot(owner)).summary.status==="idle",20000);
    await r.client.call({type:"session.interrupt",payload:{sessionId:owner}});
    const paused=(await r.snapshot(owner)).summary.inputSummary;
    t.assertions.assert(paused?.paused===true,"original Owner pause fixture was not native");
    const taskPath=r.state("tasks",started.taskId+".json"),originalTask=readFileSync(taskPath);
    r.ok(["snapshot"]);
    writeFileSync(join(platform,marker),"new-rules\n");
    const execute=(args:string[])=>{
      const result=spawnSync(process.env.GENEHUB_PYTHON!,[join(r.root,"tools/run.py"),...args],{cwd:r.root,env:{...r.env,TEAM_TEMPLATE:platform},encoding:"utf8",timeout:30000});
      t.assertions.assert(result.status===0,result.stdout+result.stderr);return JSON.parse(result.stdout);
    };
    execute(["upgrade"]);let adopted:any;
    try { await t.tools.waitUntil(async()=>{adopted=execute(["upgrade","--status"]);if(!adopted.workerPid&&["conflict","test-failure"].includes(adopted.status))t.assertions.assert(false,"adoption fixture failed before notice check: "+JSON.stringify(adopted));return !adopted.workerPid&&adopted.status==="adopted";},90000); } catch(error) { throw new Error("adoption fixture did not settle: "+JSON.stringify(adopted)+"; "+String(error)); }
    const rereads=(view:Awaited<ReturnType<typeof r.snapshot>>)=>view.items.filter(x=>x.type==="userMessage"&&x.text.includes("采用后重读")&&x.text.includes(adopted.target));
    await t.tools.waitUntil(async()=>rereads(await r.snapshot(front)).length===1,10000);
    const originalNotice=rereads(await r.snapshot(front))[0].id;
    const queued=()=>existsSync(r.state("inbox",owner+".jsonl"))?readFileSync(r.state("inbox",owner+".jsonl"),"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x)):[];
    t.assertions.assert(queued().filter(x=>x.text.includes("采用后重读")&&x.text.includes(adopted.target)).length===1,"verified adoption did not retain one notice for paused original Owner");
    t.assertions.assert(JSON.stringify((await r.snapshot(owner)).summary.inputSummary)===JSON.stringify(paused)&&readFileSync(taskPath).equals(originalTask),"adoption notice resumed original work or rewrote Task");
    execute(["upgrade"]);execute(["upgrade"]);
    t.assertions.assert(rereads(await r.snapshot(front)).length===1&&rereads(await r.snapshot(front))[0].id===originalNotice&&queued().length===1,"cached adoption repeated a reminder");
    await r.send(owner,"Explicitly resume the original session; keep its Task and pending results.");
    await t.tools.waitUntil(async()=>(await r.snapshot(owner)).summary.status==="idle",20000);
    r.ok(["hook"]);
    await t.tools.waitUntil(async()=>rereads(await r.snapshot(owner)).length===1,10000);
    const ownerNotice=rereads(await r.snapshot(owner))[0].id;
    execute(["upgrade"]);r.ok(["hook"]);
    t.assertions.assert(rereads(await r.snapshot(owner)).length===1&&rereads(await r.snapshot(owner))[0].id===ownerNotice&&readFileSync(taskPath).equals(originalTask),"recovery duplicated notice or replaced original Task");
    const notes=existsSync(r.state("notes"))?readdirSync(r.state("notes")):[];
    t.assertions.assert(notes.length===0,"successful adoption created a reflection wake loop");
  } finally { await r.dispose(); }
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-attribution",
  title: "Quality loss attribution identifies automatic template obligations without forgiving their score or guessing missing causes",
  oracle: "Frozen nonproject work through a real compiled Team CLI triggers R1/R3/R5 as three 50-point class charges. Every instance and indicator loss has evidence-bearing attribution, grouped losses conserve the original ledger, absent causal evidence stays unresolved and old snapshots retain their exact canonical result.",
  catches: ["platform losses excluded", "per-instance attribution multiplies class penalty", "unexplained failures blamed on Team", "unknown measurement becomes zero loss", "attribution changes legacy snapshot output"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["spacebuilder.py build", "tools/run.py quality card"],
  surfaces: ["filesystem", "team-template"], requiredArtifacts: [],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0 },
  expectedDurationMs: 7000, timeoutMs: 90000,
}, async t => {
  const refs = path.join(t.openRoot, "apps/daemon/builtin-skills/genehub/references");
  const source = path.join(t.env.root, "definition"), output = path.join(t.env.root, "compiled-team");
  cpSync(path.join(refs, "team-template"), source, { recursive: true });
  const python = process.env.GENEHUB_PYTHON!;
  const env = { PATH: process.env.PATH ?? "", HOME: path.join(t.env.root, "home") }; mkdirSync(env.HOME,{recursive:true});
  const built = spawnSync(python, [path.join(refs,"spacebuilder/spacebuilder.py"),"build",source,"--output",output,"--require-no-post-commands"], {env,encoding:"utf8",timeout:30000});
  t.assertions.assert(built.status===0,"independent actual Team build failed: "+built.stdout+built.stderr);
  const h=3600000,start=Math.floor(1600000000000/h)*h;
  const facts:any={
    schema:"team-quality-facts/1",scoringModel:"tq/2",team:"bounded-attribution-work",
    window:{startAtMs:start,endAtMs:start+h},measurementWindow:{startAtMs:start,endAtMs:start+h},capturedAtMs:start+h+1000,
    versions:{templateAtCapture:"frozen-independent-fixture"},taskTrees:[],taskTreesSourceComplete:true,
    coverage:{dispatches:true,starts:true,deliveries:true,observations:true,goals:true,resources:true,inputs:true,turns:true},
    goalIntervals:[{startAtMs:start,endAtMs:start+h}],measurementGoalIntervals:[{startAtMs:start,endAtMs:start+h}],
    workItems:Array.from({length:20},(_,n)=>({id:"work."+n,taskId:"task.fixed",sessionId:"worker."+n,hasReceipt:true,
      dispatchAtMs:start,confirmedAtMs:start+660000,startedAtMs:start+720000,conclusionAtMs:start+1200000,
      deliveredAtMs:start+2400000,consumedAtMs:start+2461000,requester:"requester",recipient:"requester",
      disposition:n<10?"rework":"adopted-inferred",resourceRequired:true,releasedAtMs:start+2460000,releaseTimeBasis:"verified-release",executionMs:480000})),
    turns:Array.from({length:20},(_,n)=>({turnId:"turn."+n,sessionId:"worker."+n,startedAtMs:start+720000,finishedAtMs:start+1200000,durationMs:480000,outcome:n<4?"failed":"completed",coordination:false})),
    wakes:Array.from({length:20},(_,n)=>({messageId:"wake."+n,sessionId:"requester",atMs:start+1200000+n,ledgerChanged:false})),
    baseline:{executionMsPerAdopted:480000},inputs:[],failures:[],stalls:[],
  };
  const file=path.join(t.env.root,"frozen.json");
  const evaluate=(f:any)=>{writeFileSync(file,JSON.stringify(f));return spawnSync(python,[path.join(output,"tools/run.py"),"quality","card","--snapshot",file],{env,cwd:output,encoding:"utf8",timeout:10000});};
  const card=(f:any)=>{const r=evaluate(f);t.assertions.assert(r.status===0,"public frozen card failed: "+r.stdout+r.stderr);return {text:r.stdout,value:JSON.parse(r.stdout)};};
  const original=card(facts),oldAgain=card(facts);
  t.assertions.assert(original.text===oldAgain.text&&original.value.penalty===150,"baseline class charges or deterministic replay changed");
  const legacyDigest=createHash("sha256").update(original.text).digest("hex");
  // This value is frozen from the pre-change public CLI, not from product internals.
  const expectedLegacy="296760dd174a688a71c8773b70bc7c4fde99eddb9a5939ca0583deca3eca8588";
  t.note("legacy frozen canonical SHA256="+legacyDigest);
  t.assertions.assert(legacyDigest===expectedLegacy,"untagged historical snapshot changed under attribution rollout");
  const attributed=JSON.parse(JSON.stringify(facts));
  attributed.attributionContext={schema:"team-quality-attribution-context/1",dispatch:"builtin-task/1",resultQueue:"template-native-inbox/1",resourceReturn:"template-reconciler/1"};
  const current=card(attributed),v=current.value;
  for(const key of ["R1","R3","R5"]){
    t.assertions.assert(v.redLines[key].instances.length===20&&v.redLines[key].instances.every((i:any)=>i.attribution?.component==="platform-template"&&i.attribution.evidence?.length>0),"automatic "+key+" instance lacks template attribution or evidence; legacy SHA="+legacyDigest);
  }
  t.assertions.assert(v.losses.every((l:any)=>l.attribution&&Array.isArray(l.attribution.evidence)),"an indicator loss or unknown measurement lost attribution");
  const loss=(id:string)=>v.losses.find((x:any)=>x.id===id);
  t.assertions.assert(loss("reworkPct").loss>0&&loss("reworkPct").attribution.component==="team","observed rework responsibility missing");
  t.assertions.assert(loss("failedTurnPct").loss>0&&loss("failedTurnPct").attribution.component==="unresolved","missing native failure cause was guessed or excluded");
  t.assertions.assert(loss("recoveryP90Min").loss===null&&loss("recoveryP90Min").attribution.component==="unresolved","unknown recovery evidence became zero measured loss");
  for(const key of ["base","penalty","score","provisionalScore","formal","possibleRange","metrics"])
    t.assertions.assert(JSON.stringify(v[key])===JSON.stringify(original.value[key]),"adding attribution changed "+key+" or forgiven a platform failure");
  const sum=v.losses.reduce((n:number,l:any)=>n+(l.loss??0),0);
  const grouped=Object.values(v.attribution.lossByComponent).reduce((n:number,x:any)=>n+x,0);
  t.assertions.assert(Math.abs(sum-Number(grouped))<.001&&v.attribution.lossByComponent["platform-template"]>=150,"grouping multiplied instance penalties, lost fractions or excluded template loss");
  t.assertions.assert(current.text===card(attributed).text&&card(facts).text===original.text&&!v.officialCapture,"attribution replay mutated history or manufactured an official card");
  const invalid=JSON.parse(JSON.stringify(attributed));invalid.attributionContext.schema="unknown-context/99";
  t.assertions.assert(evaluate(invalid).status!==0,"unknown attribution provenance was silently accepted");
  t.note("20 each overdue preparation/result/resource obligations remain three class penalties; business rework and missing failure cause separated; all original arithmetic retained; compile-output CLI only, not real-team native evidence.");
});

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-epoch",
  title: "Versioned native-hour cards keep rolling samples and archive historical redlines without manual resolution",
  oracle: "The new hourly-native policy never imports old open incident penalties or legacy epoch cutoffs. A real breach in an hour disqualifies that hour, a continued breach still triggers, and a later resolved hour keeps its rolling24h conclusions. Unknown stays unknown. Frozen old policy facts still replay by their original basis.",
  catches: ["durable redline disappears with the hour", "publication silently clears history", "pre-repair samples enter the new epoch", "insufficient new sample is called formal", "different epochs stitch a streak"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["spacebuilder.py build", "tools/run.py quality card --snapshot", "tools/run.py quality alerts --snapshot"],
  surfaces: ["team-template", "filesystem"], requiredArtifacts: [],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 1, memoryMb: 512, browser: 0 }, expectedDurationMs: 5000, timeoutMs: 60000,
}, async t => {
  const python=process.env.GENEHUB_PYTHON!, refs=join(t.openRoot,"apps/daemon/builtin-skills/genehub/references");
  const source=join(t.env.root,"definition"),root=join(t.env.root,"compiled");
  cpSync(join(refs,"team-template"),source,{recursive:true});
  const env={HOME:join(t.env.root,"home"),PATH:process.env.PATH??""};mkdirSync(env.HOME,{recursive:true});
  const built=spawnSync(python,[join(refs,"spacebuilder/spacebuilder.py"),"build",source,"--output",root,"--require-no-post-commands"],{env,encoding:"utf8",timeout:30000});
  t.assertions.assert(built.status===0,built.stdout+built.stderr);
  const h=3600000,end=Date.UTC(2026,10,12,12),start=end-h;
  const items=(at:number)=>Array.from({length:20},(_,n)=>({id:"work."+n,requester:"parent",hasReceipt:true,standing:false,
    dispatchAtMs:at-60000,confirmedAtMs:at-59999,startedAtMs:at-59998,conclusionAtMs:at,
    deliveredAtMs:at+1,consumedAtMs:at+2,resourceRequired:false,deliveryCoverageKnown:true,disposition:"adopted-inferred",executionMs:1000}));
  const facts:any={schema:"team-quality-facts/1",scoringModel:"tq/2",team:"independent-epoch",
    window:{startAtMs:start,endAtMs:end},measurementWindow:{startAtMs:end-24*h,endAtMs:end},capturedAtMs:end,
    captureKind:"native-hour",versions:{},coverage:{dispatches:true,starts:true,deliveries:true,observations:true,goals:true,resources:true,turns:true,inputs:true},
    workItems:items(end-2*h),taskTrees:[],taskTreesSourceComplete:true,inputs:[],turns:[],wakes:[],failures:[],stalls:[],
    goalIntervals:[{startAtMs:start,endAtMs:end}],measurementGoalIntervals:[{startAtMs:start,endAtMs:end}],baseline:{executionMsPerAdopted:1000}};
  const file=join(t.env.root,"frozen.json");
  const command=(action:string,value:any)=>{
    writeFileSync(file,JSON.stringify(value));const r=spawnSync(python,[join(root,"tools/run.py"),"quality",action,"--snapshot",file],{cwd:root,env,encoding:"utf8",timeout:15000});
    t.assertions.assert(r.status===0,r.stdout+r.stderr);return JSON.parse(r.stdout);
  };
  const legacy=command("card",facts);
  t.assertions.assert(legacy.formal && legacy.score>=80 && !legacy.measurementVersion && legacy.officialCapture===false,
    "frozen independent oracle was not a formal external legacy card");
  const policy={schema:"team-quality-redline-lifecycle/1",policy:"verified-repair-adoption/1",epoch:null,open:[]};
  const incident={id:"incident.delivery",rule:"R3",workItemId:"work.0",firstSeenAtMs:start-1000,status:"open"};
  const debt=command("card",{...facts,redlineLifecycle:{...policy,open:[incident]}});
  t.assertions.assert(debt.disqualified && debt.redLines.R3.triggered && debt.penalty===50 && debt.score<80,
    "an otherwise quiet hour lost its unresolved verified-repair obligation");
  const raw=command("alerts",{...facts,redlineLifecycle:{...policy,open:[incident]}});
  t.assertions.assert(!raw.redLines.length,"live native projection mistook durable debt for a still-open physical symptom");
  const epoch={id:"independent-adoption-a",atMs:end-90*60000,closedIncidentIds:[incident.id]};
  const fresh={...facts,redlineLifecycle:{...policy,epoch},measurementWindow:{startAtMs:epoch.atMs,endAtMs:end}};
  const rem=command("card",fresh);
  t.assertions.assert(!rem.formal && rem.coverage.closedWorkItems===0 && rem.qualificationState==="remeasuring" && rem.notFormalReason.includes("重新测量中"),
    "pre-adoption conclusions manufactured a formal new window");
  const sufficient=command("card",{...fresh,workItems:items(end-20*60000)});
  t.assertions.assert(sufficient.formal && sufficient.score>=80 && !sufficient.disqualified && sufficient.streakCompatibilityKey.includes(epoch.id),
    "sufficient new measurements did not qualify under their actual epoch");
  const next=command("card",{...fresh,workItems:items(end-20*60000),redlineLifecycle:{...policy,epoch:{...epoch,id:"independent-adoption-b"}}});
  t.assertions.assert(next.streakCompatibilityKey!==sufficient.streakCompatibilityKey && legacy.streakCompatibilityKey!==sufficient.streakCompatibilityKey,
    "different adoption epochs or legacy basis could form one streak");
  const nativePolicy = {...policy, policy: "native-hourly-facts/2", open: [incident], epoch};
  const hourly = {...facts, redlineLifecycle: nativePolicy};
  const clean = command("card", hourly);
  t.assertions.assert(clean.formal && clean.score >= 80 && !clean.redLines.R3.triggered && !clean.disqualified
    && clean.coverage.closedWorkItems === 20 && clean.streakCompatibilityKey.endsWith("native-hourly-facts/2")
    && !clean.streakCompatibilityKey.includes(epoch.id), "old incident or epoch penalized a clean new hour or discarded rolling samples");
  const unresolved = {...facts.workItems[0], resourceRequired: true, resourceHeld: true};
  const held = command("card", {...hourly, workItems:[unresolved,...facts.workItems.slice(1)]});
  t.assertions.assert(held.redLines.R5.triggered && held.disqualified && held.penalty === 50,
    "a still-held resource disappeared with the manual closure policy");
  const later = {...hourly, window:{startAtMs:end,endAtMs:end+h}, capturedAtMs:end+h,
    measurementWindow:{startAtMs:end-23*h,endAtMs:end+h}};
  const stillHeld = command("card", {...later,workItems:[unresolved,...facts.workItems.slice(1)]});
  t.assertions.assert(stillHeld.redLines.R5.triggered && stillHeld.disqualified, "a continued actual breach did not trigger naturally next hour");
  const released = command("card", {...later,workItems:[{...unresolved,resourceHeld:false,releasedAtMs:end-1000},...facts.workItems.slice(1)]});
  t.assertions.assert(!released.redLines.R5.triggered && !released.disqualified && released.coverage.closedWorkItems === 20,
    "a resource released before this hour kept a historical penalty or reset rolling samples");
  const noRead = command("card", {...hourly,coverage:{...hourly.coverage,deliveries:false}});
  t.assertions.assert(noRead.redLines.R3.triggered === null && !noRead.formal,
    "unreadable current evidence was replaced by old debt or a fabricated pass");
  t.assertions.assert(command("card",facts).score===legacy.score && command("card",{...facts,redlineLifecycle:{...policy,open:[incident]}}).score===debt.score,
    "new policy rewrote original legacy arithmetic");
  t.note("Independent frozen arithmetic only; new policy and original legacy replay both exercised. Actual automatic closure is a separate native SDK withdrawal/tick canary, not an official quality80 claim.");
});

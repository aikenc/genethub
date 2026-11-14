import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-r6-unit-scope",
  title: "Formal R6 uses the same complete unit for duration and Agent mean, while hourly decline remains visible",
  oracle: "Public Builder/quality CLI projects explicit offline interval sums: 92.56-minute work with 4.094 total parallelism passes despite its 16-minute serial tail; legacy /3 still fails that tail. Long serial work, short exemptions, SID continuation, pauses, background union, unknowns and genuine inactivity remain distinct.",
  catches: ["hourly serial closing stage punishes a successful full unit", "new SID resets the tier", "cumulative upper bound substituted into hourly mean", "unknown execution becomes a pass", "background tools multiply one Agent", "cumulative mean hides an actual R4 stall"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  requiredArtifacts: [], productInterfaces: ["spacebuilder.py build", "tools/run.py quality card"],
  surfaces: ["team-template", "filesystem"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3,7], modules: [] }],
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0 },
  expectedDurationMs: 5000, timeoutMs: 90000,
}, async t => {
  const refs=path.join(t.openRoot,"apps/daemon/builtin-skills/genehub/references");
  const source=path.join(t.env.root,"unit-definition"), output=path.join(t.env.root,"unit-runtime");
  cpSync(path.join(refs,"team-template"),source,{recursive:true});
  const python=process.env.GENEHUB_PYTHON!;
  const env={PATH:process.env.PATH??"",HOME:path.join(t.env.root,"home")};mkdirSync(env.HOME,{recursive:true});
  const build=spawnSync(python,[path.join(refs,"spacebuilder/spacebuilder.py"),"build",source,"--output",output,"--require-no-post-commands"],{env,encoding:"utf8",timeout:30000});
  t.assertions.assert(build.status===0,"public Team build failed: "+build.stderr);
  const h=3600000,minute=60000,start=Math.floor(1700000000000/h)*h,end=start+h;
  const run=(a:number,b:number)=>({startAtMs:a,endAtMs:b});
  const uniform=(duration:number,p:number,stop=end):any=>{
    const opened=stop-duration;
    const unit={taskId:"bounded-root",unitId:"same-complete-unit",boundaryKnown:true,boundaryBasis:"dispatch-acceptance-unit/1",
      operationIds:["repair","integration","verification"],openedAtMs:opened,endedAtMs:stop,excluded:[],
      sessions:Array.from({length:Math.ceil(p)},(_,i)=>({sessionId:"member."+i,readable:true,openedAtMs:opened,
        runs:[run(opened,opened+duration*Math.min(1,p-i))]}))};
    return {schema:"team-quality-facts/1",team:"explicit-offline-unit-fixture",scoringModel:"tq/2",r6Basis:"acceptance-unit-agent-hours/4",
      executionBasis:"registered-native-execution-union/2",acceptanceUnitBasis:"dispatch-acceptance-unit/1",taskTreesSourceComplete:true,
      window:{startAtMs:start,endAtMs:end},measurementWindow:{startAtMs:start-23*h,endAtMs:end},capturedAtMs:end+1000,
      coverage:{dispatches:true,starts:true,deliveries:true,observations:true,goals:true,resources:true,inputs:true,turns:true},
      goalIntervals:[run(start,Math.min(end,stop))],measurementGoalIntervals:[run(opened,stop)],
      taskTrees:[structuredClone(unit)],acceptanceUnits:[unit],workItems:[],turns:[],inputs:[],wakes:[],failures:[],stalls:[]};
  };
  const file=path.join(t.env.root,"unit-facts.json");
  const card=(f:any)=>{
    writeFileSync(file,JSON.stringify(f));
    const r=spawnSync(python,[path.join(output,"tools/run.py"),"quality","card","--snapshot",file],{cwd:output,env,encoding:"utf8",timeout:10000});
    t.assertions.assert(r.status===0,"public unit projection failed for "+f.r6Basis+": "+r.stdout+r.stderr);
    const v=JSON.parse(r.stdout);t.assertions.assert(v.officialCapture===false,"offline algebra became an official native card");
    return {text:r.stdout,value:v,row:v.taskParallelism[0]};
  };
  // Explicit arithmetic projection of the documented R9 counterexample;
  // these are not invented native acceptance-unit facts or observed hours.
  const duration=5553333,tail=960190,agent=22732768,hourAgent=1011524,stop=start+tail,opened=stop-duration;
  const closing=uniform(duration,1,stop),u=closing.acceptanceUnits[0];
  u.sessions=[duration,duration-tail+51334,duration-tail,duration-tail,3348672].map((n,i)=>({sessionId:"R9.algebra."+i,readable:true,runs:[run(opened,opened+n)]}));
  closing.taskTrees=[structuredClone(u)];
  const legacy=structuredClone(closing);legacy.r6Basis="acceptance-unit-agent-hours/3";
  const old=card(legacy);
  t.assertions.assert(old.value.redLines.R6.triggered===true&&Math.abs(old.row.low-hourAgent/tail)<1e-12&&!('totalAgentMs'in old.row),"legacy /3 closing-stage meaning changed");
  const full=card(closing);
  t.assertions.assert(full.row.totalEffectiveMs===duration&&full.row.totalAgentMs===agent&&full.row.agentMs===hourAgent
    &&full.row.hourEffectiveMs===tail&&full.row.required===1.5&&full.row.state==="pass"
    &&Math.abs(full.row.low-agent/duration)<1e-12&&Math.abs(full.row.hourLow-hourAgent/tail)<1e-12
    &&full.row.aggregationScope==="unit-to-card-end/1"&&full.value.redLines.R6.triggered===false,"complete R9 arithmetic still punished its serial tail");
  t.assertions.assert(Math.abs(full.value.effectiveInFlight.knownMean-hourAgent/tail)<1e-12
    &&Math.abs(full.value.effectiveInFlight.possibleMean-hourAgent/tail)<1e-12,"cumulative mean leaked into hourly in-flight bounds");
  t.assertions.assert(card(legacy).text===old.text&&full.value.streakCompatibilityKey!==old.value.streakCompatibilityKey
    &&full.value.streakCompatibilityKey.includes("acceptance-unit-agent-hours/4"),"new scope rewrote or stitched legacy cards");
  const switched=structuredClone(closing);switched.acceptanceUnits[0].sessions.shift();
  switched.acceptanceUnits[0].sessions.push({sessionId:"owner.before",readable:true,runs:[run(opened,start)]},{sessionId:"owner.after",readable:true,openedAtMs:start,runs:[run(start,stop)]});
  const switchedRow=card(switched).row;
  t.assertions.assert(switchedRow.unitId===full.row.unitId&&switchedRow.totalEffectiveMs===duration&&switchedRow.totalAgentMs===agent&&switchedRow.required===1.5,"SID continuation reset or duplicated its complete unit");
  t.assertions.assert(card(uniform(3*h,1)).value.redLines.R6.triggered===true,"long full-unit serial work escaped R6");
  t.assertions.assert(card(uniform(25*minute,1)).row.state==="not-applicable","short complete unit lost its exemption");
  for(const [ms,required]of [[30*minute,.75],[h,1.5],[2*h,2]]){
    const row=card(uniform(ms,required)).row;
    t.assertions.assert(row.required===required&&row.state==="pass","exact cumulative tier threshold changed");
  }
  t.assertions.assert(card(uniform(h,1.5,start+15*minute)).row.state==="pass"
    &&card(uniform(h,1.5,start+15*minute-1)).row.state==="not-applicable","hourly fifteen-minute applicability changed");
  const declining=uniform(4*h,1),d=declining.acceptanceUnits[0];
  d.sessions=Array.from({length:8},(_,i)=>({sessionId:"declining."+i,readable:true,runs:[run(d.openedAtMs,i===0?end:d.openedAtMs+2*h)]}));declining.taskTrees=[structuredClone(d)];
  const decline=card(declining);
  t.assertions.assert(decline.row.low===4.5&&decline.row.hourLow===1&&decline.value.redLines.R6.triggered===false,"approved cumulative smoothing or hourly diagnostic changed");
  const stalled=uniform(3*h,8),st=stalled.acceptanceUnits[0];
  st.sessions.forEach((x:any)=>x.runs=[run(st.openedAtMs,start)]);stalled.taskTrees=[structuredClone(st)];stalled.stalls=[{taskId:st.taskId,startAtMs:start,endAtMs:end}];
  const stopped=card(stalled);
  t.assertions.assert(stopped.value.redLines.R6.triggered===false&&stopped.row.hourLow===0&&stopped.value.redLines.R4.triggered===true,"cumulative R6 erased a genuine current-hour inactivity interval");
  const missing=structuredClone(closing);missing.acceptanceUnits[0].boundaryKnown=false;
  t.assertions.assert(card(missing).value.redLines.R6.triggered===null,"missing unit boundary became a full-unit pass");
  const unread=uniform(90*minute,2);unread.acceptanceUnits[0].sessions[1].readable=false;
  t.assertions.assert(card(unread).value.redLines.R6.triggered===null,"unknown full-unit work became zero or a pass");
  const background=uniform(90*minute,1),bg=background.acceptanceUnits[0],t0=bg.openedAtMs;
  const job=(id:string)=>({...run(t0+5*minute,t0+45*minute),jobId:id,basis:"registered-native-process-runtime/1"});
  bg.sessions=[{sessionId:"build.owner",readable:true,runs:[run(t0,t0+10*minute)],backgroundRuns:[job("build"),job("overlap")]},
    {sessionId:"build.support",readable:true,runs:[run(t0,end)]}];background.taskTrees=[structuredClone(bg)];
  const built=card(background);
  t.assertions.assert(built.row.totalAgentMs===135*minute&&built.row.agentMs===75*minute&&built.row.low===1.5&&built.row.state==="pass","full-scope background union multiplied one Agent or used only this hour");
  background.acceptanceUnits[0].excluded=[run(t0+20*minute,t0+30*minute)];
  const paused=card(background).row;
  t.assertions.assert(paused.totalEffectiveMs===80*minute&&paused.totalAgentMs===115*minute,"cumulative pause exclusion lost interval union");
  t.note("Explicit offline scope algebra only; actual native association/process coverage is separate. No fixtures count as natural cards or Human acceptance.");
});

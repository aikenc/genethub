import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-card",
  title: "The shipped offline quality CLI reproduces a frozen score and refuses to turn missing truth into a formal pass",
  oracle: "Hand-computable non-project snapshots through the real Builder output prove weights, per-class penalties, time-integrated parallelism, unresolved historical debt, sample/coverage gates and byte-identical recomputation without a daemon or model.",
  catches: ["queue count substituted for effective work", "unknown treated as zero loss", "old unresolved red line cleared by changing hour", "a red line charged once per instance", "small sample receives a formal grade", "external facts saved as an adopted native card"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["spacebuilder.py build", "tools/run.py quality card", "tools/run.py quality describe"],
  surfaces: ["filesystem", "team-template"], requiredArtifacts: [],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0 },
  expectedDurationMs: 7000, timeoutMs: 90000,
}, async t => {
  const refs = path.join(t.openRoot, "apps/daemon/builtin-skills/genehub/references");
  const source = path.join(t.env.root, "definition");
  const output = path.join(t.env.root, "compiled-team");
  cpSync(path.join(refs, "team-template"), source, { recursive: true });
  const python = process.env.GENEHUB_PYTHON!;
  const env = { PATH: process.env.PATH ?? "", HOME: path.join(t.env.root, "home") };
  mkdirSync(env.HOME, { recursive: true });
  const build = spawnSync(python, [path.join(refs, "spacebuilder/spacebuilder.py"), "build", source, "--output", output, "--require-no-post-commands"], { env, encoding: "utf8", timeout: 30000 });
  t.assertions.assert(build.status === 0, "actual independent Team build failed: " + build.stdout + build.stderr);
  const h = 3600000, start = Math.floor(1600000000000 / h) * h;
  const facts: any = {
    schema: "team-quality-facts/1", team: "non-project-work", window: { startAtMs: start, endAtMs: start+h },
    measurementWindow: { startAtMs: start-23*h, endAtMs: start+h }, capturedAtMs: start+h+900000,
    versions: { templateAtCapture: "frozen-fixture-v1" },
    coverage: { dispatches: true, starts: true, deliveries: true, observations: true, goals: true, resources: true, inputs: true, turns: true },
    goalIntervals: [{ startAtMs: start, endAtMs: start+h }], measurementGoalIntervals: [{ startAtMs: start, endAtMs: start+h }],
    workItems: Array.from({ length: 20 }, (_, n) => ({ id: `unit.${n}`, hasReceipt: true, dispatchAtMs: start,
      confirmedAtMs: start+10000, startedAtMs: start+120000, conclusionAtMs: start+600000,
      deliveredAtMs: start+630000, consumedAtMs: start+750000, requester: "requester", recipient: "requester",
      disposition: "adopted-inferred", resourceRequired: true, releasedAtMs: start+660000,
      releaseTimeBasis: "verified-release", executionMs: 480000 })),
    turns: Array.from({ length: 20 }, (_, n) => ({ turnId: `turn.${n}`, startedAtMs: start+120000,
      finishedAtMs: start+600000, durationMs: 480000, outcome: "completed", coordination: false })),
    baseline: { executionMsPerAdopted: 480000 }, inputs: [], wakes: [], failures: [], stalls: [],
  };
  const fixture = path.join(t.env.root, "frozen-facts.json");
  const evaluate = (value: any, extra: string[] = []) => {
    writeFileSync(fixture, JSON.stringify(value));
    return spawnSync(python, [path.join(output, "tools/run.py"), "quality", "card", "--snapshot", fixture, ...extra], { cwd: output, env, encoding: "utf8", timeout: 10000 });
  };
  const card = (value: any) => {
    const result = evaluate(value);
    t.assertions.assert(result.status === 0, "public frozen evaluation failed: " + result.stdout + result.stderr);
    return { text: result.stdout, value: JSON.parse(result.stdout) };
  };
  const good = card(facts), replay = card(facts);
  t.assertions.assert(good.text === replay.text && good.value.formal === true && Math.abs(good.value.score-98.333) < .001,
    "frozen arithmetic or byte determinism differs from the hand-computed 98.333");
  t.assertions.assert(good.value.coverage.knownWeightPct === 90 && good.value.indicators.idleWakePct.value === null,
    "absent wake observations counted as perfect idle behavior");
  const clone = () => JSON.parse(JSON.stringify(facts));
  const serial = clone();
  for (const x of serial.workItems) { x.dispatchAtMs=start+480000; x.confirmedAtMs=start+490000; x.startedAtMs=start+540000; x.executionMs=60000; }
  serial.baseline.executionMsPerAdopted=60000;
  for (const x of serial.turns) { x.startedAtMs=start+540000; x.durationMs=60000; }
  const insufficientParallel = card(serial).value;
  t.assertions.assert(insufficientParallel.redLines.R6.triggered === true && insufficientParallel.penalty === 50 && insufficientParallel.score < 50,
    "twenty queued or short items hid an effective in-flight mean below two");
  const pausedWork = clone();
  for (const x of pausedWork.workItems) x.workActivity = {
    basis: "native-minute-and-rounds/1",
    active: [{startAtMs:start+120000,endAtMs:start+240000}],
    excluded: [{startAtMs:start+240000,endAtMs:start+600000}],
  };
  const pausedCard=card(pausedWork).value;
  t.assertions.assert(pausedCard.redLines.R6.triggered===true
    && Math.abs(pausedCard.effectiveInFlight.knownMean-2/3)<1e-9
    && Math.abs(pausedCard.effectiveInFlight.possibleMean-2/3)<1e-9,
    "paused or waiting time manufactured effective parallel work");
  const pausedOpen=JSON.parse(JSON.stringify(serial));
  for(let n=0;n<2;n++) pausedOpen.workItems.push({id:"paused.open."+n,hasReceipt:true,
    dispatchAtMs:start,confirmedAtMs:start,startedAtMs:start,conclusionAtMs:null,
    workActivity:{basis:"native-minute-and-rounds/1",active:[],excluded:[{startAtMs:start,endAtMs:start+h}]}});
  t.assertions.assert(card(pausedOpen).value.redLines.R6.triggered===true,
    "unfinished paused items hid a proven effective parallel deficit");
  const missingActivity=clone();
  for(const x of missingActivity.workItems) x.workActivity={basis:"native-minute-and-rounds/1",active:[],excluded:[]};
  const missingActivityCard=card(missingActivity).value;
  t.assertions.assert(missingActivityCard.redLines.R6.triggered===null && !missingActivityCard.formal
    && missingActivityCard.effectiveInFlight.knownMean===0 && missingActivityCard.effectiveInFlight.possibleMean>2,
    "missing activity samples manufactured active time or a proven deficit");
  const conflictingActivity=JSON.parse(JSON.stringify(pausedWork));
  conflictingActivity.workItems[0].workActivity.excluded[0].startAtMs=start+180000;
  t.assertions.assert(evaluate(conflictingActivity).status!==0,"overlapping active and paused facts were silently scored");
  const unknown = clone(); unknown.coverage.starts=false;
  const incomplete = card(unknown).value;
  t.assertions.assert(incomplete.formal === false && incomplete.score === null && incomplete.redLines.R6.triggered === null,
    "unknown starts became a formal red-line-free score");
  const debt = clone(); debt.workItems.push({ id: "original-unconfirmed", dispatchAtMs: start-2*h, hasReceipt: false });
  t.assertions.assert(card(debt).value.redLines.R1.triggered === true, "unresolved debt vanished at the hour boundary");
  debt.workItems.at(-1).withdrawnAtMs=start-60000;
  t.assertions.assert(card(debt).value.redLines.R1.triggered === false, "a preserved, actually withdrawn old operation stayed falsely outstanding");
  const penalties = clone();
  for (const x of penalties.workItems) { x.recipient="wrong-recipient"; x.releasedAtMs=start+1260000; }
  const breached = card(penalties).value;
  t.assertions.assert(breached.penalty === 100 && breached.provisionalScore === 0, "red lines charged per instance or skipped the zero floor");
  const small = clone(); small.workItems.pop(); small.turns.pop();
  t.assertions.assert(card(small).value.formal === false, "nineteen closed items received a formal grade");
  const missingDelivery = clone(); missingDelivery.coverage.deliveries=false;
  for (const x of missingDelivery.workItems) delete x.deliveredAtMs;
  const noProof=card(missingDelivery).value;
  t.assertions.assert(noProof.formal===false && noProof.redLines.R3.triggered===null,
    "missing historical delivery truth became an overdue result or a formal clear");
  Object.assign(missingDelivery.workItems[0],{deliveredAtMs:start+1260000,deliveryCoverageKnown:true});
  t.assertions.assert(card(missingDelivery).value.redLines.R3.triggered===true,
    "an independently proven late result was hidden by other missing delivery evidence");
  const empty = clone(); empty.goalIntervals=[];
  t.assertions.assert(card(empty).value.formal === false, "an empty workload manufactured a formal pass");
  const rework = clone(); for (let n=0;n<10;n++) rework.workItems[n].disposition="rework";
  t.assertions.assert(card(rework).value.score < 80, "rework did not lower the work-quality score");
  const idleDebt=clone();idleDebt.coverage.idleObligations=true;
  Object.assign(idleDebt.workItems[0],{dispatchAtMs:start-2*h,confirmedAtMs:start-2*h+10000,startedAtMs:start-2*h+120000});
  Object.assign(idleDebt.turns[0],{startedAtMs:start-2*h+120000,finishedAtMs:start-2*h+600000});
  idleDebt.workItems[0].idlePeriods=[{startAtMs:start-2*h+600000,observedThroughAtMs:start,resolvedAtMs:null}];
  t.assertions.assert(card(idleDebt).value.redLines.R2.triggered===true,"a proven unresolved idle obligation disappeared");
  idleDebt.workItems[0].idlePeriods[0].resolvedAtMs=start-60000;
  idleDebt.workItems[0].idlePeriods[0].observedThroughAtMs=start-120000;
  t.assertions.assert(card(idleDebt).value.redLines.R2.triggered===false,"an idle obligation resolved before the hour remained outstanding");
  idleDebt.workItems[0].idlePeriods[0].resolvedAtMs=start+60000;
  idleDebt.workItems[0].idlePeriods[0].observedThroughAtMs=start;
  t.assertions.assert(card(idleDebt).value.redLines.R2.triggered===true,"a proven idle obligation resolved during the hour vanished from that hour");
  idleDebt.workItems[0].standing=true;
  t.assertions.assert(card(idleDebt).value.redLines.R2.triggered===false,"declared standing work received a finite idle obligation");
  const ambiguousIdle=clone();ambiguousIdle.coverage.idleObligations=true;
  Object.assign(ambiguousIdle.workItems[0],{dispatchAtMs:start-h,confirmedAtMs:start-h+10000,startedAtMs:start-h+120000,
    conclusionAtMs:start+3000000,deliveredAtMs:start+3030000,consumedAtMs:start+3150000,releasedAtMs:start+3060000});
  Object.assign(ambiguousIdle.turns[0],{startedAtMs:start-h+120000,finishedAtMs:start-h+600000});
  ambiguousIdle.workItems[0].idlePeriods=[{startAtMs:start-1800000,observedThroughAtMs:start+1200000,resolvedAtMs:start+2400000}];
  const ambiguousCard=card(ambiguousIdle).value;
  t.assertions.assert(ambiguousCard.redLines.R2.triggered===null && ambiguousCard.formal===false,
    "an unobserved idle threshold crossing became a formal clear or a proven breach");
  const oldDelivery=clone(),oldStart=start-2*h;
  const prior={...oldDelivery.workItems[0],id:"old-delivery",dispatchAtMs:oldStart,
    confirmedAtMs:oldStart+10000,startedAtMs:oldStart+120000,conclusionAtMs:oldStart+600000,
    deliveredAtMs:oldStart+630000,consumedAtMs:oldStart+750000,releasedAtMs:oldStart+660000,
    deliveryMessageIds:["prior.first","prior.duplicate"],deliveryCoverageKnown:true,
    deliveryEvents:[{messageId:"prior.first",recipient:"requester",acceptedAtMs:oldStart+630000},
      {messageId:"prior.duplicate",recipient:"requester",acceptedAtMs:oldStart+650000}]};
  oldDelivery.workItems.push(prior);
  t.assertions.assert(card(oldDelivery).value.redLines.R3.triggered===false,
    "a settled duplicate before this hour was charged again");
  prior.deliveryMessageIds.push("current.duplicate");
  prior.deliveryEvents.push({messageId:"current.duplicate",recipient:"requester",acceptedAtMs:start+300000});
  t.assertions.assert(card(oldDelivery).value.redLines.R3.triggered===true,
    "a genuine duplicate in this hour was hidden with historical deliveries");
  const resolvedRoute=clone();
  resolvedRoute.workItems.push({...prior,deliveryMessageIds:["wrong.first","correct.second"],
    deliveredAtMs:oldStart+650000,deliveryEvents:[
      {messageId:"wrong.first",recipient:"wrong",acceptedAtMs:oldStart+630000},
      {messageId:"correct.second",recipient:"requester",acceptedAtMs:oldStart+650000}]});
  t.assertions.assert(card(resolvedRoute).value.redLines.R3.triggered===false,
    "a wrong route corrected before this hour remained falsely outstanding");
  const timeless=clone();timeless.workItems.push({...prior,deliveryEvents:undefined});
  const unresolvedTime=card(timeless).value;
  t.assertions.assert(unresolvedTime.redLines.R3.triggered===null && unresolvedTime.formal===false,
    "legacy duplicate IDs without occurrence times were placed into a formal hour");
  const boundedDelivery=clone();
  const boundedItem:any={...prior,id:"bounded-old-delivery",deliveredAtMs:null,consumedAtMs:null,
    disposition:null,deliveryMessageIds:[],deliveryEvents:[],deliveryCoverageKnown:true,
    deliveryBounds:[{messageId:"history.first",recipient:"requester",acceptedUpperBoundMs:start-60000}]};
  boundedDelivery.workItems.push(boundedItem);
  const boundedCard=card(boundedDelivery).value;
  t.assertions.assert(boundedCard.redLines.R3.triggered===false && boundedCard.redLines.R3.coverageKnown===true,
    "a native-history corroborated delivery before the hour remained an outstanding result");
  t.assertions.assert(boundedCard.indicators.conclusionToDeliveryP90Min.samples===20
    && boundedCard.indicators.deliveryToConsumeP90Min.samples===20,
    "an observed acceptance upper bound manufactured an exact latency or read sample");
  boundedItem.deliveryBounds[0].acceptedUpperBoundMs=start+60000;
  const currentBound=card(boundedDelivery).value;
  t.assertions.assert(currentBound.redLines.R3.triggered===null && !currentBound.formal,
    "a current-hour upper bound cleared or invented a historical delivery breach");
  boundedItem.deliveryBounds[0].acceptedUpperBoundMs=start-60000;
  boundedItem.deliveryEvents.push({messageId:"current.second",recipient:"requester",acceptedAtMs:start+300000});
  t.assertions.assert(card(boundedDelivery).value.redLines.R3.instances.some((x:any)=>x.reason==="duplicate-result"),
    "an exact current duplicate was hidden because the first accepted input lost its precise time");
  boundedItem.deliveryEvents[0].recipient="wrong";
  t.assertions.assert(card(boundedDelivery).value.redLines.R3.instances.some((x:any)=>x.reason==="wrong-recipient"),
    "a current misroute after earlier bounded success disappeared");
  boundedItem.deliveryEvents=[];boundedItem.deliveryBounds[0].recipient="wrong";
  t.assertions.assert(card(boundedDelivery).value.redLines.R3.triggered===true,
    "old wrong-recipient history alone discharged the correct recipient obligation");
  const legacyRelease=clone();
  const legacyItem={...prior,id:"legacy-release",deliveryMessageIds:[],deliveryEvents:[],
    releaseTimeBasis:"observed-absence-upper-bound",releasedAtMs:start+60000};
  legacyRelease.workItems.push(legacyItem);
  const ambiguousRelease=card(legacyRelease).value;
  t.assertions.assert(ambiguousRelease.redLines.R5.triggered===null && ambiguousRelease.formal===false,
    "a late current-hour absence upper bound manufactured a proven on-time release");
  legacyItem.releasedAtMs=start-1;
  t.assertions.assert(card(legacyRelease).value.redLines.R5.triggered===false,
    "a durable absence bound before this hour kept future release state unknown");
  legacyItem.releasedAtMs=legacyItem.conclusionAtMs+60000;
  t.assertions.assert(card(legacyRelease).value.redLines.R5.triggered===false,
    "an observed absence before the release deadline could not establish an on-time release");
  legacyItem.releaseTimeBasis="verified-release";legacyItem.releasedAtMs=start+60000;
  t.assertions.assert(card(legacyRelease).value.redLines.R5.triggered===true,
    "an exact verified late release was hidden as an uncertain upper bound");
  legacyItem.releasedAtMs=undefined;legacyItem.releaseTimeBasis=undefined;
  t.assertions.assert(card(legacyRelease).value.redLines.R5.triggered===null,
    "an overdue resource with no held/released observation became a formal clear");
  // Frozen R6 task-hour oracles; tree sessions have no eventual conclusions.
  const r6Minute=60000;
  const r6Runs=(...pairs:number[][])=>pairs.map(([a,b])=>({startAtMs:start+a*r6Minute,endAtMs:start+b*r6Minute}));
  const r6Session=(sessionId:string, intervals:any[], readable=true)=>({sessionId,runs:intervals,readable});
  const r6Tree=(taskId:string,minutes:number,sessions:any[],excluded:any[]=[])=>({taskId,openedAtMs:start,endedAtMs:start+minutes*r6Minute,sessions,excluded});
  const r6TaskCard=(trees:any[])=>{const v:any=clone();v.scoringModel="tq/2";v.taskTrees=trees;v.taskTreesSourceComplete=true;return card(v).value;};
  const r6Short=r6TaskCard([r6Tree("r6Short",10,[r6Session("o",r6Runs([0,10]))])]);
  t.assertions.assert(r6Short.model==="tq/2" && r6Short.redLines.R6.applicable===false && r6Short.redLines.R6.triggered===false,
    "ten-minute task was judged or the card hid its scoring model");
  const r6Serial=r6TaskCard([r6Tree("r6Serial",50,[r6Session("o",r6Runs([0,50]))])]);
  t.assertions.assert(r6Serial.redLines.R6.triggered===true && r6Serial.taskParallelism[0].low===1,
    "fifty-minute serial work escaped task-based R6");
  const r6Parallel=r6TaskCard([r6Tree("r6Parallel",50,[r6Session("o",r6Runs([0,5],[45,50])),r6Session("a",r6Runs([5,45])),r6Session("b",r6Runs([5,40])),r6Session("c",r6Runs([10,45]))])]);
  t.assertions.assert(r6Parallel.redLines.R6.triggered===false && Math.abs(r6Parallel.taskParallelism[0].low-2.4)<1e-9,
    "native in-flight work waited for a future conclusion or Agent time was miscounted");
  const r6Paused=r6TaskCard([r6Tree("r6Paused",60,[r6Session("o",r6Runs([0,10],[50,60]))],r6Runs([10,50]))]);
  t.assertions.assert(r6Paused.redLines.R6.applicable===false && r6Paused.taskParallelism[0].totalEffectiveMs===20*r6Minute,
    "forty-minute pause inflated effective task duration");
  const r6Unread=r6TaskCard([r6Tree("r6Unread",40,[r6Session("o",r6Runs([0,40])),r6Session("remote",[],false)])]);
  t.assertions.assert(r6Unread.redLines.R6.triggered===null && r6Unread.taskParallelism[0].low===1 && r6Unread.taskParallelism[0].high===2,
    "unread remote Session was silently treated as idle or productive");
  const r6Boundary:any=r6Tree("prior-half-hour",15,[r6Session("o",r6Runs([-15,15]))]);r6Boundary.openedAtMs=start-15*r6Minute;
  const r6AtBoundary=r6TaskCard([r6Boundary]);
  t.assertions.assert(r6AtBoundary.redLines.R6.triggered===true && r6AtBoundary.taskParallelism[0].hourEffectiveMs===15*r6Minute,
    "R6 confused cumulative thirty minutes with thirty minutes inside this hour");
  r6Boundary.endedAtMs=start+15*r6Minute-1;
  t.assertions.assert(r6TaskCard([r6Boundary]).redLines.R6.applicable===false,
    "less than fifteen minutes in this hour was judged");
  const r6Overlaps=r6TaskCard([r6Tree("overlap",50,[r6Session("o",r6Runs([0,50],[0,50],[10,30]))])]);
  t.assertions.assert(r6Overlaps.taskParallelism[0].low===1 && r6Overlaps.redLines.R6.triggered===true,
    "overlapping executions or parallel tools in one Session manufactured two Agents");
  const r6Proven=r6TaskCard([r6Tree("r6Proven",40,[r6Session("o",r6Runs([0,40])),r6Session("a",r6Runs([0,40])),r6Session("missing",[],false)])]);
  t.assertions.assert(r6Proven.redLines.R6.triggered===false,
    "an unread Session erased two already proven Agent hours");
  const r6Impossible=r6TaskCard([r6Tree("r6Impossible",50,[r6Session("o",r6Runs([0,10])),r6Session("missing",[],false)])]);
  t.assertions.assert(r6Impossible.redLines.R6.triggered===true,
    "an unread Session hid a proven upper bound below two");
  const laterSession:any=r6Session("future-remote",[],false);laterSession.openedAtMs=start+h+1;
  const pastSerial=r6TaskCard([r6Tree("no-future-members",50,[r6Session("o",r6Runs([0,50])),laterSession])]);
  t.assertions.assert(pastSerial.redLines.R6.triggered===true && pastSerial.taskParallelism[0].high===1
    && pastSerial.taskParallelism[0].missingSessionIds.length===0,
    "a future Session introduced phantom uncertainty into a prior hour");
  const legacyFacts={...clone(),scoringModel:"tq/2",taskTrees:[r6Tree("legacy-frozen",50,[r6Session("o",r6Runs([0,50]))])],taskTreesSourceComplete:true};
  const legacyText=card(legacyFacts).text;
  t.note("Frozen pre-tier card byte digest: "+createHash("sha256").update(legacyText).digest("hex"));
  t.assertions.assert(createHash("sha256").update(legacyText).digest("hex")==="c3ccc6310a3b2fdecb2a45ece94f661d6dee428481486c7956164fb195722bce",
    "legacy frozen card changed from the retained pre-tier run eaf1");
  const tierTree=(id:string,totalMs:number,parallel:number)=>{
    const end=start+h,opened=end-totalMs,a=Math.max(start,opened),wall=end-a;
    const sessions=Array.from({length:Math.ceil(parallel)},(_,n)=>({sessionId:id+".worker."+n,readable:true,
      runs:[{startAtMs:a,endAtMs:a+wall*Math.min(1,parallel-n)}]}));
    return {taskId:id,openedAtMs:opened,endedAtMs:end,excluded:[] as any[],sessions};
  };
  const tierCard=(tree:any)=>card({...clone(),scoringModel:"tq/2",r6Basis:"task-agent-hours/2",taskTrees:[tree],taskTreesSourceComplete:true}).value;
  for(const [total,threshold]of [[1800000,.75],[3599999,.75],[3600000,1.5],[7199999,1.5],[7200000,2],[10800000,2]]){
    const tree=tierTree("tier."+total,total!,threshold!);
    const passed=tierCard(tree),row=passed.taskParallelism[0];
    t.assertions.assert(passed.redLines.R6.triggered===false && row.state==="pass" && row.required===threshold,
      "R6 did not use the cumulative-duration threshold at "+total+"ms: "+JSON.stringify(row));
    const failed=tierCard(tierTree("below."+total,total!,threshold!-.25));
    t.assertions.assert(failed.redLines.R6.triggered===true && failed.redLines.R6.instances[0].required===threshold,
      "proven deficit lost its actual duration-tier threshold");
    tree.sessions.push({sessionId:"unread",readable:false,runs:[]});
    t.assertions.assert(tierCard(tree).redLines.R6.triggered===false,"missing evidence erased a proven passing lower bound");
    const uncertain=tierTree("uncertain."+total,total!,threshold===.75?.5:threshold!-1);
    const wall=uncertain.endedAtMs-Math.max(start,uncertain.openedAtMs);
    uncertain.sessions.push({sessionId:"unknown",readable:false,runs:[],openedAtMs:uncertain.endedAtMs-wall*(threshold===.75?.25:1)} as any);
    const unknownTier=tierCard(uncertain);
    t.assertions.assert(unknownTier.redLines.R6.triggered===null && unknownTier.taskParallelism[0].high===threshold,
      "upper bound exactly at a tier threshold was declared a breach or a pass");
  }
  const exempt=tierCard(tierTree("under-half-hour",1799999,0));
  t.assertions.assert(exempt.redLines.R6.applicable===false && exempt.taskParallelism[0].required===null,
    "task shorter than half an effective hour was assessed");
  const hourlyEdge:any=r6Tree("hour-quarter",15,[r6Session("o",r6Runs([-30,15]))]);hourlyEdge.openedAtMs=start-30*r6Minute;
  t.assertions.assert(tierCard(hourlyEdge).taskParallelism[0].state==="pass","exactly fifteen minutes in this hour was excluded");
  hourlyEdge.endedAtMs--;
  t.assertions.assert(tierCard(hourlyEdge).taskParallelism[0].state==="not-applicable","less than fifteen minutes in this hour was assessed");
  const effective=tierTree("effective-not-elapsed",10800000,1.5);
  effective.excluded=[{startAtMs:start-2*h,endAtMs:start-h/2}];
  const effectiveRow=tierCard(effective).taskParallelism[0];
  t.assertions.assert(effectiveRow.totalEffectiveMs===5400000 && effectiveRow.required===1.5 && effectiveRow.state==="pass",
    "elapsed pauses promoted a task into a higher duration tier");
  const newBasis=tierCard(tierTree("new-basis",7200000,2));
  t.assertions.assert(newBasis.redLines.R6.basis==="task-agent-hours/2"
    && newBasis.streakCompatibilityKey.includes("task-agent-hours/2")
    && newBasis.streakCompatibilityKey!==JSON.parse(legacyText).streakCompatibilityKey
    && card(legacyFacts).text===legacyText && JSON.parse(legacyText).redLines.R6.basis==="task-agent-hours/1"
    && !("required"in JSON.parse(legacyText).taskParallelism[0]),"new duration tiers rewrote or stitched legacy frozen semantics");
  const unsupported={...legacyFacts,r6Basis:"task-agent-hours/999"};
  t.assertions.assert(evaluate(unsupported).status!==0,"unsupported R6 basis silently received a score");
  const describe=spawnSync(python,[path.join(output,"tools/run.py"),"quality","describe"],{cwd:output,env,encoding:"utf8",timeout:10000});
  const policy=describe.status===0?JSON.parse(describe.stdout).r6:null;
  t.assertions.assert(policy?.basis==="acceptance-unit-agent-hours/3" && policy.minimumTotalEffectiveMs===1800000
    && policy.minimumHourEffectiveMs===900000 && JSON.stringify(policy.tiers.map((x:any)=>[x.minimumTotalEffectiveMs,x.required]))===JSON.stringify([[1800000,.75],[3600000,1.5],[7200000,2]]),"public R6 description differs from the duration-tier contract");
  // Independently calculable full acceptance-unit windows. A 42-hour
  // container is deliberately irrelevant to the duration of its new unit.
  const unitBasis="acceptance-unit-agent-hours/3",executionBasis="registered-native-execution-union/2";
  const unitFacts=(total:number,parallel:number)=>{
    const unit:any={...tierTree("root-open-42-hours",total,parallel),unitId:"complete-delivery",boundaryKnown:true,
      boundaryBasis:"dispatch-acceptance-unit/1",operationIds:["repair","integration","verification"]};
    return {...clone(),scoringModel:"tq/2",r6Basis:unitBasis,executionBasis,acceptanceUnitBasis:"dispatch-acceptance-unit/1",
      taskTrees:[tierTree("container",42*h,0)],acceptanceUnits:[unit],taskTreesSourceComplete:true};
  };
  const shortUnit=card(unitFacts(25*r6Minute,1)).value;
  t.assertions.assert(shortUnit.taskParallelism[0].required===null && shortUnit.redLines.R6.applicable===false,
    "a short independent complete unit inherited the 42-hour container's threshold");
  const continuedUnit=card(unitFacts(90*r6Minute,1)).value;
  t.assertions.assert(continuedUnit.redLines.R6.triggered===true && continuedUnit.taskParallelism[0].required===1.5
    && continuedUnit.redLines.R6.instances[0].unitId==="complete-delivery",
    "an unfinished unit lost its cumulative duration or instance identity");
  const missingBoundary=unitFacts(90*r6Minute,1);missingBoundary.acceptanceUnits[0].boundaryKnown=false;
  t.assertions.assert(card(missingBoundary).value.redLines.R6.triggered===null,
    "unlinked historical work was assigned an invented independent boundary");
  const buildUnit=unitFacts(h,0),buildTree=buildUnit.acceptanceUnits[0];
  const job=(a:number,b:number,id:string)=>({startAtMs:start+a*r6Minute,endAtMs:start+b*r6Minute,jobId:id,basis:"registered-native-process-runtime/1"});
  buildTree.sessions=[{sessionId:"owner",readable:true,runs:r6Runs([0,10]),backgroundRuns:[job(5,45,"build"),job(5,45,"overlapping-job")]},
    {sessionId:"worker",readable:true,runs:r6Runs([0,60]),backgroundRuns:[]}];
  buildUnit.taskTrees=[{...structuredClone(buildTree),taskId:"root-open-42-hours"}];
  buildUnit.stalls=[{taskId:"root-open-42-hours",startAtMs:start,endAtMs:start+h}];
  const measuredBuild=card(buildUnit).value;
  const instantaneous=structuredClone(buildUnit);
  instantaneous.stalls.push({taskId:"root-open-42-hours",startAtMs:start+123,endAtMs:start+123});
  t.assertions.assert(card(instantaneous).value.taskParallelism[0].agentMs===105*r6Minute,
    "zero-duration native idle observations prevented formal execution projection");
  instantaneous.stalls.at(-1)!.endAtMs--;
  t.assertions.assert(evaluate(instantaneous).status!==0,"a reversed stall interval was silently repaired");
  t.assertions.assert(measuredBuild.taskParallelism[0].agentMs===105*r6Minute
    && measuredBuild.taskParallelism[0].low===1.75 && measuredBuild.redLines.R6.triggered===false
    && measuredBuild.redLines.R4.triggered===false,"formal background union ignored work, multiplied one Agent or retained a false stall");
  const pausedBuild=structuredClone(buildUnit);
  pausedBuild.acceptanceUnits[0].excluded=r6Runs([20,30]);pausedBuild.taskTrees[0].excluded=r6Runs([20,30]);
  t.assertions.assert(card(pausedBuild).value.taskParallelism[0].agentMs===85*r6Minute,"formal background work inflated a paused unit");
  const unreadBuild=structuredClone(buildUnit);unreadBuild.acceptanceUnits[0].sessions[0].readable=false;
  t.assertions.assert(card(unreadBuild).value.taskParallelism[0].agentMs===100*r6Minute,
    "unread model rounds erased proven registered native background work or invented unobserved round time");
  const forgedBuild=structuredClone(buildUnit);forgedBuild.acceptanceUnits[0].sessions[0].backgroundRuns[0].basis="claimed-by-prose";
  t.assertions.assert(evaluate(forgedBuild).status!==0,"unproven background claim entered formal Agent hours");
  const sharedOwner=unitFacts(h,0);
  sharedOwner.acceptanceUnits[0].sessions=[{sessionId:"owner",readable:true,runs:r6Runs([0,20]),partialCoverage:true,
    allocationUnknownRuns:r6Runs([20,25])},{sessionId:"support",readable:true,runs:r6Runs([0,60])}];
  const sharedRow=card(sharedOwner).value.taskParallelism[0];
  t.assertions.assert(sharedRow.agentMs===80*r6Minute && Math.abs(sharedRow.high-85/60)<1e-12 && sharedRow.state==="fail",
    "ambiguous Owner allocation invented idle time or hid a proven upper bound");
  t.assertions.assert(measuredBuild.streakCompatibilityKey!==newBasis.streakCompatibilityKey
    && measuredBuild.streakCompatibilityKey.includes(executionBasis) && card(legacyFacts).text===legacyText,
    "new formal execution/unit meanings stitched an old chain or rewrote a frozen card");
  // New bases keep a read-only result distinct from a bounded integration
  // reference. The twenty closed items are the denominator, not a selected
  // subset of successful declarations.
  const useBasis="native-owner-use-reference/1", timeBasis="complete-acceptance-unit-time/1";
  const useFacts=clone();useFacts.adoptionBasis=useBasis;
  for(const x of useFacts.workItems){x.taskId="bounded-goal";x.adoptionEvidence={basis:useBasis,state:"inferred"};}
  const inferredOnly=card(useFacts).value;
  t.assertions.assert(inferredOnly.indicators.firstPassAdoptionPct.value===null
    && inferredOnly.indicators.reworkPct.value===null && inferredOnly.adoptionEvidenceCoverage.unknown===20,
    "ten-minute inference became confirmed adoption");
  const proof=(x:any)=>({basis:useBasis,state:"evidenced",sessionId:x.requester,operationId:x.id,atMs:start+800000});
  for(const x of useFacts.workItems){x.disposition="adopted-evidenced";x.adoptionEvidence=proof(x);}
  const allUsed=card(useFacts).value;
  t.assertions.assert(allUsed.indicators.firstPassAdoptionPct.value===100
    && allUsed.adoptionEvidenceCoverage.evidenced===20 && allUsed.streakCompatibilityKey!==good.value.streakCompatibilityKey,
    "bounded requester integration references or compatibility isolation missing");
  const readUnused=JSON.parse(JSON.stringify(useFacts));
  readUnused.workItems[0].adoptionEvidence={basis:useBasis,state:"read"};
  t.assertions.assert(card(readUnused).value.indicators.firstPassAdoptionPct.value===null,
    "nineteen referenced results hid one read-but-unused result");
  const forgedUse=JSON.parse(JSON.stringify(useFacts));forgedUse.workItems[0].adoptionEvidence.sessionId="another-owner";
  t.assertions.assert(card(forgedUse).value.indicators.firstPassAdoptionPct.value===null,
    "another requester's declaration confirmed adoption");
  const ordinaryQA=JSON.parse(JSON.stringify(useFacts));
  ordinaryQA.workItems[0].acceptanceUnit={id:"same-unit",stage:"verification",relation:"support"};
  t.assertions.assert(card(ordinaryQA).value.indicators.reworkPct.value===0,"ordinary linked QA was called rework");
  const unmarkedWork=JSON.parse(JSON.stringify(ordinaryQA));
  unmarkedWork.workItems[1].acceptanceUnit={id:"same-unit",stage:"work",relation:"support"};
  Object.assign(unmarkedWork.workItems[1],{dispatchAtMs:start+600001,confirmedAtMs:start+605000,
    startedAtMs:start+610000,conclusionAtMs:start+900000,deliveredAtMs:start+930000,consumedAtMs:start+950000});
  unmarkedWork.workItems[1].adoptionEvidence={...proof(unmarkedWork.workItems[1]),atMs:start+980000};
  t.assertions.assert(card(unmarkedWork).value.indicators.firstPassAdoptionPct.value===null
    && card(unmarkedWork).value.indicators.reworkPct.value===null,
    "unmarked later work in the same unit hid ambiguous rework behind integration references");
  const missingUnitIdentity=JSON.parse(JSON.stringify(ordinaryQA));delete missingUnitIdentity.workItems[0].taskId;
  t.assertions.assert(card(missingUnitIdentity).value.indicators.firstPassAdoptionPct.value===null,
    "missing unit task identity crashed evaluation or became a confirmed first-pass result");
  ordinaryQA.workItems[1].follows=ordinaryQA.workItems[0].id;
  t.assertions.assert(card(ordinaryQA).value.indicators.reworkPct.value===5
    && card(ordinaryQA).value.indicators.firstPassAdoptionPct.value===95,"native rework link vanished behind use evidence");

  const costFacts=JSON.parse(JSON.stringify(useFacts));
  Object.assign(costFacts,{costBasis:timeBasis,executionBasis,scoringModel:"tq/2",r6Basis:"acceptance-unit-agent-hours/3",
    acceptanceUnitBasis:"dispatch-acceptance-unit/1",taskTrees:[],taskTreesSourceComplete:true});
  const contract={schema:"acceptance-comparison/1",scope:"same fixed bounded artifact",size:1,
    inputSha256:"a".repeat(64),acceptanceSha256:"b".repeat(64)};
  const scope={key:"exact-comparison-key",contract,meaning:"declared immutable comparable input and acceptance scope; not independent QA"};
  for(const [n,x]of costFacts.workItems.entries()){x.taskId="goal."+n;x.requester="owner."+n;x.adoptionEvidence=proof(x);}
  costFacts.acceptanceUnits=costFacts.workItems.map((x:any,n:number)=>({unitId:"complete."+n,taskId:"goal."+n,
    openedAtMs:start,endedAtMs:start+1200000,boundaryKnown:true,excluded:[],operationIds:[x.id],
    conclusion:{kind:"linked-stages-and-owner-round",atMs:start+1200000},costComparison:scope,
    sessions:[{sessionId:"owner."+n,readable:true,executionCoverageKnown:true,
      runs:[{startAtMs:start,endAtMs:start+600000}]},
      {sessionId:"worker."+n,readable:true,executionCoverageKnown:true,
      runs:[{startAtMs:start,endAtMs:start+1200000}]}]}));
  costFacts.costBaselines={schema:"team-unit-time-baselines/1",basis:timeBasis,groups:{
    [scope.key]:{unitIds:Array.from({length:20},(_,n)=>"baseline."+n),meanMs:1800000,comparison:scope,frozenAtMs:start}}};
  const unitCost=card(costFacts).value;
  t.assertions.assert(unitCost.unitTimeCost.completedUnits===20
    && unitCost.unitTimeCost.observedCompletedMs===20*1800000
    && unitCost.indicators.costPerAdoptedVsBaseline.value===1,
    "complete unit did not charge 10 Owner + 20 support minutes per unit");
  const splitCost=JSON.parse(JSON.stringify(costFacts));
  for(const [n,u]of splitCost.acceptanceUnits.entries()){
    const child={...splitCost.workItems[n],id:"extra.support."+n};child.adoptionEvidence=proof(child);
    splitCost.workItems.push(child);u.operationIds.push(child.id);u.sessions.splice(1,1,
    {sessionId:"partA."+n,readable:true,executionCoverageKnown:true,runs:[{startAtMs:start,endAtMs:start+600000}]},
    {sessionId:"partB."+n,readable:true,executionCoverageKnown:true,runs:[{startAtMs:start+600000,endAtMs:start+1200000}]});}
  t.assertions.assert(card(splitCost).value.unitTimeCost.observedCompletedMs===unitCost.unitTimeCost.observedCompletedMs
    && card(splitCost).value.indicators.costPerAdoptedVsBaseline.value===1,
    "splitting one support into two reduced the complete acceptance-unit cost");
  const pausedCost=JSON.parse(JSON.stringify(costFacts));
  for(const u of pausedCost.acceptanceUnits){u.excluded=[{startAtMs:start+300000,endAtMs:start+600000}];
    u.sessions[1].runs.push({startAtMs:start,endAtMs:start+1200000});}
  t.assertions.assert(card(pausedCost).value.unitTimeCost.observedCompletedMs===20*1200000,
    "same Session overlapping work or paused time multiplied unit costs");
  const unknownCost=JSON.parse(JSON.stringify(costFacts));unknownCost.acceptanceUnits[0].sessions[0].partialCoverage=true;
  t.assertions.assert(card(unknownCost).value.indicators.costPerAdoptedVsBaseline.value===null
    && card(unknownCost).value.unitTimeCost.units[0].unknownReasons.includes("shared-owner-allocation-unknown"),
    "ambiguous Owner time was called a complete efficiency comparison");
  const sharedSession=JSON.parse(JSON.stringify(costFacts));
  sharedSession.acceptanceUnits[0].sessions[0].sessionId="same-native-owner";
  sharedSession.acceptanceUnits[1].sessions[0].sessionId="same-native-owner";
  const sharedCard=card(sharedSession).value;
  t.assertions.assert(sharedCard.indicators.costPerAdoptedVsBaseline.value===null
    && sharedCard.unitTimeCost.observedCompletedMs===20*1800000-2*600000
    && sharedCard.unitTimeCost.units[0].unknownReasons.includes("shared-session-allocation-unknown"),
    "same native Session across roots duplicated overlapping Owner cost or manufactured efficiency");
  const missingMember=JSON.parse(JSON.stringify(costFacts));missingMember.acceptanceUnits[0].operationIds.push("older-result-outside-metric-horizon");
  t.assertions.assert(card(missingMember).value.indicators.costPerAdoptedVsBaseline.value===null,
    "missing older stage evidence was silently omitted from complete unit adoption");
  const oldBaseline=JSON.parse(JSON.stringify(costFacts));delete oldBaseline.costBaselines;
  t.assertions.assert(card(oldBaseline).value.indicators.costPerAdoptedVsBaseline.value===null,
    "legacy per-support baseline was borrowed by a complete-unit metric");
  const missingScope=JSON.parse(JSON.stringify(costFacts));delete missingScope.acceptanceUnits[0].costComparison;
  t.assertions.assert(card(missingScope).value.indicators.costPerAdoptedVsBaseline.value===null,
    "incomparable unit scope was compared as the same work");
  const tooFewUnits=JSON.parse(JSON.stringify(costFacts));tooFewUnits.acceptanceUnits.pop();
  t.assertions.assert(card(tooFewUnits).value.indicators.costPerAdoptedVsBaseline.value===null,
    "nineteen complete units passed the existing twenty-sample gate");
  t.assertions.assert(card(facts).text===good.text,"new outcome/cost bases rewrote a legacy frozen score");
  const importedNative=clone();importedNative.captureKind="native-hour";
  t.assertions.assert(card(importedNative).value.officialCapture===false,
    "an external snapshot self-declared official native provenance");
  const refused = evaluate(facts, ["--save"]);
  t.assertions.assert(refused.status !== 0, "imported facts were saved as an official adopted card");
  t.assertions.assert(readFileSync(fixture,"utf8").includes("non-project-work"), "fixture was replaced during read-only evaluation");
});

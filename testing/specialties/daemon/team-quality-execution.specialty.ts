import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-execution-observability",
  title: "Native background work and dispatch segments remain separate from old quality scores",
  oracle: "A real Agent registers its actual child process through the public task CLI, retries preserve one registration, another Session cannot claim that PID, live work cannot be finished, and genuine native input/Round times qualify the timing segments. A separately labelled frozen 40-minute build removes a false stall and unions overlapping work once per Session without changing old scoring.",
  catches: ["arbitrary PID manufactures work", "registration retry extends its deadline", "finished or expired work keeps growing", "background tools count as multiple Agents", "remote clocks are subtracted", "measurement foundation silently changes tq/2"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/run.py task job", "tools/run.py quality facts", "tools/run.py quality execution", "session.inspect", "process.list"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 15000, timeoutMs: 150000,
}, async t => {
  const r = await openTeam(t, "execution-observability", [{ id: "ctl-cli-command", profile: "cli-command", commandProcess: true }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let sequence=0;
    const invoke = async (sid: string, argv: string[]) => {
      const requestId="quality-execution."+(++sequence);
      await r.send(sid, JSON.stringify({ argv, cwd: r.root, requestId })); await idle(sid);
      const m = (await r.snapshot(sid)).items.filter(x => {
        if(x.type!=="assistantMessage")return false;
        try{return JSON.parse(x.text).requestId===requestId;}catch{return false;}
      }).at(-1);
      if (m?.type !== "assistantMessage") throw new Error("real Agent returned no command result");
      return JSON.parse(m.text) as { code: number; out: string; err: string };
    };
    const cli = async (sid: string, args: string[]) => {
      const v = await invoke(sid, [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args]);
      t.assertions.assert(v.code === 0, v.out+v.err); return JSON.parse(v.out.trim().split("\n").at(-1)!);
    };
    const front = await r.create("ctl-cli-command");
    const task = await cli(front, ["task", "start", "--space", "leader", "--desc", "measure native work", "--request-id", "execution.task", "Observe bounded independent work"]);
    const owner = task.owner.sessionId as string; await idle(owner);
    const support = await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "independent PID check", "--request-id", "execution.pid-check", "Check an independent observation"]);
    await idle(support.collaborator);
    const script = join(r.root, "actual-process-probe.py");
    writeFileSync(script, `import json,subprocess,sys,time,os\nfrom pathlib import Path\nroot=Path(${JSON.stringify(r.root)})\nbase=[sys.executable,str(root/'tools/run.py'),'task','job']\ntask=${JSON.stringify(task.taskId)}\nmarker='execution-native-proof.'+os.environ['GENEHUB_SESSION_ID']\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(15)',marker],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\ndef call(action,*args):\n r=subprocess.run(base+[action,task,'--job-id','native-build']+list(args),capture_output=True,text=True)\n return {'code':r.returncode,'value':json.loads(r.stdout) if r.returncode==0 else None,'errorFlags':[w for w in ('PID','native','所属','unrecognized','KeyError','TypeError','not found') if w in r.stderr]}\ntry:\n deadline=time.monotonic()+5\n matched=[];native=[]\n while not matched and time.monotonic()<deadline:\n  inventory=subprocess.run([os.environ['GENEHUB_CLI'],'process','list'],capture_output=True,text=True,check=True)\n  native=json.loads(inventory.stdout)['data']['processes']\n  matched=[x for x in native if x.get('sessionId')==os.environ['GENEHUB_SESSION_ID'] and marker in x.get('command','')]\n  if not matched:time.sleep(.02)\n if not matched:raise RuntimeError('NoNativeWorkProcess: total='+str(len(native))+'; own='+str(sum(x.get('sessionId')==os.environ['GENEHUB_SESSION_ID'] for x in native))+'; marker='+str(sum(marker in x.get('command','') for x in native)))\n nativePid=matched[0]['pid']\n args=['--pid',str(nativePid),'--kind','build','--max-seconds','2']\n first=call('register',*args)\n duplicate=call('register',*args)\n conflict=call('register',*args[:-1],'3')\n liveFinish=call('finish','--exit-code','0')\n time.sleep(2.05)\n observed=call('status')\n (root/'native-work-pid.json').write_text(json.dumps({'pid':nativePid,'osChildPid':p.pid,'sid':os.environ.get('GENEHUB_SESSION_ID')}))\n # The original parent reaps its actual child; no process signalling or broad cleanup.\n p.wait(timeout=20)\n finish=call('finish','--exit-code','0')\n repeated=call('finish','--exit-code','0')\n changed=call('finish','--exit-code','1')\n print(json.dumps({'first':first,'duplicate':duplicate,'conflict':conflict,'liveFinish':liveFinish,'observed':observed,'finish':finish,'repeated':repeated,'changed':changed,'pid':nativePid,'osChildPid':p.pid}))\nfinally:\n p.wait(timeout=20)\n`);
    let early: {code:number;out:string;err:string}|undefined;
    const running = invoke(owner, [process.env.GENEHUB_PYTHON!, script]).then(value=>{early=value;return value;});
    await t.tools.waitUntil(() => {
      try { return early!==undefined || JSON.parse(readFileSync(join(r.root, "native-work-pid.json"), "utf8")).pid > 0; } catch { return early!==undefined; }
    }, 20000);
    if(early)t.assertions.assert(early.code===0,"native work probe failed before PID evidence: "+early.err);
    const livePid = JSON.parse(readFileSync(join(r.root, "native-work-pid.json"), "utf8")).pid;
    const foreign = await invoke(support.collaborator, [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "task", "job", "register", task.taskId, "--job-id", "foreign-process", "--pid", String(livePid), "--kind", "build", "--max-seconds", "30"]);
    t.assertions.assert(foreign.code !== 0, "a task member claimed a different Session's live process");
    const probe = await running;
    t.assertions.assert(probe.code === 0, probe.out+probe.err);
    const p = JSON.parse(probe.out);
    t.assertions.assert(p.first.code === 0 && p.duplicate.code === 0 && p.first.value.jobId === p.duplicate.value.jobId && p.first.value.registeredAtMs === p.duplicate.value.registeredAtMs && p.first.value.deadlineAtMs === p.duplicate.value.deadlineAtMs, "original registration was extended or replaced by retry: "+JSON.stringify(p));
    t.assertions.assert(p.conflict.code !== 0 && p.liveFinish.code !== 0 && p.changed.code !== 0, "changed intent or premature finish was accepted");
    t.assertions.assert(p.observed.value.observedThroughAtMs === p.first.value.deadlineAtMs && p.finish.code === 0 && p.repeated.code === 0, "native work interval or reaped process conclusion missing");
    // A different real Session cannot register the departed PID, and cannot
    // impersonate a task member even when it knows the stable job identifier.
    const outsider = await r.create("ctl-cli-command");
    const bad = await invoke(outsider, [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "task", "job", "register", task.taskId, "--job-id", "foreign", "--pid", String(p.pid), "--kind", "build", "--max-seconds", "30"]);
    t.assertions.assert(bad.code !== 0, "nonmember manufactured task work");
    const facts = JSON.parse(r.ok(["quality", "facts"]));
    const intent = readdirSync(r.state("task-dispatch")).map(f => JSON.parse(readFileSync(r.state("task-dispatch", f), "utf8"))).find(x => x.sessionId === owner);
    const item = facts.workItems.find((x: any) => x.id === intent.operationId);
    const incoming = await r.client.call({ type: "session.inspect", payload: { sessionId: owner, throughRoundId: null } });
    if (incoming?.type !== "sessionInspection") throw new Error("native input inspection missing");
    const receipt = incoming.data.retainedInputs?.find(x => x.messageId === intent.operationId);
    if (!receipt) throw new Error("original activation receipt missing");
    t.assertions.assert(facts.executionFacts?.backgroundRunsAppliedToScore === true
      && facts.executionBasis === "registered-native-execution-union/2"
      && facts.r6Basis === "acceptance-unit-agent-hours/4" && item.dispatchTiming?.schema === "team-dispatch-timing/1", "formal execution omitted its version or timing provenance");
    const timing = item.dispatchTiming;
    t.assertions.assert(timing.sessionStart.inputReceivedAtMs === receipt.receivedAtMs && timing.sessionStart.durationMs === item.startedAtMs-receipt.receivedAtMs && timing.platformPreparation.durationMsUpperBound >= 0 && timing.additive === false, "dispatch segments guessed a clock or lost native input/start provenance");
    const nativeRuns = facts.taskTrees.find((x: any) => x.taskId === task.taskId).sessions.find((x: any) => x.sessionId === owner).backgroundRuns;
    t.assertions.assert(nativeRuns.length > 0 && nativeRuns.every((x: any) => x.endAtMs <= p.observed.value.observedThroughAtMs && x.basis === "registered-native-process-runtime/1"), "a finished job gained unobserved execution time");
    const start = 1700000000000, minute = 60000;
    const job = (a: number, b: number, id: string) => ({ startAtMs: start+a*minute, endAtMs: start+b*minute, jobId: id, basis: "registered-native-process-runtime/1" });
    const frozen: any = { schema: "team-quality-facts/1", window: { startAtMs: start, endAtMs: start+60*minute },
      taskTrees: [{ taskId: "build40", openedAtMs: start, endedAtMs: start+60*minute, excluded: [], sessions: [
        { sessionId: "owner", readable: true, runs: [{ startAtMs: start, endAtMs: start+10*minute }], backgroundRuns: [job(5,45,"build"),job(5,45,"duplicate-observation")] },
        { sessionId: "support", readable: true, runs: [{ startAtMs: start, endAtMs: start+60*minute }], backgroundRuns: [] }] }],
      stalls: [{ taskId: "build40", startAtMs: start+10*minute, endAtMs: start+45*minute }], workItems: [] };
    const file = join(r.root, "frozen-execution.json");
    const project = (value: any) => { writeFileSync(file, JSON.stringify(value)); return JSON.parse(r.ok(["quality", "execution", "--snapshot", file])); };
    const measured = project(frozen);
    t.assertions.assert(measured.officialCapture === false && measured.stalls.length === 0 && measured.taskParallelism[0].agentMs === 105*minute && measured.taskParallelism[0].low === 1.75, "40-minute background build was stalled, ignored, or counted as extra Agents");
    const paused = structuredClone(frozen); paused.taskTrees[0].excluded = [{ startAtMs: start+20*minute, endAtMs: start+30*minute }];
    const controlled = project(paused).taskParallelism[0];
    t.assertions.assert(controlled.hourEffectiveMs === 50*minute && controlled.agentMs === 85*minute, "background work inflated paused task time");
    const unregistered = structuredClone(frozen); delete unregistered.taskTrees[0].sessions[0].backgroundRuns;
    t.assertions.assert(project(unregistered).stalls.length === 1, "unregistered background service erased a stall");
    const forged = structuredClone(frozen); forged.taskTrees[0].sessions[0].backgroundRuns[0].basis = "claimed-by-text";
    writeFileSync(file, JSON.stringify(forged));
    t.assertions.assert(r.command(["quality", "execution", "--snapshot", file]).code !== 0, "unknown work evidence silently became native execution");
    t.note("Actual native process registration/observation/exit and native input timestamps; separately labelled frozen 40-minute algebra, no official card or quality80 claim.");
  } finally { await r.dispose(); }
});

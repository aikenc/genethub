import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, connectProductClient, registerControlledAgent, parseJson, runGenetAsync, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-remote-dispatch",
  title: "Fixed team targets dispatch once and hold the executor's writer lock until reconciliation",
  oracle: "Two real daemon directories communicate through a real relay: a lost successful receiver stdout recovers the same session, competing writer and changed identity are rejected, target model/media are validated before a writer lock, system notices preserve pause, an unreachable ledger entry cannot block another completion and executor lock release; a >8KiB task and restored 300-reference coordination snapshot reach the real remote runtime",
  catches: ["same role short name routes to another team", "two callers write one directory", "lost reply creates duplicate session", "caller model leaks remotely", "remote notice lifts Human pause", "one offline task aborts reconciliation", "a declared remote role is rerouted by --machine or silently runs locally", "an executor accepts a role not installed for it", "remote install needs hand-written paths or scripts", "JSON business content exceeds the small command head", "Timer success hides a failed remote projection"],
  stages: ["initial-result", "resumed-result", "paused-reservation", "resumed-release"],
  tags: ["core", "expert", "team-remote"], llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/team.py", "genet-cli", "@genehub/workbench/client"],
  surfaces: ["team-template", "daemon", "relay", "filesystem"],
  expectedDurationMs: 30000, timeoutMs: 360000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 2, browser: 0, pool: "standard" },
}, async t => {
  const python = process.env.GENEHUB_PYTHON!;
  const commandAgent = registerControlledAgent(t.env, { id: "ctl-cli-command", profile: "cli-command" });
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const sourceData = path.join(t.env.root, "caller-data"); mkdirSync(sourceData);
  const sourceEnv = { ...o.daemon.env, GENEHUB_DATA_DIR: sourceData, GENEHUB_LOCAL_DATA_DIR: sourceData, GENEHUB_CLI: o.daemon.genet };
  const sourceCli = (args: string[]) => runGenetAsync(o.daemon.genet, args, sourceEnv);
  const cliJson = async (args: string[], remote = false): Promise<any> => {
    const r = await (remote ? runGenetAsync(o.daemon.genet, args, o.daemon.env) : sourceCli(args));
    if (r.code !== 0) throw new Error(`CLI ${remote ? "executor" : "source"} ${args.slice(0, 2).join(" ")} failed (${r.code}): ${r.stderr.slice(-500)} ${r.stdout.slice(-500)}`);
    return (parseJson(r.stdout) as any).data;
  };
  const team = async (name: string, target: boolean) => {
    const root = path.join(t.env.root, name);
    cpSync(path.join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template"), root, { recursive: true });
    // A valid customized team with no identity/timer, isolating the dispatch contract.
    for (const dir of [root, ...readdirSync(path.join(root, "spaces")).map(r => path.join(root, "spaces", r))]) {
      const file = path.join(dir, "agent-space.genet.json"); if (!existsSync(file)) continue;
      const descriptor = JSON.parse(readFileSync(file, "utf8"));
      Object.assign(descriptor, { skills: [], skillProviders: [] });
      delete descriptor.identity; delete descriptor.agentCwd;
      if (dir === root) Object.assign(descriptor, { name });
      writeFileSync(file, JSON.stringify(descriptor));
    }
    mkdirSync(path.join(root, ".genethub"), { recursive: true });
    writeFileSync(path.join(root, ".genethub/open.env"), "TEAM_AGENT=genet\nTEAM_BOARD_PORT=0\n" + (target ? "" : "TEAM_MODEL_WORK=caller-only-model\n"));
    const built = spawnSync(python, [path.join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py"), "build", root], { env: o.daemon.env, encoding: "utf8" });
    t.assertions.assert(built.status === 0, "team build failed: " + built.stdout + built.stderr);
    await cliJson(["space", "open", root], target);
    return root;
  };
  let sourceStarted = false;
  let sourceClient: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    await o.client.call({ type: "settings.setProvider", payload: { providerId: "deepseek", apiKey: "sk-test", baseUrl: o.mock.origin, label: null, dialect: null, models: ["deepseek-v4-flash", "deepseek-v4-pro", "text-only"], modelInputs: { "deepseek-v4-flash": ["image", "video"], "deepseek-v4-pro": ["image", "video"], "text-only": [] } } });
    cpSync(path.join(t.env.data, "agents"), path.join(sourceData, "agents"), { recursive: true });
    if ((await sourceCli(["daemon", "start"])).code !== 0) throw new Error("caller daemon failed to start");
    sourceStarted = true;
    const targetRoot = await team("remote-team", true), sourceRoot = await team("source-team", false);
    const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("target relay attach failed");
    await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 20000);
    const invite = await o.client.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("invite failed");
    const otherRoot = await team("other-team", true);
    const paired = await cliJson(["machine", "pair", invite.data.code, "--endpoint", attached.data.rendezvousUrl, "--name", "team-caller"]);
    const machine = paired.machine.machineId;
    const listed = await cliJson(["workspace", "list"], true);
    const qa = listed.workspaces.find((w: any) => w.folders?.[0]?.root === path.join(targetRoot, "spaces/qa"));
    if (!qa) throw new Error("target QA not registered");
    const otherQa = listed.workspaces.find((w: any) => w.folders?.[0]?.root === path.join(otherRoot, "spaces/qa"));
    if (!otherQa) throw new Error("other team QA not registered");
    // An execution wrapper drops one successful reply at the external process boundary.
    // The real receiver and all durable effects run unchanged.
    const wrapper = path.join(targetRoot, "lose-one-reply.py"), dropped = path.join(targetRoot, "reply-dropped");
    const correctionMarker = path.join(targetRoot, "correct-before-release");
    const compatibilityMarker = path.join(targetRoot, "old-receiver-grammar");
    writeFileSync(wrapper, `import argparse,json,os,pathlib,subprocess,sys,time
compat=pathlib.Path(${JSON.stringify(compatibilityMarker)})
if compat.exists():
 if compat.read_text()=='unrelated':
  print('receiver: error: unrecognized arguments: --unrelated fixture-stderr-must-not-leak',file=sys.stderr)
  sys.exit(2)
 # External old CLI grammar: reject unknown mandatory flags before delegating
 # to the unchanged real receiver. No canned successful reply or state write.
 parser=argparse.ArgumentParser()
 parser.add_argument('entry');parser.add_argument('operation');parser.add_argument('payload')
 parser.parse_args(sys.argv[1:])
payload=sys.argv[sys.argv.index('receive')+1]
body=sys.stdin.read() if payload=='-' else None
q=json.loads(body if body is not None else payload); race=pathlib.Path(${JSON.stringify(correctionMarker)})
def summary():
 r=subprocess.run([os.environ['GENEHUB_CLI'],'session','get',q['sessionId']],capture_output=True,text=True)
 return json.loads(r.stdout.strip().splitlines()[-1])['data']['summary']
if q.get('operation') == 'release' and race.exists():
 race.unlink(); before=(summary().get('latestReply') or {}).get('itemId')
 note={**q,'operation':'notice','purpose':'task','sender':'concurrent-source','text':'Finish the corrected requirement.','messageId':'x.release-correction'}
 sent=subprocess.run([sys.executable,sys.argv[1],'receive',json.dumps(note)],capture_output=True,text=True)
 if sent.returncode: raise RuntimeError('correction was not admitted')
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  s=summary()
  if s['status']=='idle' and not (s.get('inputSummary') or {}).get('pendingMessageIds') and (s.get('latestReply') or {}).get('itemId') != before: break
  time.sleep(.02)
 else: raise RuntimeError('correction did not finish')
r=subprocess.run([sys.executable,*sys.argv[1:]],input=body,capture_output=True,text=True)
p=pathlib.Path(${JSON.stringify(dropped)})
if r.returncode == 0 and not p.exists():
 p.write_text('lost')
 sys.exit(0)
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
`);
    const binding = { machineId: machine, workspaceId: qa.id, command: [python, wrapper, path.join(targetRoot, "tools/team.py")] };
    const bind = (target: typeof binding) => {
      const file=path.join(sourceRoot,"agent-space.genet.json"), descriptor=JSON.parse(readFileSync(file,"utf8"));
      descriptor.members=[{name:"qa",...target}]; writeFileSync(file,JSON.stringify(descriptor));
    };
    // A stale legacy binding must not override the canonical project reference.
    writeFileSync(path.join(sourceRoot,".genethub/remote-targets.json"),JSON.stringify({qa:{...binding,workspaceId:otherQa.id}}));
    bind(binding);
    // Editing membership must remain compatible with the actual team build,
    // before any remote business command is attempted.
    const rebuilt = spawnSync(python,[path.join(t.openRoot,"apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py"),"build",sourceRoot],{env:sourceEnv,encoding:"utf8"});
    t.assertions.assert(rebuilt.status===0,"cross-machine metadata broke team rebuild: "+rebuilt.stdout+rebuilt.stderr);
    // External descriptor writers converge through discovery, without a list-time file read.
    await t.tools.waitUntil(async () => (await cliJson(["workspace","list"])).workspaces.find((w:any)=>w.folders?.[0]?.root===sourceRoot)?.agentSpace?.members?.some((m:any)=>m.workspaceId===qa.id&&m.machineId===machine), 10000);
    const members=(await cliJson(["workspace","list"])).workspaces.find((w:any)=>w.folders?.[0]?.root===sourceRoot)?.agentSpace?.members;
    t.assertions.assert(members?.length===1&&members[0].workspaceId===qa.id&&members[0].machineId===machine&&!Object.hasOwn(members[0],"command"),"build lost the exact remote reference or exposed executor commands");
    const script = (args: string[], extra: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(python, ["tools/team.py", ...args], { cwd: sourceRoot, env: { ...sourceEnv, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    const dispatch = ["spawn", "--kind", "work", "--space", "qa", "--machine", machine, "--request-id", "one-task", "--desc", "remote contract", "Complete the check. " + "Remote business requirement. ".repeat(800)];
    o.mock.script({ text: "First remote result." }, { text: "Resumed remote result." }, { text: "Queued notice result." });
    const lost = await script(dispatch);
    t.assertions.assert(lost.code !== 0 && lost.stderr.includes("未确认") && existsSync(dropped), "missing reply was not reported as uncertain after actual execution: " + lost.stderr);
    const recovered = await script(dispatch);
    t.assertions.assert(recovered.code === 0, "receipt recovery failed: " + recovered.stderr);
    const pendingDir = path.join(sourceRoot, ".genethub/team/pending"), files = readdirSync(pendingDir).filter(f => f.endsWith(".json"));
    t.assertions.assert(files.length === 1, "one dispatch generated multiple pending sessions");
    const pendingPath = path.join(pendingDir, files[0]!), record = JSON.parse(readFileSync(pendingPath, "utf8"));
    const sessions = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions;
    t.assertions.assert(sessions.length === 1 && sessions[0].id === record.sessionId && sessions[0].modelId !== "caller-only-model", "receipt retry created a duplicate or inherited caller model");
    const lock = path.join(targetRoot, "spaces/qa/.genethub/genet-writer.json");
    t.assertions.assert(JSON.parse(readFileSync(lock, "utf8")).session === record.sessionId, "writer marker is missing on executor");
    const localBusy = spawnSync(python, ["tools/team.py", "spawn", "--kind", "work", "--space", "qa", "--dir", path.join(targetRoot, "spaces/qa"), "--desc", "local competitor", "Try this directory."], { cwd: targetRoot, env: { ...o.daemon.env, GENEHUB_CLI: o.daemon.genet }, encoding: "utf8" });
    t.assertions.assert(localBusy.status !== 0 && localBusy.stderr.includes("远端派单锁定"), "local writer stole the remote reservation");
    const busy = await script(dispatch.map(v => v === "one-task" ? "competing-task" : v));
    t.assertions.assert(busy.code !== 0 && busy.stderr.includes("写锁"), "second writer was admitted");
    const changed = await script([...dispatch.slice(0, -1), "Different task."]);
    t.assertions.assert(changed.code !== 0 && changed.stderr.includes("不同内容"), "dispatch identity accepted changed content");
    const wrong = await script([...dispatch.slice(0, -1), "--workspace", "w_wrong", "Complete the check."]);
    t.assertions.assert(wrong.code !== 0 && wrong.stderr.includes("固定绑定"), "explicit workspace bypassed fixed binding");
    bind({...binding,workspaceId:otherQa.id});
    const wrongTeam = await script(dispatch.map(v => v === "one-task" ? "other-team-task" : v));
    t.assertions.assert(wrongTeam.code !== 0 && wrongTeam.stderr.includes("不属于"), "receiver accepted another team's same-named role");
    bind(binding);
    const badModel = await script([...dispatch.slice(0, -1).map(v => v === "one-task" ? "bad-model" : v), "--model", "missing-model", "Complete the check."]);
    t.assertions.assert(badModel.code !== 0 && badModel.stderr.includes("没有模型"), "missing target model reached creation");
    const badMedia = await script([...dispatch.slice(0, -1).map(v => v === "one-task" ? "bad-media" : v), "--model", "deepseek/text-only", "--media", "image", "Complete the check."]);
    t.assertions.assert(badMedia.code !== 0 && badMedia.stderr.includes("支持"), "text-only target model accepted an image task");
    await t.stage("initial-result", () => t.tools.waitUntil(async () => {
      const snapshot = await cliJson(["session", "get", record.sessionId], true);
      if (snapshot.summary.status === "failed" || snapshot.summary.inputSummary?.error) throw new Error("initial remote execution failed: " + JSON.stringify(snapshot.summary));
      return snapshot.summary.status === "idle" && !!snapshot.summary.latestReply;
    }, 30000));
    const initialReply = (await cliJson(["session", "get", record.sessionId], true)).summary.latestReply.itemId;
    await o.client.call({ type: "session.interrupt", payload: { sessionId: record.sessionId } });
    const beforeConflict = (await cliJson(["session", "get", record.sessionId], true)).summary.inputSummary.pendingMessageIds;
    const mismatchedSend = await script(["send", "--machine", machine, "--workspace", otherQa.id, "--to", record.sessionId, "Must not reach a different workspace."]);
    t.assertions.assert(mismatchedSend.code !== 0 && mismatchedSend.stderr.includes("workspace"), "exact session ID silently ignored a conflicting workspace selector");
    const emptySend = await script(["send", "--machine", machine, "--workspace", "", "--to", record.sessionId, "Must not ignore an empty workspace selector."]);
    t.assertions.assert(emptySend.code !== 0 && emptySend.stderr.includes("workspace"), "exact session ID silently ignored an empty workspace selector");
    const emptySpawn = await script([...dispatch.slice(0, -1), "--workspace", "", "Complete the check."]);
    t.assertions.assert(emptySpawn.code !== 0 && emptySpawn.stderr.includes("workspace"), "spawn silently ignored an empty workspace selector");
    const intentsBeforeInvalid = readdirSync(path.join(sourceRoot, ".genethub/team/dispatch")).sort();
    const emptyMachine = await script(dispatch.map(v => v === machine ? "" : v));
    t.assertions.assert(emptyMachine.code !== 0 && emptyMachine.stderr.includes("--machine") && emptyMachine.stderr.includes("空"), "empty machine fell back to local execution or requested removal of the retry identity");
    for (const invalidId of ["", "x".repeat(201)]) {
      const invalid = await script(dispatch.map(v => v === "one-task" ? invalidId : v));
      t.assertions.assert(invalid.code !== 0 && invalid.stderr.includes("--request-id"), "invalid retry identity generated a new dispatch");
    }
    t.assertions.assert(JSON.stringify(intentsBeforeInvalid) === JSON.stringify(readdirSync(path.join(sourceRoot, ".genethub/team/dispatch")).sort()), "invalid remote options wrote new dispatch intents");
    const afterConflict = (await cliJson(["session", "get", record.sessionId], true)).summary.inputSummary.pendingMessageIds;
    t.assertions.assert(JSON.stringify(beforeConflict) === JSON.stringify(afterConflict), "rejected workspace selector queued a remote message");
    const sent = await script(["send", "--machine", machine, "--workspace", qa.id, "--to", record.sessionId, "Queued while paused."]);
    t.assertions.assert(sent.code === 0 && (await cliJson(["session", "get", record.sessionId], true)).summary.inputSummary.paused, "remote send lifted Human pause");
    await t.flows.main.sendPrompt(o.client, record.sessionId, "Resume the task.", null, "u_remote_resume");
    await t.stage("resumed-result", () => t.tools.waitUntil(async () => {
      const s = (await cliJson(["session", "get", record.sessionId], true)).summary;
      if (s.status === "failed" || s.inputSummary?.error) throw new Error("resumed remote execution failed: " + JSON.stringify(s));
      return s.status === "idle" && !s.inputSummary.paused && s.inputSummary.pendingMessageIds.length === 0 && !!s.latestReply && s.latestReply.itemId !== initialReply;
    }, 30000));
    // Recover a ledger whose other target is no longer paired. No internal functions are replaced.
    const offline = { ...record, sessionId: "s_0000000000000000", machine: "m_missing", batch: "offline", remoteDispatch: undefined };
    writeFileSync(path.join(pendingDir, "000-offline.json"), JSON.stringify(offline));
    o.mock.script({ text: "Corrected task result." });
    writeFileSync(correctionMarker, "inject once");
    const raced = await script(["hook"]);
    t.assertions.assert(raced.code === 0 && existsSync(pendingPath) && existsSync(lock), "reconciliation retired an obsolete reply after a concurrent correction");
    const releaseStartedAt = Date.now();
    const hook = await script(["hook"]);
    t.assertions.assert(hook.code === 0, "one unreachable target aborted hook: " + hook.stderr);
    t.assertions.assert(existsSync(path.join(sourceRoot, ".genethub/team/done", files[0]!)) && !existsSync(lock), "successful independent task did not close and release target lock");
    const archived = JSON.parse(readFileSync(path.join(sourceRoot, ".genethub/team/done", files[0]!), "utf8"));
    t.assertions.assert(archived.done.reply === (await cliJson(["session", "get", record.sessionId], true)).summary.latestReply.itemId, "reconciliation delivered the earlier reply instead of the latest corrected result");
    t.assertions.assert(JSON.parse(readFileSync(path.join(pendingDir, "000-offline.json"), "utf8")).lastReconcileError, "offline task lost its retry evidence");
    const targetDispatchDir = path.join(targetRoot,"spaces/qa/.genethub/team/dispatch");
    const targetReceipt = (id:string) => JSON.parse(readFileSync(path.join(targetDispatchDir,createHash("sha256").update(id).digest("hex")+".json"),"utf8"));
    const normalRelease = targetReceipt("one-task");
    t.assertions.assert(Number.isFinite(normalRelease.leaseReleasedAtMs) && normalRelease.leaseReleasedAtMs >= releaseStartedAt && normalRelease.leaseReleasedAtMs <= Date.now(),"actual executor unlink lacks an exact bounded release clock");
    t.assertions.assert(Number.isFinite(normalRelease.resourceReleasedAtMs) && normalRelease.resourceReleasedAtMs >= normalRelease.leaseReleasedAtMs && normalRelease.resourceReleasedAtMs <= Date.now(), "remote release lacks contemporaneous process-and-lease proof");
    const releaseEvents = () => readFileSync(path.join(sourceRoot,".genethub/team/events/events.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const provenRelease = releaseEvents().filter(e=>e.kind==="resource-released"&&e.sessionId===record.sessionId);
    t.assertions.assert(provenRelease.length===1 && provenRelease[0].atMs===normalRelease.resourceReleasedAtMs,"source lost or backdated executor resource proof before any hourly capture");
    const replayRelease = (id:string,sid:string) => {
      const request={id,workspaceId:qa.id,role:"qa",operation:"release",sessionId:sid};
      const r=spawnSync(python,["tools/team.py","receive",JSON.stringify(request)],{cwd:targetRoot,env:{...o.daemon.env,GENEHUB_CLI:o.daemon.genet},encoding:"utf8"});
      t.assertions.assert(r.status===0,"public release replay failed: "+r.stdout+r.stderr);
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    };
    t.assertions.assert(replayRelease("one-task",record.sessionId).leaseReleasedAtMs===normalRelease.leaseReleasedAtMs,"release replay changed an observed unlink clock");
    t.assertions.assert(replayRelease("one-task",record.sessionId).resourceReleasedAtMs===normalRelease.resourceReleasedAtMs,"release replay changed the original resource observation");
    // A receiver that crashed before recording a session ID must never retry creation.
    const intentDir = path.join(sourceRoot, ".genethub/team/dispatch");
    const intent = readdirSync(intentDir).map(f => JSON.parse(readFileSync(path.join(intentDir, f), "utf8"))).find(v => v.request.id === "one-task");
    const unknown = { ...intent.request, id: "unknown-create" };
    writeFileSync(path.join(targetRoot, "spaces/qa/.genethub/team/dispatch", createHash("sha256").update(unknown.id).digest("hex") + ".json"), JSON.stringify({ request: unknown, status: "unknown", lock: null }));
    const uncertain = await script(dispatch.map(v => v === "one-task" ? "unknown-create" : v));
    t.assertions.assert(uncertain.code !== 0 && uncertain.stderr.includes("unknown"), "unknown create was retried");
    t.assertions.assert((await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length === 1, "uncertain creation spawned another session");
    const corruptId = "corrupt-create";
    const corruptPath = path.join(targetRoot, "spaces/qa/.genethub/team/dispatch", createHash("sha256").update(corruptId).digest("hex") + ".json");
    writeFileSync(corruptPath, "{broken");
    const corrupt = await script(dispatch.map(v => v === "one-task" ? corruptId : v));
    t.assertions.assert(corrupt.code !== 0 && corrupt.stderr.includes("无法读取") && readFileSync(corruptPath, "utf8") === "{broken", "corrupt creation receipt was treated as absence");
    writeFileSync(corruptPath, "{}");
    const empty = await script(dispatch.map(v => v === "one-task" ? corruptId : v));
    t.assertions.assert(empty.code !== 0 && readFileSync(corruptPath, "utf8") === "{}", "empty creation receipt was treated as absence");
    const afterRelease = await script(["send", "--machine", machine, "--to", record.sessionId, "Start another task in the old session."]);
    t.assertions.assert(afterRelease.code !== 0 && afterRelease.stderr.includes("派单回执"), "send restarted a session after releasing its writer lease");
    // A new spawn without an explicit retry ID must not reuse yesterday's
    // completed result merely because its task wording is identical.
    o.mock.script({ tool: { name: "bash", arguments: { command: "sleep 60 > /dev/null 2>&1 & echo $! > release-child.pid" } } }, { text: "Fresh first task." }, { text: "Fresh repeated task." });
    const freshArgs = dispatch.filter(v => v !== "--request-id" && v !== "one-task");
    const freshSessions: string[] = [];
    for (let n = 0; n < 2; n++) {
      const fresh = await script(freshArgs);
      t.assertions.assert(fresh.code === 0 && fresh.stdout.includes("派单编号:"), "new spawn did not expose its recovery identity: " + fresh.stderr);
      const dispatchId = fresh.stdout.match(/^派单编号: ([^\s]+)$/m)?.[1];
      t.assertions.assert(!!dispatchId,"new spawn omitted its exact operation identity");
      const taskFile = readdirSync(pendingDir).find(f => f.endsWith(".json") && JSON.parse(readFileSync(path.join(pendingDir,f),"utf8")).remoteDispatch?.id === dispatchId);
      t.assertions.assert(!!taskFile, "new spawn returned an archived receipt instead of a new task");
      const task = JSON.parse(readFileSync(path.join(pendingDir, taskFile!), "utf8"));
      const receipt = JSON.parse(readFileSync(path.join(intentDir,createHash("sha256").update(dispatchId!).digest("hex")+".json"),"utf8"));
      t.assertions.assert(task.sessionId===receipt.receipt.sessionId && task.remoteDispatch.target.workspaceId===qa.id && task.remoteDispatch.target.machineId===machine,"fresh task evidence belongs to another operation or source");
      freshSessions.push(task.sessionId);
      await t.tools.waitUntil(async () => { const s = (await cliJson(["session", "get", task.sessionId], true)).summary; return s.status === "idle" && !!s.latestReply; }, 30000)
        .catch(async () => { throw new Error("fresh task did not finish: " + JSON.stringify((await cliJson(["session", "get", task.sessionId], true)).summary)); });
      if(n===0) {
        const childPid=Number(readFileSync(path.join(targetRoot,"spaces/qa/release-child.pid"),"utf8").trim());
        process.kill(childPid,0);
        const inventory=await o.client.call({type:"process.list"});
        t.assertions.assert(inventory?.type==="processes" && inventory.data.some(p=>p.pid===childPid&&p.sessionId===task.sessionId),"fixture did not retain an actual owned remote process");
        try {
          const held=await script(["hook"]);
          t.assertions.assert(held.code===0 && existsSync(path.join(pendingDir,taskFile!)) && existsSync(lock) && !targetReceipt(dispatchId!).released,"remote release ignored an owned live process");
          t.assertions.assert(!releaseEvents().some(e=>e.kind==="resource-released"&&e.sessionId===task.sessionId),"live process was falsely recorded as returned");
        } finally {
          await o.client.call({type:"process.killAll",payload:{sessionId:task.sessionId}});
        }
        await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"process.list"});return r?.type==="processes"&&!r.data.some(p=>p.sessionId===task.sessionId);},10000);
      }
      // Real OS fault: a prior actor removed this completed task's marker.
      // Absence proves at most an upper bound, not when this receiver unlinked it.
      if(n===1) unlinkSync(lock);
      const observedAfter=Date.now();
      const finished = await script(["hook"]);
      t.assertions.assert(finished.code === 0 && !existsSync(lock), "fresh task did not retire its own writer lock");
      const released=targetReceipt(dispatchId!);
      if(n===0) {
        t.assertions.assert(Number.isFinite(released.leaseReleasedAtMs),"ordinary fresh release omitted its observed unlink clock");
        t.assertions.assert(Number.isFinite(released.resourceReleasedAtMs) && released.resourceReleasedAtMs>=observedAfter && released.resourceReleasedAtMs<=Date.now(),"resource return was not bounded by this actual release check");
      }
      else {
        t.assertions.assert(released.leaseReleasedAtMs==null,"pre-existing lease absence invented an exact release time");
        t.assertions.assert(replayRelease(dispatchId!,task.sessionId).leaseReleasedAtMs==null,"release replay manufactured a missing unlink clock");
        t.assertions.assert(released.resourceReleasedAtMs==null && replayRelease(dispatchId!,task.sessionId).resourceReleasedAtMs==null,"prior marker absence manufactured a complete historical resource proof");
        t.assertions.assert(!releaseEvents().some(e=>e.kind==="resource-released"&&e.sessionId===task.sessionId),"source made up a resource event for an already-absent marker");
      }
    }
    t.assertions.assert(freshSessions[0] !== freshSessions[1] && (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length === 3, "same-worded new task reused an old session");
    const beforeSlowRequest = o.mock.requests.length;
    o.mock.script({ text: "A slow remote result.", delayMs: 30000 }, { text: "Resumed worker." });
    const concurrent = await Promise.all(["racer-a", "racer-b"].map(id => script(dispatch.map(v => v === "one-task" ? id : v))));
    t.assertions.assert(concurrent.filter(r => r.code === 0).length === 1 && (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length === 4, "concurrent callers admitted zero or multiple writers");
    const raceSession = JSON.parse(readFileSync(lock, "utf8")).session;
    // A person's stop pauses the task rather than abandoning its directory.
    // Quiet workers are no longer canceled automatically. Keep the reservation
    // until this same task is explicitly continued and actually completes.
    await t.tools.waitUntil(() => o.mock.requests.length > beforeSlowRequest, 15000);
    await cliJson(["session", "interrupt", raceSession, "--machine", machine]);
    const peerErrors = (data: string) => {
      const file = path.join(data, "logs/daemon.log");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(line => /peer|admission|dataplane|transport/i.test(line)).slice(-12).map(line => {
        try {
          const value = JSON.parse(line), fields = value.fields ?? value;
          return Object.fromEntries(["level", "message", "event", "error", "reason", "code"].filter(k => fields[k] != null).map(k => [k, String(fields[k]).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(0, 300)]));
        } catch { return "non-JSON diagnostic omitted"; }
      });
    };
    let lastReleaseState: unknown;
    await t.stage("paused-reservation", async () => {
      await t.tools.waitUntil(async () => {
        const s = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.find((s: any) => s.id === raceSession);
        return s?.status === "idle" && s?.inputSummary?.paused;
      }, 30000);
      const pausedHook = await script(["hook"]);
      t.assertions.assert(pausedHook.code === 0 && existsSync(lock), "paused writer lost its reservation");
      t.assertions.assert(JSON.parse(readFileSync(lock, "utf8")).session === raceSession, "paused reservation changed owner");
      const paused = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.find((s: any) => s.id === raceSession);
      t.assertions.assert(paused?.inputSummary?.paused && paused.inputSummary.pendingMessageIds.length > 0, "reconciliation resumed or discarded paused input");
    });
    await cliJson(["session", "send", raceSession, "Continue the same paused task and finish it.", "--message-id", "x.resume-reserved-writer", "--no-wait", "--machine", machine]);
    await t.stage("resumed-release", () => t.tools.waitUntil(async () => {
      const tick = await script(["hook"]);
      if (tick.code !== 0) throw new Error("explicit-stop reconciliation failed: " + tick.stderr);
      const summaries = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions;
      lastReleaseState = { targetErrors: peerErrors(t.env.data), sourceErrors: peerErrors(sourceData), relay: { exit: relay.process.exitCode, signal: relay.process.signalCode, logTail: relay.logTail().slice(-1500) }, summaries, pending: readdirSync(pendingDir).map(f => JSON.parse(readFileSync(path.join(pendingDir, f), "utf8"))) };
      return !existsSync(lock);
    }, 30000).catch(() => { throw new Error("resumed writer release did not finish: " + JSON.stringify(lastReleaseState)); }));
    const resumed = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.find((s: any) => s.id === raceSession);
    t.assertions.assert(resumed?.status === "idle" && !resumed?.inputSummary?.paused && resumed.inputSummary.pendingMessageIds.length === 0, "finished task left input paused or pending");
    // Upgrade the same real source/executor to TaskOwner routing. The source
    // keeps the only task ledger; execution-only remote Owner can ask for help.
    writeFileSync(path.join(sourceRoot, ".genethub/open.env"), "TEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\n");
    writeFileSync(path.join(targetRoot, ".genethub/open.env"), "TEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\n");
    const sourceWorkspaces = (await cliJson(["workspace", "list"])).workspaces;
    const sourceProject = sourceWorkspaces.find((w: any) => w.folders?.[0]?.root === sourceRoot);
    const sourceQa = sourceWorkspaces.find((w: any) => w.folders?.[0]?.root === path.join(sourceRoot, "spaces/qa"));
    if (!sourceProject || !sourceQa) throw new Error("source task workspaces missing");
    const sourceEndpoint = parseJson((await sourceCli(["daemon", "endpoint"])).stdout) as any;
    sourceClient = await connectProductClient({ url: sourceEndpoint.wsUrl, localServerProof: { proof: sourceEndpoint.serverProof, ...sourceEndpoint.admission } });
    const sourceAccess = await sourceClient.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
    if (sourceAccess?.type !== "remoteAccess" || !sourceAccess.data.rendezvousUrl) throw new Error("source reverse relay unavailable");
    await t.tools.waitUntil(async () => { const d = await sourceClient!.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 20000);
    const sourceInvite = await sourceClient.call({ type: "device.invite", payload: null });
    if (sourceInvite?.type !== "invite") throw new Error("source reverse invitation unavailable");
    const reverse = await cliJson(["machine", "pair", sourceInvite.data.code, "--endpoint", sourceAccess.data.rendezvousUrl, "--name", "source-definition"], true);
    writeFileSync(path.join(targetRoot, ".genethub/task-source.json"), JSON.stringify({ machineId: reverse.machine.machineId, workspaceId: sourceQa.id, role: "qa", command: [python, path.join(sourceRoot, "tools/team.py")] }));
    const caller = await cliJson(["agent", "run", "--agent", "ctl-cli-command", "--workspace", sourceProject.id, "--creation-id", "remote.owner.front", "--prepare-only", "--no-wait", "prepare front before dispatch"]);
    const callerSid = caller.sessionId;
    const inspectSession = async (sid: string, remote = false) => ({
      summary: (await cliJson(["session", "get", sid], remote)).summary,
      items: (await cliJson(["session", "narrative", sid, "--limit", "100"], remote)).page.items,
    });
    const idleSession = (sid: string, remote = false) => t.tools.waitUntil(async () => {
      const snap = await cliJson(["session", "get", sid], remote);
      return snap.summary.status === "idle" && !snap.summary.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let commandSequence = 0;
    const callTask = async (sid: string, root: string, args: string[], remote = false) => {
      const inputId = `u_remote_contract_command_${++commandSequence}`;
      await cliJson(["session", "send", sid, JSON.stringify({ argv: [python, path.join(root, "tools/team.py"), ...args], cwd: root, requestId: inputId }), "--message-id", inputId, "--no-wait"], remote);
      let commandRound: any;
      await t.tools.waitUntil(async () => {
        commandRound = (await cliJson(["session", "rounds", sid, "--limit", "100"], remote)).page.rounds.find((r: any) => r.userItemId === inputId && r.outcome === "completed");
        return Boolean(commandRound);
      }, 30000);
      await idleSession(sid, remote);
      // Concurrent notices can be inserted before a command's answer. Match
      // its external request id in the native timeline; a chronological Round
      // boundary or the latest answer does not identify a command result.
      const narrative = await cliJson(["session", "narrative", sid, "--limit", "100"], remote);
      const item = narrative.page.items.find((i: any) => {
        if (i.type !== "assistantMessage") return false;
        try { return JSON.parse(i.text).requestId === inputId; } catch { return false; }
      });
      if (!item) throw new Error("real task caller returned no reply for " + inputId + " " + args.slice(0, 3).join(" ")
        + "; replies=" + JSON.stringify(narrative.page.items.filter((i: any) => i.type === "assistantMessage").map((i: any) => {
          try { const r=JSON.parse(i.text);return {requestId:r.requestId,code:r.code}; } catch { return "non-command"; }
        })) + "; unparsed=" + readFileSync(commandAgent.journalPath, "utf8").split("\n").filter(l => l.includes("unparsed")).slice(-2).join(" ").slice(-2500));
      try { return JSON.parse(item.text) as { code: number; out: string; err: string }; }
      catch {
        const snap = await inspectSession(sid, remote);
        const recent = snap.items.slice(-5).map((i: any) => `${i.type}: ${String(i.text ?? "").slice(0, 160)}`).join(" | ");
        throw new Error(`task caller ${sid} (${remote ? "executor" : "source"}, agent ${snap.summary.agentId}) replied without a command result; recent items: ${recent}; agent journal: ${readFileSync(commandAgent.journalPath, "utf8").split("\n").filter(l => l.includes("unparsed")).slice(-2).join(" ").slice(-1500)}`);
      }
    };
    // Keep author role definitions but remove the fake source execution Space.
    await cliJson(["workspace","remove",sourceQa.id]);
    t.assertions.assert(!(await cliJson(["workspace","list"])).workspaces.some((w:any)=>w.id===sourceQa.id),"local QA execution workspace was silently restored");
    const beginOwner = ["task", "start", "--space", "qa", "--request-id", "remote.owner.task", "--desc", "remote coordinating Owner", "Delegate one read-only source support and explicitly finish"];
    // Drop the successful prepare stdout once. No first business input may
    // precede the source's durable Owner and reverse dependency records.
    unlinkSync(dropped);
    t.note("TaskOwner remote: preparing with dropped stdout");
    const lostOwner = await callTask(callerSid, sourceRoot, beginOwner);
    t.assertions.assert(lostOwner.code !== 0, "lost prepare was falsely acknowledged as complete");
    const qualityFacts = async () => {
      const result = await script(["quality", "facts"]);
      t.assertions.assert(result.code === 0, "public quality capture failed: " + result.stderr);
      return JSON.parse(result.stdout);
    };
    const preparedFacts = await qualityFacts();
    t.assertions.assert(preparedFacts.workItems.length === 1 && preparedFacts.workItems[0].startedAtMs === null,
      "uncertain preparation was counted as native execution");
    const ownerReply = await callTask(callerSid, sourceRoot, beginOwner);
    t.assertions.assert(ownerReply.code === 0, "same-operation remote prepare could not recover: " + ownerReply.err);
    const remoteTask = JSON.parse(ownerReply.out.trim().split("\n").at(-1)!);
    const remoteOwner = remoteTask.owner.sessionId;
    await idleSession(remoteOwner, true);
    await t.tools.waitUntil(async()=>{
      const s=(await inspectSession(remoteOwner,true)).summary;
      return s.coordination?.taskId===remoteTask.taskId && s.coordination?.active;
    },30000);
    const sourceTaskFile = path.join(sourceRoot, ".genethub/team/tasks", remoteTask.taskId + ".json");
    t.assertions.assert(JSON.parse(readFileSync(sourceTaskFile, "utf8")).owner.sessionId === remoteOwner, "remote input started without durable source ownership");
    const nativeStart = (await cliJson(["session", "rounds", remoteOwner, "--limit", "100"], true)).page.rounds
      .sort((a: any, b: any) => a.startedAtMs - b.startedAtMs)[0];
    t.assertions.assert(nativeStart?.userItemId?.startsWith("activate."), "real remote activation input unavailable");
    const startedWork = (await qualityFacts()).workItems.find((x: any) => x.sessionId === remoteOwner);
    t.assertions.assert(startedWork?.startedAtMs === nativeStart.startedAtMs,
      "remote task activation lost its independently observed native start: " + JSON.stringify(startedWork));
    const qualityEvents = readFileSync(path.join(sourceRoot, ".genethub/team/events/events.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    t.assertions.assert(qualityEvents.some(x => x.kind === "input-accepted" && x.operationId === startedWork.id
      && x.messageId === nativeStart.userItemId), "remote acceptance event names a message that never ran");
    const dispatchFile = path.join(sourceRoot, ".genethub/team/task-dispatch", startedWork.id + ".json");
    const dispatchBytes = readFileSync(dispatchFile);
    // Explicit corrupt-ledger fixture: actual native executions remain intact,
    // but without an exact operation binding none may be attributed to it.
    try {
      const invalidBinding = JSON.parse(dispatchBytes.toString());
      invalidBinding.pending.remoteDispatch.id = "unrelated-operation";
      writeFileSync(dispatchFile, JSON.stringify(invalidBinding));
      const unbound = (await qualityFacts()).workItems.find((x: any) => x.sessionId === remoteOwner);
      t.assertions.assert(unbound?.startedAtMs === null && unbound.activationMessageId === null,
        "an unrelated native Round was used to fill an unbound remote start");
    } finally { writeFileSync(dispatchFile, dispatchBytes); }
    const remoteDirectory = path.join(targetRoot, "remote-owner-workstation"); mkdirSync(remoteDirectory);
    const bound = await callTask(remoteOwner, targetRoot, ["task", "bind-directory", remoteTask.taskId, "--directory", remoteDirectory], true);
    t.assertions.assert(bound.code === 0, "remote Owner could not claim an executor-side directory: " + bound.err);
    const boundReply = JSON.parse(JSON.parse(bound.out.trim()).result.trim());
    const ownerReceiverPath = path.join(targetDispatchDir, createHash("sha256").update(startedWork.id).digest("hex") + ".json");
    const ownerReceiverBytes = readFileSync(ownerReceiverPath);
    const ownerReceiver = JSON.parse(ownerReceiverBytes.toString());
    const settleExisting = () => spawnSync(python, [path.join(targetRoot, "tools/team.py"), "receive", JSON.stringify({
      id: startedWork.id, workspaceId: qa.id, role: "qa", operation: "settle-prepare", originalRequest: ownerReceiver.request,
    }), "--require-prepare-settlement"], { env: { ...o.daemon.env, GENEHUB_CLI: o.daemon.genet }, encoding: "utf8" });
    const existingSettlement = settleExisting();
    t.assertions.assert(existingSettlement.status === 0 && JSON.parse(existingSettlement.stdout).withdrawn === false
      && readFileSync(ownerReceiverPath).equals(ownerReceiverBytes), "settlement changed an existing real receiver receipt");
    // Explicit missing-receipt recovery fixture: the independently created
    // native Session still proves that absence is not a negative acknowledgement.
    try {
      unlinkSync(ownerReceiverPath);
      const missingReceipt = settleExisting();
      t.assertions.assert(missingReceipt.status === 0 && JSON.parse(missingReceipt.stdout).withdrawn === false
        && !existsSync(ownerReceiverPath), "missing receiver receipt erased an existing native creation");
    } finally { writeFileSync(ownerReceiverPath, ownerReceiverBytes); }
    // A real competing writer rejects preparation before a native Session
    // exists. Restoring its overdue source intent must not leave it unknown
    // forever, retry business, or disturb that writer.
    const roleEnv = path.join(targetRoot, "spaces/qa/.genethub/open.env");
    const previousRoleEnv = existsSync(roleEnv) ? readFileSync(roleEnv) : null;
    mkdirSync(path.dirname(roleEnv), { recursive: true });
    writeFileSync(roleEnv, `WORKTREE_DIR=${remoteDirectory}\n`);
    const refused = await callTask(callerSid, sourceRoot, beginOwner.map(v => v === "remote.owner.task" ? "remote.owner.refused" : v));
    t.assertions.assert(refused.code !== 0 && refused.err.includes("写锁"), "actual competing writer did not reject remote preparation");
    if (previousRoleEnv) writeFileSync(roleEnv, previousRoleEnv); else unlinkSync(roleEnv);
    const intentsRoot = path.join(sourceRoot, ".genethub/team/task-dispatch");
    const refusedPath = readdirSync(intentsRoot).map(f => path.join(intentsRoot, f)).find(f => {
      const row = JSON.parse(readFileSync(f, "utf8"));
      return row.state === "creating" && !row.sessionId;
    })!;
    t.assertions.assert(Boolean(refusedPath), "failed remote prepare lost its durable intent");
    const refusedIntent = JSON.parse(readFileSync(refusedPath, "utf8"));
    refusedIntent.createdAtMs = Date.now() - 601000; // restored overdue operation, no mocked clock
    writeFileSync(refusedPath, JSON.stringify(refusedIntent));
    const originalLease = readFileSync(boundReply.lock);
    const countBeforeSettlement = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length;
    await cliJson(["session", "interrupt", callerSid]);
    await t.tools.waitUntil(async () => (await cliJson(["session", "get", callerSid])).summary.inputSummary?.paused, 10000);
    // The real shell must carry the old process's stderr and exit status.
    // Neither generic failure nor a missing protocol may settle/replay work.
    let protocolNoteId: string | undefined;
    for(const mode of ["unrelated","legacy","legacy"]) {
      writeFileSync(compatibilityMarker,mode);
      try {
        const diagnostic=await script(["hook"]);
        const retained=JSON.parse(readFileSync(refusedPath,"utf8"));
        t.assertions.assert(diagnostic.code===0 && retained.state==="creating" && !retained.sessionId
          && !existsSync(path.join(targetDispatchDir,createHash("sha256").update(refusedIntent.operationId).digest("hex")+".json"))
          && readFileSync(boundReply.lock).equals(originalLease),"compatibility failure settled work or disturbed an existing writer");
        if(mode==="unrelated") t.assertions.assert(retained.withdrawError.includes("未确认")
          && !retained.withdrawError.includes("fixture-stderr-must-not-leak"),"unrelated stderr became a capability claim or leaked raw text");
        else t.assertions.assert(retained.withdrawError.includes("--require-prepare-settlement") && retained.withdrawError.includes("同步"),
          "old receiver protocol failure lost its actionable diagnostic: "+retained.withdrawError);
        const notes = await script(["notes", "ls"]);
        const diagnosticNotes = notes.stdout.split(/(?=^n[0-9a-f]{12}  )/m)
          .filter(note => note.includes(refusedIntent.operationId) && note.includes("--require-prepare-settlement"));
        t.assertions.assert(notes.code === 0 && !notes.stdout.includes("fixture-stderr-must-not-leak"), "public reflection notes leaked receiver stderr");
        if (mode === "unrelated") t.assertions.assert(diagnosticNotes.length === 0, "unrelated failure became a protocol maintenance note");
        else {
          t.assertions.assert(diagnosticNotes.length === 1, "proven protocol failure is invisible or duplicated in reflection notes: " + diagnosticNotes.length);
          const id = diagnosticNotes[0]!.match(/^n[0-9a-f]{12}/)?.[0];
          t.assertions.assert(Boolean(id) && (!protocolNoteId || protocolNoteId === id), "repeated reconciliation created a new maintenance obligation");
          protocolNoteId = id;
        }
        t.assertions.assert((await cliJson(["session","list","--workspace",qa.id,"--limit","100"],true)).sessions.length===countBeforeSettlement,
          "unsupported receiver command created another native execution");
        retained.withdrawRetryAtMs=0; // isolated due-retry fixture, original operation stays intact
        writeFileSync(refusedPath,JSON.stringify(retained));
      } finally {unlinkSync(compatibilityMarker);}
    }
    const settled = await script(["hook"]);
    const negative = JSON.parse(readFileSync(refusedPath, "utf8"));
    t.assertions.assert(settled.code === 0 && negative.state === "withdrawn" && negative.withdrawnAtMs >= refusedIntent.createdAtMs + 600000,
      "executor-confirmed uncreated attempt remains an unknown source obligation: " + JSON.stringify({ code:settled.code, error:negative.withdrawError, state:negative.state }));
    const receiverFence = targetReceipt(refusedIntent.operationId);
    t.assertions.assert(receiverFence.status === "withdrawn" && receiverFence.settlement === "not-created"
      && readFileSync(boundReply.lock).equals(originalLease), "negative acknowledgement lost its durable fence or another writer lease");
    const delayed = spawnSync(python, [path.join(targetRoot, "tools/team.py"), "receive", JSON.stringify(receiverFence.request)], {
      env: { ...o.daemon.env, GENEHUB_CLI: o.daemon.genet }, encoding: "utf8",
    });
    t.assertions.assert(delayed.status !== 0 && (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length === countBeforeSettlement,
      "late original prepare escaped negative acknowledgement and created work");
    const repeated = await script(["hook"]);
    t.assertions.assert(repeated.code === 0 && JSON.parse(readFileSync(refusedPath, "utf8")).withdrawnAtMs === negative.withdrawnAtMs
      && (await cliJson(["session", "get", callerSid])).summary.inputSummary?.paused, "settlement retry changed history or lifted caller pause");
    await cliJson(["session", "send", callerSid, "Continue after the observed failed preparation", "--message-id", "u_prepare_settlement_continue", "--no-wait"]);
    await idleSession(callerSid);
    await t.tools.waitUntil(async () => {
      const tick = await script(["hook"]);
      return tick.code === 0 && (await inspectSession(callerSid)).items.some((i: any) => i.type === "userMessage" && i.text.includes(refusedIntent.operationId) && i.text.includes("没有创建"));
    }, 15000);
    const failureNotes = (await inspectSession(callerSid)).items.filter((i: any) => i.type === "userMessage" && i.text.includes(refusedIntent.operationId) && i.text.includes("没有创建"));
    t.assertions.assert(failureNotes.length === 1, "failed preparation was not reported exactly once to its original requester");
    // A newly refused attempt gets the same real receiver proof before the
    // ten-minute unresolved-dispatch boundary. Restored age is fixture data,
    // not a mocked clock; fresh calls and an existing writer stay protected.
    writeFileSync(roleEnv, `WORKTREE_DIR=${remoteDirectory}\n`);
    let timelyRefusal: Awaited<ReturnType<typeof callTask>>;
    try {
      timelyRefusal = await callTask(callerSid, sourceRoot,
        beginOwner.map(v => v === "remote.owner.task" ? "remote.owner.timely-refusal" : v));
    } finally {
      if (previousRoleEnv) writeFileSync(roleEnv, previousRoleEnv); else unlinkSync(roleEnv);
    }
    t.assertions.assert(timelyRefusal.code !== 0 && timelyRefusal.err.includes("写锁"),
      "timeliness fixture did not reach the real competing writer refusal");
    const timelyPath = readdirSync(intentsRoot).map(f => path.join(intentsRoot, f)).find(f => {
      const row = JSON.parse(readFileSync(f, "utf8"));
      return row.state === "creating" && !row.sessionId;
    })!;
    t.assertions.assert(Boolean(timelyPath), "new refused preparation lost its original intent");
    const timelyIntent = JSON.parse(readFileSync(timelyPath, "utf8"));
    const timelyReceiver = path.join(targetDispatchDir, createHash("sha256").update(timelyIntent.operationId).digest("hex") + ".json");
    const timelyCount = (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length;
    const freshHook = await script(["hook"]);
    t.assertions.assert(freshHook.code === 0 && JSON.parse(readFileSync(timelyPath, "utf8")).state === "creating"
      && !existsSync(timelyReceiver) && readFileSync(boundReply.lock).equals(originalLease),
      "fresh preparation was fenced before its bounded call could finish");
    timelyIntent.createdAtMs = Date.now() - 180000;
    writeFileSync(timelyPath, JSON.stringify(timelyIntent));
    const timelyHook = await script(["hook"]);
    const timelyDone = JSON.parse(readFileSync(timelyPath, "utf8"));
    t.assertions.assert(timelyHook.code === 0 && timelyDone.state === "withdrawn"
      && timelyDone.withdrawnAtMs - timelyIntent.createdAtMs < 600000,
      "uncreated preparation waited until the unresolved-dispatch deadline before reconciliation");
    const timelyFence = targetReceipt(timelyIntent.operationId);
    t.assertions.assert(timelyFence.status === "withdrawn" && timelyFence.settlement === "not-created"
      && readFileSync(boundReply.lock).equals(originalLease)
      && (await cliJson(["session", "list", "--workspace", qa.id, "--limit", "100"], true)).sessions.length === timelyCount,
      "timely negative acknowledgement created work or changed the independent writer");
    const secondOwnerReply = await callTask(callerSid, sourceRoot, beginOwner.map(v => v === "remote.owner.task" ? "remote.owner.independent" : v));
    t.assertions.assert(secondOwnerReply.code === 0, "the remote Space was still treated as an exclusive workstation: " + secondOwnerReply.err);
    const secondTask = JSON.parse(secondOwnerReply.out.trim().split("\n").at(-1)!);
    const secondOwner = secondTask.owner.sessionId;
    await idleSession(secondOwner, true);
    const contested = await callTask(secondOwner, targetRoot, ["task", "bind-directory", secondTask.taskId, "--directory", remoteDirectory], true);
    t.assertions.assert(contested.code !== 0 && JSON.parse(readFileSync(boundReply.lock, "utf8")).session === remoteOwner, "independent remote session stole the first Owner's actual directory");
    const secondDone = await callTask(secondOwner, targetRoot, ["task", "finish", secondTask.taskId, "--outcome", "success", "Read-only independent remote task completed"], true);
    t.assertions.assert(secondDone.code === 0, "second remote Owner did not settle");
    await t.tools.waitUntil(async () => { const tick = await script(["hook"]); if (tick.code !== 0) throw new Error(tick.stderr); return JSON.parse(readFileSync(path.join(sourceRoot, ".genethub/team/tasks", secondTask.taskId + ".json"), "utf8")).state === "delivered"; }, 30000);
    t.assertions.assert(existsSync(boundReply.lock), "unrelated remote task released another Owner's resource");
    t.note("TaskOwner remote: source ownership saved; asking source support");
    // Changing the install default cannot redirect already accepted work.
    writeFileSync(path.join(targetRoot,".genethub/task-source.json"),JSON.stringify({machineId:"m_missing",workspaceId:"w_missing",role:"qa",command:[python,"/missing/run.py"]}));
    const supportReply = await callTask(remoteOwner, targetRoot, ["task", "support", remoteTask.taskId, "--space", "research", "--desc", "source support", "--request-id", "remote.owner.support", "Produce one source-side evidence report"], true);
    t.assertions.assert(supportReply.code === 0, "remote Owner could not request source support: " + supportReply.err);
    const forwarded = JSON.parse(supportReply.out.trim());
    const support = JSON.parse(forwarded.result.trim()).collaborator;
    await idleSession(support);
    t.note("TaskOwner remote: source support created; recording evidence");
    const finishReply = await callTask(support, sourceRoot, ["task", "finish", remoteTask.taskId, "--outcome", "success", "REMOTE_OWNER_SOURCE_SUPPORT_EVIDENCE"]);
    t.assertions.assert(finishReply.code === 0, "source support could not settle: " + finishReply.err);
    await t.tools.waitUntil(async () => {
      const tick = await script(["hook"]);
      if (tick.code !== 0) throw new Error(tick.stderr);
      const snap = await inspectSession(remoteOwner, true);
      return snap.items.some((i: any) => i.type === "userMessage" && i.text.includes("REMOTE_OWNER_SOURCE_SUPPORT_EVIDENCE"));
    }, 30000);
    await idleSession(remoteOwner, true);
    t.note("TaskOwner remote: evidence returned to remote Owner; finishing");
    const ownerFinish = await callTask(remoteOwner, targetRoot, ["task", "finish", remoteTask.taskId, "--outcome", "success", "REMOTE_OWNER_COMPLETE_WITH_SOURCE_SUPPORT"], true);
    t.assertions.assert(ownerFinish.code === 0, "remote Owner could not finish through source ledger: " + ownerFinish.err);
    await t.tools.waitUntil(async () => { const tick = await script(["hook"]); if (tick.code !== 0) throw new Error(tick.stderr); return JSON.parse(readFileSync(sourceTaskFile, "utf8")).state === "delivered"; }, 30000);
    t.assertions.assert(!(await cliJson(["workspace","list"])).workspaces.some((w:any)=>w.id===sourceQa.id),"task return restored a fake local QA workspace");
    t.assertions.assert(!existsSync(boundReply.lock) && !existsSync(lock) && !existsSync(path.join(targetRoot, ".genethub/team/tasks", remoteTask.taskId + ".json")), "remote Owner left a writer or created a second authoritative task ledger");
    const finalWork = (await qualityFacts()).workItems.find((x: any) => x.sessionId === remoteOwner);
    t.assertions.assert(finalWork?.startedAtMs === nativeStart.startedAtMs
      && finalWork.activationMessageId === nativeStart.userItemId,
      "later work, reconciliation or receipt replay moved the original remote activation");
    // Restored previous-owner references can outgrow the small exchange head
    // without increasing the number of currently running workers.
    const evidenceRefs = Array.from({length: 300}, (_, n) => "s_" + n.toString(16).padStart(32, "0"));
    const currentTask = JSON.parse(readFileSync(sourceTaskFile, "utf8"));
    currentTask.state = "active";
    currentTask.previousOwners = evidenceRefs.map(sessionId => ({sessionId}));
    writeFileSync(sourceTaskFile, JSON.stringify(currentTask));
    const projected = await script(["hook"]);
    t.assertions.assert(projected.code === 0, "large projection maintenance failed: " + projected.stderr);
    const largeSourceProjection = JSON.parse(readFileSync(path.join(sourceRoot, ".genethub/session-coordination.json"), "utf8"));
    const largeTargetProjection = JSON.parse(readFileSync(path.join(targetRoot, "spaces/qa/.genethub/session-coordination.json"), "utf8"));
    t.assertions.assert(Buffer.byteLength(JSON.stringify(largeSourceProjection)) > 8192 && largeTargetProjection.revision === largeSourceProjection.revision && evidenceRefs.every(sid => largeTargetProjection.references.includes(sid)), "Timer success hid a failed large remote projection");
    currentTask.state = "delivered"; writeFileSync(sourceTaskFile, JSON.stringify(currentTask));
    // Ordered single-source delivery uses receiving time, never wall-clock
    // comparison with the source. Replay and accidental foreign use retain it.
    const projectionPath=path.join(targetRoot,"spaces/qa/.genethub/session-coordination.json");
    const previousProjection=JSON.parse(readFileSync(projectionPath,"utf8"));
    const incoming={...previousProjection,revision:previousProjection.revision+10,updatedAtMs:Date.now()+86400000};
    delete incoming.receivedAtMs;
    const receiveProjection=(snapshot:any)=>spawnSync(python,[path.join(targetRoot,"tools/team.py"),"receive",JSON.stringify({id:incoming.source,operation:"coordination",workspaceId:qa.id,role:"qa",snapshot})],{env:{...o.daemon.env,GENEHUB_CLI:o.daemon.genet},encoding:"utf8"});
    const freshProjection = receiveProjection(incoming);
    t.assertions.assert(freshProjection.status===0,"fresh source revision rejected: " + freshProjection.stdout + freshProjection.stderr);
    const acceptedProjection=JSON.parse(readFileSync(projectionPath,"utf8"));
    t.assertions.assert(Math.abs(acceptedProjection.receivedAtMs-Date.now())<5000,"target adopted the future source clock as freshness");
    t.assertions.assert(receiveProjection({...incoming,revision:incoming.revision-1,updatedAtMs:incoming.updatedAtMs+86400000}).status===0&&JSON.parse(readFileSync(projectionPath,"utf8")).revision===incoming.revision,"older revision overwrote a newer projection");
    t.assertions.assert(receiveProjection({...incoming,source:"another-team",revision:incoming.revision+1}).status!==0,"foreign source replaced a single-source runtime");
    t.assertions.assert(receiveProjection({...incoming,sessions:{}}).status!==0,"same revision accepted different content");
    // Exercise the existing build post all the way through real file download,
    // verification, target registration and generated canonical membership.
    const runtimeRoot=path.join(t.env.root,"artifact-only-runtime"), portable=path.join(t.env.root,"portable-output");
    mkdirSync(path.join(runtimeRoot,".genethub"),{recursive:true});
    writeFileSync(path.join(runtimeRoot,".genethub/open.env"),"TEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\n");
    const sourceDescriptor=path.join(sourceRoot,"agent-space.genet.json"), raw=JSON.parse(readFileSync(sourceDescriptor,"utf8"));
    raw.buildHooks={post:[{cwd:".",args:["{python}","tools/install_remote.py","{outputRoot}","qa",machine,runtimeRoot]}]};
    writeFileSync(sourceDescriptor,JSON.stringify(raw));
    const buildArtifact=()=>spawnSync(python,[path.join(t.openRoot,"apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py"),"build",sourceRoot,"--output",portable],{env:sourceEnv,encoding:"utf8",timeout:180000});
    const localBuild=spawnSync(python,[path.join(t.openRoot,"apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py"),"build",sourceRoot],{env:sourceEnv,encoding:"utf8",timeout:30000});
    t.assertions.assert(localBuild.status===0&&!existsSync(path.join(runtimeRoot,".genethub/install-receipt.json")),"ordinary build installed remotely or broke local identity compilation: "+localBuild.stdout+localBuild.stderr);
    let installed=buildArtifact();t.assertions.assert(installed.status===0,"build post did not install: "+installed.stdout+installed.stderr);
    const installedBinding=JSON.parse(readFileSync(sourceDescriptor,"utf8")).members.find((m:any)=>m.name==="qa");
    t.assertions.assert(installedBinding.machineId===o.client.identity!.machineId&&!existsSync(path.join(runtimeRoot,"skills"))&&!existsSync(path.join(runtimeRoot,"soul.md"))&&existsSync(path.join(runtimeRoot,".spacebuilder/output-lock.json")),"remote runtime carries author inputs or a route instead of identity");
    const adopted=(await cliJson(["workspace","list"],true)).workspaces.filter((w:any)=>w.folders?.[0]?.root.startsWith(runtimeRoot+path.sep));
    t.assertions.assert(adopted.length===1&&adopted[0].id===installedBinding.workspaceId,"installer registered extra remote roles/front");
    t.assertions.assert(!(await cliJson(["workspace","list"])).workspaces.some((w:any)=>w.folders?.[0]?.root===path.join(sourceRoot,"spaces/qa")),"ordinary build restored a source QA execution workspace");
    const installedTaskReply=await callTask(callerSid,sourceRoot,["task","start","--space","qa","--request-id","artifact.owner","--desc","artifact owner","Complete one task without author sources"]);
    t.assertions.assert(installedTaskReply.code===0,"artifact Owner did not start: "+installedTaskReply.err);
    const installedTask=JSON.parse(installedTaskReply.out.trim().split("\n").at(-1)!);await idleSession(installedTask.owner.sessionId,true);
    const heldDigest=JSON.parse(readFileSync(path.join(runtimeRoot,".genethub/install-receipt.json"),"utf8")).archiveSha256;
    writeFileSync(path.join(sourceRoot,"tools/version-marker.py"),"VALUE = 'new artifact'\n");
    installed=buildArtifact();t.assertions.assert(installed.status!==0&&JSON.parse(readFileSync(path.join(runtimeRoot,".genethub/install-receipt.json"),"utf8")).archiveSha256===heldDigest,"in-flight update replaced the executing artifact");
    const finishInstalled=await callTask(installedTask.owner.sessionId,runtimeRoot,["task","finish",installedTask.taskId,"--outcome","success","ARTIFACT_ONLY_OWNER_COMPLETE"],true);
    t.assertions.assert(finishInstalled.code===0,"artifact Owner could not return: "+finishInstalled.err);
    await t.tools.waitUntil(async()=>{const tick=await script(["hook"]);if(tick.code!==0)throw Error(tick.stderr);return JSON.parse(readFileSync(path.join(sourceRoot,".genethub/team/tasks",installedTask.taskId+".json"),"utf8")).state==="delivered";},30000);
    installed=buildArtifact();t.assertions.assert(installed.status===0,"settled artifact update failed: "+installed.stdout+installed.stderr);
    const afterUpgrade=JSON.parse(readFileSync(path.join(runtimeRoot,".genethub/install-receipt.json"),"utf8"));
    installed=buildArtifact();t.assertions.assert(installed.status===0&&JSON.parse(readFileSync(path.join(runtimeRoot,".genethub/install-receipt.json"),"utf8")).archiveSha256===afterUpgrade.archiveSha256,"unchanged build did not recover the same install receipt");
    t.assertions.assert((await inspectSession(installedTask.owner.sessionId,true)).summary.workspaceId===installedBinding.workspaceId,"artifact upgrade lost the native history binding");
    // Migrate the same team to the role-level TEAM_MACHINE contract: one declaration per role,
    // installed by `employee sync` into a platform-chosen directory, never re-routed by a flag.
    const builder={TEAM_SPACEBUILDER:path.join(t.openRoot,"apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py")};
    const declare=(role:string,value:string|null)=>{
      const file=path.join(sourceRoot,"spaces",role,".genethub/open.env");
      const lines=existsSync(file)?readFileSync(file,"utf8").split("\n").filter(l=>l&&!l.startsWith("TEAM_MACHINE=")):[];
      if(value!==null)lines.push("TEAM_MACHINE="+value);
      mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,lines.join("\n")+"\n");
    };
    const intentsBeforeDeclared=readdirSync(intentDir).sort(), pendingBeforeDeclared=readdirSync(pendingDir).sort();
    const sourceSettings=path.join(sourceRoot,".genethub/open.env"), sourceSettingsText=readFileSync(sourceSettings,"utf8");
    writeFileSync(sourceSettings,sourceSettingsText+"TEAM_MACHINE="+machine+"\n");
    const teamWide=await script(["spawn","--kind","research","--space","qa","--desc","team-wide machine","Must not dispatch."]);
    t.assertions.assert(teamWide.code!==0&&teamWide.stderr.includes("只能写在岗位"),"team-level TEAM_MACHINE was accepted: "+teamWide.stderr);
    writeFileSync(sourceSettings,sourceSettingsText);
    declare("qa",machine);
    const legacyHook=await script(["employee","sync"],builder);
    t.assertions.assert(legacyHook.code!==0&&legacyHook.stderr.includes("install_remote"),"sync ran beside the legacy install build hook: "+legacyHook.stderr);
    const withoutHook=JSON.parse(readFileSync(sourceDescriptor,"utf8"));delete withoutHook.buildHooks;writeFileSync(sourceDescriptor,JSON.stringify(withoutHook));
    declare("research",machine);
    const notInstalled=await script(["spawn","--kind","research","--space","research","--desc","undeployed role","Must not run locally."]);
    t.assertions.assert(notInstalled.code!==0&&notInstalled.stderr.includes("还没有安装"),"declared but uninstalled role did not stop dispatch: "+notInstalled.stderr);
    declare("research",null);
    const sourceMachine=(await cliJson(["context"])).daemon.machineId;
    const rerouted=await script(["spawn","--kind","research","--space","qa","--machine",sourceMachine,"--desc","reroute","Must not move the role."]);
    t.assertions.assert(rerouted.code!==0&&rerouted.stderr.includes("不能用 --machine"),"--machine moved a declared role: "+rerouted.stderr);
    t.assertions.assert(JSON.stringify(intentsBeforeDeclared)===JSON.stringify(readdirSync(intentDir).sort())&&JSON.stringify(pendingBeforeDeclared)===JSON.stringify(readdirSync(pendingDir).sort()),"a rejected declared-role dispatch left intents or pending work");
    let synced=await script(["employee","sync"],builder);
    const agentSettings=synced.stderr.match(/TEAM_AGENT=<agent id> to (\/\S+?open\.env)/)?.[1];
    if(synced.code!==0&&agentSettings){mkdirSync(path.dirname(agentSettings),{recursive:true});writeFileSync(agentSettings,"TEAM_AGENT=ctl-cli-command\n");synced=await script(["employee","sync"],builder);}
    t.assertions.assert(synced.code===0,"employee sync did not install the declared role: "+synced.stdout+synced.stderr);
    const syncReport=JSON.parse(synced.stdout.trim().split("\n").at(-1)!);
    const declaredBinding=JSON.parse(readFileSync(sourceDescriptor,"utf8")).members.find((m:any)=>m.name==="qa");
    const declaredRuntime=path.dirname(path.dirname(declaredBinding.command[1]));
    const incomingDirectories=()=>readdirSync(path.dirname(declaredRuntime)).filter(n=>n.startsWith("."+path.basename(declaredRuntime)+".incoming-")).sort();
    const olderStage=path.join(path.dirname(declaredRuntime),"."+path.basename(declaredRuntime)+".incoming-retain-existing");
    mkdirSync(olderStage);writeFileSync(path.join(olderStage,"evidence.txt"),"not created by this install");
    const retainedStages=JSON.stringify(incomingDirectories());
    t.assertions.assert(syncReport.installed.length===1&&syncReport.installed[0].roles.join()==="qa"&&declaredBinding.machineId===machine&&declaredBinding.workspaceId===syncReport.installed[0].workspaces.qa,"sync did not write exactly the declared binding");
    t.assertions.assert(declaredRuntime.startsWith(path.join(t.env.home,".genehub-teams","team."))&&declaredRuntime!==runtimeRoot,"runtime directory was not chosen by the platform: "+declaredRuntime);
    writeFileSync(path.join(declaredRuntime,".genethub/open.env"),"TEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\n");
    const declaredReceipt=JSON.parse(readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8"));
    const installedRoleSettings=path.join(declaredRuntime,"spaces/qa/.genethub/open.env");
    t.assertions.assert(declaredReceipt.members.map((m:any)=>m.name).join()==="qa"&&(!existsSync(installedRoleSettings)||!readFileSync(installedRoleSettings,"utf8").includes("TEAM_MACHINE")),"installed copy carries the source's machine declaration or extra roles");
    const listedRoles=await script(["employee","ls"]);
    t.assertions.assert(listedRoles.code===0&&/- qa \[.*机器: .*已安装/.test(listedRoles.stdout),"employee ls hides the role's machine: "+listedRoles.stdout);
    // A durable withdrawal is a terminal, uncreated operation, so it must
    // survive the next real artifact installation without blocking upgrades.
    const returnForFence = JSON.parse(readFileSync(path.join(declaredRuntime,".genethub/task-source.json"),"utf8"));
    const originalFence = {id:"upgrade.withdrawn", workspaceId:declaredBinding.workspaceId, role:"qa", desc:"uncreated bounded work", text:"Never start this old work", prepareOnly:true, tier:null, model:null, media:null, returnTo:returnForFence};
    const installedReceive = (request:unknown, fence=false) => spawnSync(python,[path.join(declaredRuntime,"tools/run.py"),"receive",JSON.stringify(request),...(fence?["--require-dispatch-fence"]:[])],{env:{...o.daemon.env,GENEHUB_CLI:o.daemon.genet},encoding:"utf8"});
    const fenced = installedReceive({id:originalFence.id,workspaceId:declaredBinding.workspaceId,role:"qa",operation:"withdraw-prepare",originalRequest:originalFence},true);
    t.assertions.assert(fenced.status===0&&JSON.parse(fenced.stdout.trim().split("\n").at(-1)!).withdrawn===true,"public installed receiver did not fence old work: "+fenced.stdout+fenced.stderr);
    const fencePath=path.join(declaredRuntime,"spaces/qa/.genethub/team/dispatch",createHash("sha256").update(originalFence.id).digest("hex")+".json");
    const fenceBytes=readFileSync(fencePath,"utf8");
    // Explicit future-protocol storage fixture: unknown proof must stay closed.
    writeFileSync(fencePath,JSON.stringify({...JSON.parse(fenceBytes),fenceProtocol:99}));
    const unsupportedBytes=readFileSync(fencePath,"utf8");
    writeFileSync(path.join(sourceRoot,"tools/version-marker.py"),"VALUE = 'upgrade after withdrawal'\n");
    let blockedFence=await script(["employee","sync"],builder);
    t.assertions.assert(blockedFence.code!==0&&readFileSync(fencePath,"utf8")===unsupportedBytes&&JSON.parse(readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")).archiveSha256===declaredReceipt.archiveSha256,"unsupported withdrawal proof was replaced during upgrade");
    t.assertions.assert(JSON.stringify(incomingDirectories())===retainedStages,"a refused upgrade left its temporary installation stage");
    writeFileSync(fencePath,fenceBytes);
    const fenceUpgrade=await script(["employee","sync"],builder);
    t.assertions.assert(fenceUpgrade.code===0,"terminal withdrawal blocked real upgrade: "+fenceUpgrade.stdout+fenceUpgrade.stderr);
    const upgradedDigest=JSON.parse(readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")).archiveSha256;
    t.assertions.assert(upgradedDigest!==declaredReceipt.archiveSha256&&readFileSync(fencePath,"utf8")===fenceBytes,"upgrade lost the original durable fence or did not change artifacts");
    const lateFence=installedReceive(originalFence);
    t.assertions.assert(lateFence.status!==0&&readFileSync(fencePath,"utf8")===fenceBytes,"late prepare escaped the preserved fence after upgrade");
    const preparedForUpgrade={...originalFence,id:"upgrade.real-prepared"};
    const preparedNative=installedReceive(preparedForUpgrade);
    t.assertions.assert(preparedNative.status===0,"actual prepared receiver failed: "+preparedNative.stdout+preparedNative.stderr);
    const preparedSid=JSON.parse(preparedNative.stdout.trim().split("\n").at(-1)!).sessionId;
    const preparedFile=path.join(path.dirname(fencePath),createHash("sha256").update(preparedForUpgrade.id).digest("hex")+".json");
    const preparedBytes=readFileSync(preparedFile,"utf8");
    t.assertions.assert(typeof preparedSid==="string"&&!(await inspectSession(preparedSid,true)).items.some((i:any)=>i.type==="assistantMessage"),"native preparation activated business");
    writeFileSync(path.join(sourceRoot,"tools/version-marker.py"),"VALUE = 'prepared work must block upgrade'\n");
    const blockedPrepared=await script(["employee","sync"],builder);
    t.assertions.assert(blockedPrepared.code!==0&&JSON.parse(readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")).archiveSha256===upgradedDigest&&readFileSync(preparedFile,"utf8")===preparedBytes,"an actual prepared native Session was replaced as terminal work");
    const releasedPrepared=installedReceive({id:preparedForUpgrade.id,workspaceId:declaredBinding.workspaceId,role:"qa",operation:"release",sessionId:preparedSid});
    t.assertions.assert(releasedPrepared.status===0,"prepared release failed: "+releasedPrepared.stdout+releasedPrepared.stderr);
    const releasedUpgrade=await script(["employee","sync"],builder);
    t.assertions.assert(releasedUpgrade.code===0&&readFileSync(fencePath,"utf8")===fenceBytes,"settled upgrade discarded the fence: "+releasedUpgrade.stdout+releasedUpgrade.stderr);
    const receiptBeforeCopyFailure=readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8");
    const preservedData=path.join(declaredRuntime,"datas/stage-cleanup-save.bin");
    mkdirSync(path.dirname(preservedData),{recursive:true});writeFileSync(preservedData,Buffer.alloc(1024*1024,19));
    const outside=path.join(t.env.root,"outside-install-sentinel");writeFileSync(outside,"retain unrelated target");
    // Installer control metadata must never become an alias to another file.
    const rejectedLink=path.join(declaredRuntime,".genethub/rejected-link");symlinkSync(outside,rejectedLink);
    writeFileSync(path.join(sourceRoot,"tools/version-marker.py"),"VALUE = 'runtime preservation failure'\n");
    const failedCopy=await script(["employee","sync"],builder);
    t.assertions.assert(failedCopy.code!==0&&failedCopy.stderr.includes("runtime symlink")
      &&JSON.stringify(incomingDirectories())===retainedStages
      &&readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")===receiptBeforeCopyFailure
      &&readFileSync(preservedData).equals(Buffer.alloc(1024*1024,19))&&readFileSync(outside,"utf8")==="retain unrelated target",
      "failed runtime preservation leaked staging or changed original data/receipt");
    unlinkSync(rejectedLink);
    // A normal runtime can also contain real business worktrees, generated
    // bytecode, and opaque data aliases. Upgrade must not require moving them.
    const businessRepo=path.join(t.env.root,"upgrade-business-repo");mkdirSync(businessRepo);
    const git=(cwd:string,...args:string[])=>{
      const r=spawnSync("git",["-C",cwd,...args],{env:o.daemon.env,encoding:"utf8"});
      t.assertions.assert(r.status===0,"fixture Git operation failed: "+r.stderr);return r.stdout.trim();
    };
    git(businessRepo,"init");writeFileSync(path.join(businessRepo,"scene.txt"),"committed scene\n");
    git(businessRepo,"add","scene.txt");git(businessRepo,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","scene baseline");
    const businessTree=path.join(declaredRuntime,"worktrees/qa-scene");mkdirSync(path.dirname(businessTree),{recursive:true});
    git(businessRepo,"worktree","add","-b","qa-scene",businessTree);
    const businessHead=git(businessTree,"rev-parse","HEAD");
    writeFileSync(path.join(businessTree,"scene.txt"),"unfinished scene edit\n");
    const localBind=spawnSync(python,[path.join(declaredRuntime,"tools/run.py"),"worktree","bind","qa",businessTree],{env:{...o.daemon.env,GENEHUB_CLI:o.daemon.genet},encoding:"utf8"});
    t.assertions.assert(localBind.status===0,"runtime worktree bind failed: "+localBind.stdout+localBind.stderr);
    const boundSettings=readFileSync(path.join(declaredRuntime,"spaces/qa/.genethub/open.env"),"utf8");
    const cache=spawnSync(python,["-c","import py_compile,sys; print(py_compile.compile(sys.argv[1], doraise=True))",path.join(declaredRuntime,"tools/version-marker.py")],{env:o.daemon.env,encoding:"utf8"});
    t.assertions.assert(cache.status===0,"real owned Python cache was not generated: "+cache.stderr);
    const cachePath=cache.stdout.trim();t.assertions.assert(existsSync(cachePath),"real cache fixture missing");
    const dataLink=path.join(declaredRuntime,"datas/retained-alias");symlinkSync(outside,dataLink);
    const tempLink=path.join(declaredRuntime,"temp/retained-directory");mkdirSync(path.dirname(tempLink),{recursive:true});symlinkSync(businessRepo,tempLink,"dir");
    const danglingLink=path.join(declaredRuntime,"temp/future-output");symlinkSync("not-created-yet",danglingLink);
    const afterCopyFailure=await script(["employee","sync"],builder);
    t.assertions.assert(afterCopyFailure.code===0,"normal runtime data blocked upgrade: "+afterCopyFailure.stdout+afterCopyFailure.stderr);
    const archiveReceipt=readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8");
    const archiveDigest=JSON.parse(archiveReceipt).archiveSha256;
    const archive=path.join(sourceRoot,"temp/artifacts",archiveDigest+".zip");
    const archiveBytes=readFileSync(archive),archiveBefore=lstatSync(archive);
    const repeatedInstall=await script(["employee","sync"],builder);
    t.assertions.assert(afterCopyFailure.code===0&&repeatedInstall.code===0
      &&JSON.stringify(incomingDirectories())===retainedStages
      &&readFileSync(path.join(olderStage,"evidence.txt"),"utf8")==="not created by this install"
      &&readFileSync(preservedData).equals(Buffer.alloc(1024*1024,19)),
      "successful retry or idempotent installation retained an extra runtime copy");
    const archiveAfter=lstatSync(archive);
    t.assertions.assert(archiveAfter.ino===archiveBefore.ino&&archiveAfter.dev===archiveBefore.dev
      &&archiveAfter.mtimeMs===archiveBefore.mtimeMs&&readFileSync(archive).equals(archiveBytes),
      "identical install retry replaced the source archive and invalidated active readers");
    // A hash-named artifact must never silently replace corrupted evidence or
    // follow an alias, even when the remote already has that same build.
    writeFileSync(archive,"corrupted retained archive");
    const corruptArchive=await script(["employee","sync"],builder);
    const corruptRetained=readFileSync(archive,"utf8")==="corrupted retained archive";
    writeFileSync(archive,archiveBytes);
    t.assertions.assert(corruptArchive.code!==0&&corruptArchive.stderr.includes("existing content-addressed archive")
      &&corruptRetained&&readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")===archiveReceipt,
      "corrupt archive was overwritten or remote installation changed before refusal");
    const archiveTarget=path.join(t.env.root,"retained-archive.zip");writeFileSync(archiveTarget,archiveBytes);
    unlinkSync(archive);symlinkSync(archiveTarget,archive);
    const aliasArchive=await script(["employee","sync"],builder);
    const aliasRetained=lstatSync(archive).isSymbolicLink();
    unlinkSync(archive);writeFileSync(archive,archiveBytes);
    t.assertions.assert(aliasArchive.code!==0&&aliasArchive.stderr.includes("existing content-addressed archive")
      &&aliasRetained&&readFileSync(archiveTarget).equals(archiveBytes)
      &&readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")===archiveReceipt,
      "archive alias was followed/replaced or changed its external target/remote receipt");
    t.assertions.assert(git(businessTree,"rev-parse","HEAD")===businessHead
      &&git(businessRepo,"worktree","list","--porcelain").includes("worktree "+businessTree)
      &&readFileSync(path.join(businessTree,"scene.txt"),"utf8")==="unfinished scene edit\n"
      &&readFileSync(path.join(declaredRuntime,"spaces/qa/.genethub/open.env"),"utf8")===boundSettings,
      "upgrade lost the registered business worktree, local binding or unfinished edits");
    t.assertions.assert(readlinkSync(dataLink)===outside&&readlinkSync(tempLink)===businessRepo
      &&lstatSync(danglingLink).isSymbolicLink()&&readlinkSync(danglingLink)==="not-created-yet"
      &&readFileSync(outside,"utf8")==="retain unrelated target"&&!existsSync(cachePath),
      "upgrade followed/lost a runtime alias or carried stale owned bytecode");
    // Unowned source is not runtime data, even though normal data is retained.
    const unknownSource=path.join(declaredRuntime,"tools/unowned-source.py");writeFileSync(unknownSource,"VALUE = 'local author input'\n");
    const receiptBeforeUnknown=readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8");
    writeFileSync(path.join(sourceRoot,"tools/version-marker.py"),"VALUE = 'unknown source guard'\n");
    const unknownUpgrade=await script(["employee","sync"],builder);
    t.assertions.assert(unknownUpgrade.code!==0&&unknownUpgrade.stderr.includes("unowned runtime file")
      &&readFileSync(path.join(declaredRuntime,".genethub/install-receipt.json"),"utf8")===receiptBeforeUnknown
      &&readFileSync(unknownSource,"utf8")==="VALUE = 'local author input'\n"
      &&JSON.stringify(incomingDirectories())===retainedStages,"upgrade silently adopted author input or leaked a failed stage");
    unlinkSync(unknownSource);
    // The executor accepts only roles installed for it, even if someone registers another role by hand.
    const intruder=(await cliJson(["space","open",path.join(declaredRuntime,"spaces/research")],true));
    const intruderId=(intruder.workspace??intruder).id;
    const foreign=spawnSync(python,[path.join(declaredRuntime,"tools/team.py"),"receive",JSON.stringify({id:"uninstalled-role",workspaceId:intruderId,role:"research"})],{env:{...o.daemon.env,GENEHUB_CLI:o.daemon.genet},encoding:"utf8"});
    const foreignError=(()=>{try{return JSON.parse(foreign.stdout.trim().split("\n").at(-1)!).error?.what??"";}catch{return "";}})();
    t.assertions.assert(foreign.status!==0&&foreignError.includes("没有安装到这台机器"),"executor accepted a role that was not installed for it: "+foreign.stdout+foreign.stderr);
    await cliJson(["workspace","remove",intruderId],true);
    const declaredStart=await callTask(callerSid,sourceRoot,["task","start","--space","qa","--request-id","declared.owner","--desc","declared owner","Complete one task on the declared machine"]);
    t.assertions.assert(declaredStart.code===0,"declared role did not auto-route without --machine: "+declaredStart.err);
    const declaredTask=JSON.parse(declaredStart.out.trim().split("\n").at(-1)!);
    await t.tools.waitUntil(async()=>{
      const snap=await inspectSession(declaredTask.owner.sessionId,true);
      return snap.summary.coordination?.taskId===declaredTask.taskId&&snap.summary.status==="idle"&&!snap.summary.inputSummary?.pendingMessageIds.length&&snap.items.some((i:any)=>i.type==="assistantMessage");
    },30000);
    t.assertions.assert((await inspectSession(declaredTask.owner.sessionId,true)).summary.workspaceId===declaredBinding.workspaceId,"declared role ran outside its installed workspace");
    const declaredFinish=await callTask(declaredTask.owner.sessionId,declaredRuntime,["task","finish",declaredTask.taskId,"--outcome","success","DECLARED_MACHINE_OWNER_COMPLETE"],true);
    t.assertions.assert(declaredFinish.code===0,"declared Owner could not return: "+declaredFinish.err);
    await t.tools.waitUntil(async()=>{const tick=await script(["hook"]);if(tick.code!==0)throw Error(tick.stderr);return JSON.parse(readFileSync(path.join(sourceRoot,".genethub/team/tasks",declaredTask.taskId+".json"),"utf8")).state==="delivered";},30000);
    // Removing the declaration brings the role home; the old registration is reported, not silently orphaned.
    declare("qa",null);
    const home=await script(["employee","sync"],builder);
    t.assertions.assert(home.code===0,"sync could not bring the role back: "+home.stderr);
    const homeReport=JSON.parse(home.stdout.trim().split("\n").at(-1)!);
    t.assertions.assert(!(JSON.parse(readFileSync(sourceDescriptor,"utf8")).members??[]).some((m:any)=>m.name==="qa")&&homeReport.local.includes("qa")&&homeReport.retained.some((r:any)=>r.role==="qa"&&r.workspaceId===declaredBinding.workspaceId),"undeclared role kept a remote binding or lost the retained registration report: "+home.stdout);
    t.note("real relay + two daemon state directories; one successful stdout lost and recovered; writer/identity/model/pause/reconcile/unknown-create contracts verified");
  } finally {
    sourceClient?.close();
    if (sourceStarted) await sourceCli(["daemon", "stop"]);
    relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop();
  }
});

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-remote-dispatch",
  title: "Fixed team targets dispatch once and hold the executor's writer lock until reconciliation",
  oracle: "Two real daemon directories communicate through a real relay: a lost successful receiver stdout recovers the same session, competing writer and changed identity are rejected, target model/media are validated before a writer lock, system notices preserve pause, an unreachable ledger entry cannot block another completion and executor lock release",
  catches: ["same role short name routes to another team", "two callers write one directory", "lost reply creates duplicate session", "caller model leaks remotely", "remote notice lifts Human pause", "one offline task aborts reconciliation"],
  stages: ["initial-result", "resumed-result", "canceled-release"],
  tags: ["core", "expert", "team-remote"], llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/team.py", "genet-cli", "@genehub/workbench/client"],
  surfaces: ["team-template", "daemon", "relay", "filesystem"],
  expectedDurationMs: 30000, timeoutMs: 180000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 2, browser: 0, pool: "standard" },
}, async t => {
  const python = process.env.GENEHUB_PYTHON!;
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const sourceData = path.join(t.env.root, "caller-data"); mkdirSync(sourceData);
  const sourceEnv = { ...o.daemon.env, GENEHUB_DATA_DIR: sourceData, GENEHUB_LOCAL_DATA_DIR: sourceData, GENEHUB_CLI: o.daemon.genet };
  const sourceCli = (args: string[]) => runGenetAsync(o.daemon.genet, args, sourceEnv);
  const cliJson = async (args: string[], remote = false): Promise<any> => {
    const r = await (remote ? runGenetAsync(o.daemon.genet, args, o.daemon.env) : sourceCli(args));
    if (r.code !== 0) throw new Error(`CLI ${args.slice(0, 2).join(" ")} failed (${r.code})`);
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
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    await o.client.call({ type: "settings.setProvider", payload: { providerId: "deepseek", apiKey: "sk-test", baseUrl: o.mock.origin, label: null, dialect: null, models: ["deepseek-v4-flash", "deepseek-v4-pro", "text-only"], modelInputs: { "deepseek-v4-flash": ["image", "video"], "deepseek-v4-pro": ["image", "video"], "text-only": [] } } });
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
    writeFileSync(wrapper, `import json,os,pathlib,subprocess,sys,time
q=json.loads(sys.argv[-1]); race=pathlib.Path(${JSON.stringify(correctionMarker)})
def summary():
 r=subprocess.run([os.environ['GENEHUB_CLI'],'session','get',q['sessionId']],capture_output=True,text=True)
 return json.loads(r.stdout.strip().splitlines()[-1])['data']['session']['summary']
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
r=subprocess.run([sys.executable,*sys.argv[1:]],capture_output=True,text=True)
p=pathlib.Path(${JSON.stringify(dropped)})
if r.returncode == 0 and not p.exists():
 p.write_text('lost')
 sys.exit(0)
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
`);
    const binding = { machineId: machine, workspaceId: qa.id, command: [python, wrapper, path.join(targetRoot, "tools/team.py")] };
    writeFileSync(path.join(sourceRoot, ".genethub/remote-targets.json"), JSON.stringify({ qa: binding }));
    const script = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(python, ["tools/team.py", ...args], { cwd: sourceRoot, env: sourceEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    const dispatch = ["spawn", "--kind", "work", "--space", "qa", "--machine", machine, "--request-id", "one-task", "--desc", "remote contract", "Complete the check."];
    o.mock.script({ text: "First remote result." }, { text: "Resumed remote result." }, { text: "Queued notice result." });
    const lost = await script(dispatch);
    t.assertions.assert(lost.code !== 0 && lost.stderr.includes("未确认") && existsSync(dropped), "missing reply was not reported as uncertain after actual execution: " + lost.stderr);
    const recovered = await script(dispatch);
    t.assertions.assert(recovered.code === 0, "receipt recovery failed: " + recovered.stderr);
    const pendingDir = path.join(sourceRoot, ".genethub/team/pending"), files = readdirSync(pendingDir).filter(f => f.endsWith(".json"));
    t.assertions.assert(files.length === 1, "one dispatch generated multiple pending sessions");
    const pendingPath = path.join(pendingDir, files[0]!), record = JSON.parse(readFileSync(pendingPath, "utf8"));
    const sessions = (await cliJson(["session", "list", "--workspace", qa.id], true)).sessions;
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
    writeFileSync(path.join(sourceRoot, ".genethub/remote-targets.json"), JSON.stringify({ qa: { ...binding, workspaceId: otherQa.id } }));
    const wrongTeam = await script(dispatch.map(v => v === "one-task" ? "other-team-task" : v));
    t.assertions.assert(wrongTeam.code !== 0 && wrongTeam.stderr.includes("不属于"), "receiver accepted another team's same-named role");
    writeFileSync(path.join(sourceRoot, ".genethub/remote-targets.json"), JSON.stringify({ qa: binding }));
    const badModel = await script([...dispatch.slice(0, -1).map(v => v === "one-task" ? "bad-model" : v), "--model", "missing-model", "Complete the check."]);
    t.assertions.assert(badModel.code !== 0 && badModel.stderr.includes("没有模型"), "missing target model reached creation");
    const badMedia = await script([...dispatch.slice(0, -1).map(v => v === "one-task" ? "bad-media" : v), "--model", "deepseek/text-only", "--media", "image", "Complete the check."]);
    t.assertions.assert(badMedia.code !== 0 && badMedia.stderr.includes("支持"), "text-only target model accepted an image task");
    await t.stage("initial-result", () => t.tools.waitUntil(async () => {
      const snapshot = (await cliJson(["session", "get", record.sessionId], true)).session;
      if (snapshot.summary.status === "failed" || snapshot.summary.inputSummary?.error) throw new Error("initial remote execution failed: " + JSON.stringify(snapshot.summary));
      return snapshot.summary.status === "idle" && !!snapshot.summary.latestReply;
    }, 30000));
    const initialReply = (await cliJson(["session", "get", record.sessionId], true)).session.summary.latestReply.itemId;
    await o.client.call({ type: "session.interrupt", payload: { sessionId: record.sessionId } });
    const beforeConflict = (await cliJson(["session", "get", record.sessionId], true)).session.summary.inputSummary.pendingMessageIds;
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
    const afterConflict = (await cliJson(["session", "get", record.sessionId], true)).session.summary.inputSummary.pendingMessageIds;
    t.assertions.assert(JSON.stringify(beforeConflict) === JSON.stringify(afterConflict), "rejected workspace selector queued a remote message");
    const sent = await script(["send", "--machine", machine, "--workspace", qa.id, "--to", record.sessionId, "Queued while paused."]);
    t.assertions.assert(sent.code === 0 && (await cliJson(["session", "get", record.sessionId], true)).session.summary.inputSummary.paused, "remote send lifted Human pause");
    await t.flows.main.sendPrompt(o.client, record.sessionId, "Resume the task.", null, "u_remote_resume");
    await t.stage("resumed-result", () => t.tools.waitUntil(async () => {
      const s = (await cliJson(["session", "get", record.sessionId], true)).session.summary;
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
    const hook = await script(["hook"]);
    t.assertions.assert(hook.code === 0, "one unreachable target aborted hook: " + hook.stderr);
    t.assertions.assert(existsSync(path.join(sourceRoot, ".genethub/team/done", files[0]!)) && !existsSync(lock), "successful independent task did not close and release target lock");
    const archived = JSON.parse(readFileSync(path.join(sourceRoot, ".genethub/team/done", files[0]!), "utf8"));
    t.assertions.assert(archived.done.reply === (await cliJson(["session", "get", record.sessionId], true)).session.summary.latestReply.itemId, "reconciliation delivered the earlier reply instead of the latest corrected result");
    t.assertions.assert(JSON.parse(readFileSync(path.join(pendingDir, "000-offline.json"), "utf8")).lastReconcileError, "offline task lost its retry evidence");
    // A receiver that crashed before recording a session ID must never retry creation.
    const intentDir = path.join(sourceRoot, ".genethub/team/dispatch");
    const intent = readdirSync(intentDir).map(f => JSON.parse(readFileSync(path.join(intentDir, f), "utf8"))).find(v => v.request.id === "one-task");
    const unknown = { ...intent.request, id: "unknown-create" };
    writeFileSync(path.join(targetRoot, "spaces/qa/.genethub/team/dispatch", createHash("sha256").update(unknown.id).digest("hex") + ".json"), JSON.stringify({ request: unknown, status: "unknown", lock: null }));
    const uncertain = await script(dispatch.map(v => v === "one-task" ? "unknown-create" : v));
    t.assertions.assert(uncertain.code !== 0 && uncertain.stderr.includes("unknown"), "unknown create was retried");
    t.assertions.assert((await cliJson(["session", "list", "--workspace", qa.id], true)).sessions.length === 1, "uncertain creation spawned another session");
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
    o.mock.script({ text: "Fresh first task." }, { text: "Fresh repeated task." });
    const freshArgs = dispatch.filter(v => v !== "--request-id" && v !== "one-task");
    const freshSessions: string[] = [];
    for (let n = 0; n < 2; n++) {
      const fresh = await script(freshArgs);
      t.assertions.assert(fresh.code === 0 && fresh.stdout.includes("派单编号:"), "new spawn did not expose its recovery identity: " + fresh.stderr);
      const taskFile = readdirSync(pendingDir).find(f => f.endsWith(".json") && f !== "000-offline.json");
      t.assertions.assert(!!taskFile, "new spawn returned an archived receipt instead of a new task");
      const task = JSON.parse(readFileSync(path.join(pendingDir, taskFile!), "utf8")); freshSessions.push(task.sessionId);
      await t.tools.waitUntil(async () => { const s = (await cliJson(["session", "get", task.sessionId], true)).session.summary; return s.status === "idle" && !!s.latestReply; }, 30000)
        .catch(async () => { throw new Error("fresh task did not finish: " + JSON.stringify((await cliJson(["session", "get", task.sessionId], true)).session.summary)); });
      const finished = await script(["hook"]);
      t.assertions.assert(finished.code === 0 && !existsSync(lock), "fresh task did not retire its own writer lock");
    }
    t.assertions.assert(freshSessions[0] !== freshSessions[1] && (await cliJson(["session", "list", "--workspace", qa.id], true)).sessions.length === 3, "same-worded new task reused an old session");
    o.mock.script({ text: "A slow remote result.", delayMs: 30000 }, { text: "Canceled worker." });
    const concurrent = await Promise.all(["racer-a", "racer-b"].map(id => script(dispatch.map(v => v === "one-task" ? id : v))));
    t.assertions.assert(concurrent.filter(r => r.code === 0).length === 1 && (await cliJson(["session", "list", "--workspace", qa.id], true)).sessions.length === 4, "concurrent callers admitted zero or multiple writers");
    const raceSession = JSON.parse(readFileSync(lock, "utf8")).session;
    // The actual source timeout interrupts its own task; the executor may
    // release that canceled writer without lifting the durable pause.
    writeFileSync(path.join(sourceRoot, ".genethub/open.env"), "TEAM_AGENT=genet\nTEAM_BOARD_PORT=0\nTEAM_STUCK_AFTER=0\n");
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
    let lastCancelState: unknown;
    await t.stage("canceled-release", () => t.tools.waitUntil(async () => {
      const tick = await script(["hook"]);
      if (tick.code !== 0) throw new Error("timeout reconciliation failed: " + tick.stderr);
      const summaries = (await cliJson(["session", "list", "--workspace", qa.id], true)).sessions;
      lastCancelState = { targetErrors: peerErrors(t.env.data), sourceErrors: peerErrors(sourceData), relay: { exit: relay.process.exitCode, signal: relay.process.signalCode, logTail: relay.logTail().slice(-1500) }, summaries, pending: readdirSync(pendingDir).map(f => JSON.parse(readFileSync(path.join(pendingDir, f), "utf8"))) };
      return !existsSync(lock);
    }, 30000).catch(() => { throw new Error("cancel release did not finish: " + JSON.stringify(lastCancelState)); }));
    const canceled = (await cliJson(["session", "list", "--workspace", qa.id], true)).sessions.find((s: any) => s.id === raceSession);
    t.assertions.assert(canceled?.inputSummary?.paused, "cancel release accidentally resumed the old task");
    t.note("real relay + two daemon state directories; one successful stdout lost and recovered; writer/identity/model/pause/reconcile/unknown-create contracts verified");
  } finally {
    if (sourceStarted) await sourceCli(["daemon", "stop"]);
    relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop();
  }
});

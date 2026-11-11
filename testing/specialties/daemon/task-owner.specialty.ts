import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, openWorkbenchPage, daemonEndpoint, runGenetAsync, parseJson, openBrowser, openPreviewBrowser } from "../../framework/public.ts";

const common = {
  tags: ["core", "task-owner"], llm: { default: "none" as const },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }],
  productInterfaces: ["session.create", "session.get", "genet-cli", "tools/team.py"],
  surfaces: ["daemon", "filesystem", "team-template", "workbench-client"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 180000,
};

defineSpecialty({
  ...common, id: "specialty.daemon.task-owner.creation-recovery",
  title: "Stable creation operations retain one native Session across concurrency, restart and interrupted persistence",
  oracle: "Real public creation retries return one SID, conflicting parameters fail, modified session identity survives retries, an interrupted pre-input creation recovers its original intent, and deletion cannot resurrect it.",
  catches: ["message dedup mistaken for creation dedup", "concurrent retry creates multiple conversations", "retry resets current metadata", "crash loses operation identity", "deleted creation resurrects"],
}, async t => {
  let o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const prepareArgs = ["agent", "run", "--agent", "genet", "--workspace", o.workspaceId, "--creation-id", "prepared.before.business", "--prepare-only", "--no-wait", "BUSINESS_MUST_NOT_RUN_DURING_PREPARE"];
    const prepared = await runGenetAsync(o.daemon.genet, prepareArgs, o.daemon.env);
    t.assertions.assert(prepared.code === 0, "public CLI could not prepare: " + prepared.stderr);
    t.assertions.assert(prepared.stdout.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "session.created").length === 1, "one prepare produced duplicate creation notifications");
    const preparedData = (parseJson(prepared.stdout) as any).data;
    const snapshot = await o.client.call({ type: "session.get", payload: { sessionId: preparedData.sessionId } });
    t.assertions.assert(preparedData.prepared === true && snapshot?.type === "snapshot" && !snapshot.data.items.length && !snapshot.data.summary.inputSummary?.pendingMessageIds.length, "prepare sent business before the caller could persist its relationship");
    const retryPrepare = await runGenetAsync(o.daemon.genet, prepareArgs, o.daemon.env);
    t.assertions.assert(retryPrepare.code === 0 && (parseJson(retryPrepare.stdout) as any).data.sessionId === preparedData.sessionId, "repeated preparation did not retain one SID");
    const payload = { workspaceId: o.workspaceId, agentId: "genet", modelId: null, modeId: null, title: "original creation", cwd: null, creationId: "task.create.original" };
    const create = () => o.client.call({ type: "session.create", payload });
    const replies = await Promise.all(Array.from({ length: 12 }, create));
    const ids = replies.map(r => r?.type === "session" ? r.data.id : "missing");
    const id = ids[0]!;
    t.assertions.assert(id !== "missing" && new Set(ids).size === 1, "one creation operation produced multiple or missing native sessions");
    const catalog = await o.client.call({ type: "session.list", payload: { workspaceId: o.workspaceId, includeArchived: true, lean: true } });
    t.assertions.assert(catalog?.type === "sessions" && catalog.data.filter(s => s.id === id).length === 1, "native catalog did not retain one creation");
    let conflict = false;
    try { await o.client.call({ type: "session.create", payload: { ...payload, title: "different goal" } }); } catch { conflict = true; }
    t.assertions.assert(conflict, "same creation operation accepted conflicting parameters");
    await o.client.call({ type: "session.label", payload: { sessionId: id, add: ["retained"], remove: [] } });
    o.client.close(); o.daemon.stop(); await o.mock.stop();
    o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const again = await create();
    t.assertions.assert(again?.type === "session" && again.data.id === id && again.data.labels?.includes("retained"), "restart retry replaced the original native state");
    // Preserve the real reservation and remove only an unstarted metadata
    // write after stopping the real process: the disk boundary left by a
    // creation interrupted before its first metadata commit, with no input.
    const half = await o.client.call({ type: "session.create", payload: { ...payload, creationId: "task.create.before-meta" } });
    if (half?.type !== "session") throw new Error("interrupted creation baseline missing");
    const halfId = half.data.id;
    o.client.close(); o.daemon.stop(); await o.mock.stop();
    const home = join(t.env.workspace, ".genethub/sessions", halfId);
    t.assertions.assert(existsSync(join(home, "creation.json")), "operation was not persisted before metadata");
    unlinkSync(join(home, "meta.json"));
    o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const recovered = await o.client.call({ type: "session.create", payload: { ...payload, creationId: "task.create.before-meta" } });
    t.assertions.assert(recovered?.type === "session" && recovered.data.id === halfId, "interrupted pre-input creation lost its original identity");
    await o.client.call({ type: "session.delete", payload: { sessionId: id } });
    let deleted = false; try { await create(); } catch { deleted = true; }
    t.assertions.assert(deleted, "old creation operation resurrected a deleted conversation");
    t.note("public native creation, twelve concurrent requests, exact stored intent, real process restart; no model inference");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

defineSpecialty({
  ...common, id: "specialty.daemon.task-owner.session-fanout-and-pause",
  runner: "playwright", resources: { ...common.resources, browser: 1 },
  title: "Two Owners share a Space while fanout, pause, duplicate operations and temporary materials retain task boundaries",
  oracle: "Real Agent-bound task CLI creates two independent Owner sessions in one Space, one Owner dispatches two supports and remains idle-but-waiting, retries keep one task, Human pause survives result delivery, and active old temporary material survives cleanup.",
  catches: ["Space treated as one exclusive worker", "fanout obligations disappear between turns", "unknown or duplicate operation replays business", "ordinary result lifts pause", "cleanup deletes waiting task material"],
}, async t => {
  const r = await openTeam(t, "owner-session-team", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    for (const file of ["front/AGENTS.md", "front/CLAUDE.md", "spaces/leader/AGENTS.md", "spaces/leader/CLAUDE.md"]) {
      const identity = readFileSync(join(r.root, file), "utf8");
      t.assertions.assert(identity.includes("Task Owner") && !identity.includes("自动驱动组长") && !identity.includes("后台研发组长（Leader）"), `Real built identity retains conflicting fixed-leader instructions: ${file}`);
    }
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\n");
    const idle = (id: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(id)).summary;
      return s.status === "idle" && !(s.inputSummary?.pendingMessageIds.length);
    }, 30000);
    const front = await r.create("ctl-cli-command");
    const cli = async (sid: string, args: string[]) => {
      await r.send(sid, JSON.stringify({ argv: ["python3", join(r.root, "tools/team.py"), ...args], cwd: r.root }));
      await idle(sid);
      const messages = (await r.snapshot(sid)).items.filter(i => i.type === "assistantMessage");
      const last = messages.at(-1);
      if (last?.type !== "assistantMessage") throw new Error("real caller Agent returned no outcome");
      return JSON.parse(last.text) as { code: number; out: string; err: string };
    };
    const ok = async (sid: string, args: string[]) => {
      const result = await cli(sid, args);
      t.assertions.assert(result.code === 0, `Agent-bound task ${args.slice(0, 2).join(" ")}: ${result.out.slice(-1000)} ${result.err.slice(-500)}`);
      const line = result.out.trim().split("\n").at(-1)!;
      return JSON.parse(line) as any;
    };
    const begin = ["task", "start", "--space", "leader", "--desc", "first independent goal", "--request-id", "front.goal.A", "Coordinate the first bounded task without a shared write directory"];
    const a = await ok(front, begin), duplicate = await ok(front, begin);
    const b = await ok(front, ["task", "start", "--space", "leader", "--desc", "second independent goal", "--request-id", "front.goal.B", "Complete a separate read-only goal"]);
    const owner = a.owner.sessionId as string, other = b.owner.sessionId as string;
    t.assertions.assert(a.parallelism?.target===5 && a.parallelism.minimum===2 && a.parallelism.unknown>=1 && a.parallelism.inFlight===0, "new Owner was counted as observed work before its first reconciliation or lacked a decision signal");
    t.assertions.assert(a.taskId === duplicate.taskId && owner === duplicate.owner.sessionId && owner !== other, "task retry replayed creation or the Space prevented independent Owner sessions");
    await idle(owner); await idle(other);
    const wrong = await cli(front, [...begin.slice(0, -1), "different task under the same operation"]);
    t.assertions.assert(wrong.code !== 0, "task ID accepted another goal");
    const supports = [];
    for (let n = 0; n < 2; n++) {
      const result = await ok(owner, ["task", "support", a.taskId, "--space", "qa", "--desc", `independent support ${n}`, "--request-id", `support.${n}`, "Produce a bounded read-only check; wait for explicit task finish"]);
      supports.push(result.collaborator as string);
    }
    for (const sid of supports) await idle(sid);
    const { mkdirSync } = await import("node:fs");
    const supportDirectory = join(r.root, "support-owned-directory"); mkdirSync(supportDirectory);
    const supportBinding = await ok(supports[0]!, ["task", "bind-directory", a.taskId, "--directory", supportDirectory]);
    t.assertions.assert(supportBinding.sessionId === supports[0] && !JSON.parse(readFileSync(r.state("tasks", a.taskId + ".json"), "utf8")).executionBinding, "collaborator could not bind its own resource independently from the root Owner");
    r.ok(["hook"]);
    await t.tools.waitUntil(async () => {
      const s = (await r.snapshot(owner)).summary;
      return s.status === "idle" && s.coordination?.pending === 2;
    }, 15000);
    const decision=await ok(front,["task","status",a.taskId]);
    t.assertions.assert(decision.parallelism?.inFlight===3 && decision.parallelism.unknown===0 && decision.parallelism.unsettled===3, "task status lost independent Owner/support in-flight facts");
    const ownerSummary = (await r.snapshot(owner)).summary;
    const browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(r.daemon), ownerSummary.workspaceId, owner);
    try {
      await browser.page.getByRole("button", { name: "当前项目", exact: true }).waitFor();
      await browser.page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
      const row = browser.page.getByRole("complementary", { name: "会话列表", exact: true }).locator(".conversation-row").filter({ hasText: "first independent goal" });
      await browser.page.getByRole("button", { name: /团队内部/ }).click();
      t.assertions.assert(await row.count()===1,"Owner was duplicated in the conversation list");
      await row.getByRole("img",{name:"等待协作 2 项",exact:true}).first().waitFor();
      t.assertions.assert((await r.snapshot(owner)).summary.status === "idle", "UI waiting changed native runnable state");
    } finally { await browser.close(); }
    const board = await cli(front, ["board", "refresh"]);
    t.assertions.assert(board.code === 0, "real bound Agent could not generate Team board: " + board.err);
    const boardBrowser = await openBrowser({}, { trace: false });
    const boardPreview = await openPreviewBrowser({ openRoot: t.openRoot, lease: t.env, page: boardBrowser.page, endpoint: daemonEndpoint(r.daemon), workspaceId: r.project.id, entryPath: join(r.root, "datas/board/index.html") });
    try {
      const frame = boardBrowser.page.frameLocator('iframe[title="HTML 文件预览"]');
      const leaderRow = frame.locator("#members-tbody tr").filter({ hasText: "研发组长" });
      const details = leaderRow.locator("details");
      await details.getByText(/查看本岗位活动/).click();
      await details.getByText("first independent goal", { exact: true }).waitFor();
      await details.getByText("second independent goal", { exact: true }).waitFor();
      await details.getByText("等待协作 2 项", { exact: true }).waitFor();
    } finally { await boardPreview.close(); await boardBrowser.close(); }
    const savedBoard = readFileSync(join(r.root, "datas/board/live.json"), "utf8");
    const rejectedBoard = r.command(["board", "refresh"], { GENEHUB_SESSION_ID: front, GENEHUB_CONTROLLER_TOKEN: "invalid-controller-token", GENEHUB_EXECUTION_LEASE: "invalid-lease" });
    t.assertions.assert(rejectedBoard.code !== 0 && readFileSync(join(r.root, "datas/board/live.json"), "utf8") === savedBoard, "board dropped the caller identity or replaced failed reads with zero sessions");
    const second = (await r.snapshot(other)).summary;
    t.assertions.assert(second.status === "idle" && second.coordination?.active && !second.coordination.pending, "unrelated task inherited another Owner's dependencies");
    const temp = await cli(owner, ["temp", "new", "owner-material", "--purpose", "retain while waiting"]);
    t.assertions.assert(temp.code === 0, "could not allocate actual session temp");
    const directory = temp.out.trim();
    const metadata = join(directory, ".temp.json");
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 15 * 86400000);
    utimesSync(metadata, old, old); utimesSync(directory, old, old);
    r.ok(["temp", "clean", "--older-than", "0d"]);
    t.assertions.assert(existsSync(directory), "mtime cleanup removed an active waiting Owner's material");
    const premature = await cli(owner, ["task", "finish", a.taskId, "--outcome", "success", "No support results yet"]);
    t.assertions.assert(premature.code !== 0, "unsettled support was accepted as successful task completion");
    await r.client.call({ type: "session.interrupt", payload: { sessionId: owner } });
    for (const sid of supports) {
      await ok(sid, ["task", "finish", a.taskId, "--outcome", "success", "Independent supporting evidence recorded"]);
    }
    r.ok(["hook"]);
    await t.tools.waitUntil(async () => (await r.snapshot(owner)).summary.coordination?.ready! > 0, 15000);
    t.assertions.assert((await r.snapshot(owner)).summary.inputSummary?.paused, "ordinary fanout results resumed a Human-paused Owner");
    const pausedDecision=await ok(front,["task","status",a.taskId]);
    t.assertions.assert(pausedDecision.parallelism?.inFlight===0 && pausedDecision.parallelism.paused===1, "paused Owner or concluded supports inflated the decision-point in-flight count");
    const wakeText=readFileSync(join(r.root,".genethub/team/inbox",owner+".jsonl"),"utf8");
    t.assertions.assert(wakeText.includes("本任务在途") && wakeText.includes("目标5") && wakeText.includes("R6"), "queued real result lacked its decision-point context");
    t.note("same Space, two actual Owner sessions; exact Agent-bound dispatch; two required support receipts; native idle plus collaboration view; paused handoff retained");
  } finally { await r.dispose(); }
});

defineSpecialty({
  ...common, id: "specialty.daemon.task-owner.control-and-projection-recovery",
  title: "Task controls fence revisions, retain pause, transfer one writer and cancel only stopped work",
  oracle: "Real Agent-bound controls pause and explicitly resume the original Owner, reject conflicting revisions and unsupported cross-machine transfer before effects, hand over one directory lock to a new local session, cancel the new Owner without reviving the previous one, and corrupt/missing projection remains visibly unknown across restart.",
  catches: ["task control overwrites newer ledger", "handover moves ownership without its writer", "cancel claims stopped on interrupt acknowledgement", "missing coordination silently appears idle"],
}, async t => {
  const r = await openTeam(t, "owner-control-team", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const front = await r.create("ctl-cli-command");
    const cli = async (sid: string, args: string[]) => {
      await r.send(sid, JSON.stringify({ argv: ["python3", join(r.root, "tools/team.py"), ...args], cwd: r.root }));
      await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(i => i.type === "assistantMessage").at(-1);
      if (item?.type !== "assistantMessage") throw new Error("caller returned no public reply");
      return JSON.parse(item.text) as { code: number; out: string; err: string };
    };
    const ok = async (sid: string, args: string[]) => {
      const result = await cli(sid, args);
      t.assertions.assert(result.code === 0, `${args.slice(0, 2)}: ${result.out.slice(-500)} ${result.err.slice(-500)}`);
      return JSON.parse(result.out.trim().split("\n").at(-1)!);
    };
    const a = await ok(front, ["task", "start", "--space", "leader", "--desc", "control bounded task", "--request-id", "control.task", "Retain ownership until explicit completion"]);
    const owner = a.owner.sessionId as string;
    await idle(owner);
    const { mkdirSync } = await import("node:fs");
    const directory = join(r.root, "owned-directory"); mkdirSync(directory);
    const binding = await ok(owner, ["task", "bind-directory", a.taskId, "--directory", directory]);
    const oldMaterial = await cli(owner, ["temp", "new", "handover-material", "--purpose", "retain the original Owner evidence"]);
    t.assertions.assert(oldMaterial.code === 0, "original Owner material creation failed");
    const oldMaterialPath = oldMaterial.out.trim();
    const { utimesSync } = await import("node:fs");
    const oldMaterialTime = new Date(Date.now() - 15 * 86400000);
    utimesSync(join(oldMaterialPath, ".temp.json"), oldMaterialTime, oldMaterialTime);
    const control = (action: string, operation: string, revision: number, extra: string[] = []) =>
      ["task", action, a.taskId, "--request-id", operation, "--expected-revision", String(revision), ...extra];
    const task = () => JSON.parse(readFileSync(join(r.root, ".genethub/team/tasks", a.taskId + ".json"), "utf8"));
    const settle = (state: string) => t.tools.waitUntil(async () => { r.ok(["hook"]); return task().state === state; }, 15000);
    await ok(front, control("pause", "control.pause", 1)); await settle("paused");
    t.assertions.assert((await r.snapshot(owner)).summary.inputSummary?.paused, "task pause did not retain native Human pause");
    await ok(front, control("pause", "control.pause", 1));
    const conflict = await cli(front, control("resume", "control.pause", 1));
    t.assertions.assert(conflict.code !== 0 && task().revision === 2, "control identity accepted a changed operation");
    await ok(front, control("resume", "control.resume", 2, ["Explicitly continue the original goal"])); await settle("active"); await idle(owner);
    t.assertions.assert(!(await r.snapshot(owner)).summary.inputSummary?.paused, "explicit continuation failed to resume the original Owner");
    const next = await r.create("ctl-cli-command");
    const unsupported = await cli(front, control("handover", "control.remote", 3, ["--session", next, "--machine", "offline-machine"]));
    t.assertions.assert(unsupported.code !== 0 && task().owner.sessionId === owner && !(await r.snapshot(owner)).summary.inputSummary?.paused, "unsupported transfer changed ownership or interrupted original Owner");
    await ok(front, control("handover", "control.handover", 3, ["--session", next])); await settle("active"); await idle(next);
    t.assertions.assert(task().owner.sessionId === next && JSON.parse(readFileSync(binding.lock, "utf8")).session === next, "handover did not atomically retain one directory writer");
    r.ok(["temp", "clean", "--older-than", "0d"]);
    t.assertions.assert(existsSync(oldMaterialPath), "handover dropped references to the previous Owner material while the task remained active");
    await ok(front, control("cancel", "control.cancel", 4)); await settle("canceled");
    t.assertions.assert(!existsSync(binding.lock) && (await r.snapshot(owner)).summary.inputSummary?.paused && (await r.snapshot(next)).summary.inputSummary?.paused, "cancel released a running writer or revived a superseded Owner");
    const projection = join(r.root, ".genethub/session-coordination.json");
    writeFileSync(projection, "{broken");
    await t.tools.waitUntil(async () => !!(await r.snapshot(front)).summary.coordination?.stale, 10000);
    unlinkSync(projection);
    await t.tools.waitUntil(async () => !!(await r.snapshot(front)).summary.coordination?.stale, 10000);
    r.ok(["hook"]);
    await t.tools.waitUntil(async () => !(await r.snapshot(front)).summary.coordination?.stale, 10000);
    t.note("native Agent-bound commands and real daemon summaries; no synthetic task status injection; unknown projection remains visible until timer rebuild");
  } finally { await r.dispose(); }
});

defineSpecialty({
  ...common, id:"specialty.daemon.task-owner.ready-result-queue",
  title:"Ready children enter a busy Owner's native queue and release independent resources before that Owner finishes its round",
  oracle:"A real Owner Agent runs a gate-controlled operation with a 100-minute cap. Each child queues in one tick despite that running round and an unfinished sibling; its exact lease is released, duplicate ticks preserve one input, and public finish fails until native consumption then succeeds.",
  catches:["result waits for a parent round or unfinished sibling", "local lease waits for parent consumption", "parent finishes after conclusion but before reading", "tick duplicates an unread result"],
},async t=>{
  const r=await openTeam(t,"ready-result-queue",[{id:"ctl-cli-command",profile:"cli-command"}]);
  const release=join(r.root,"release-parent-operation");
  try {
    const config=join(r.root,".genethub/open.env");writeFileSync(config,readFileSync(config,"utf8")+"\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle=(sid:string)=>t.tools.waitUntil(async()=>{const s=(await r.snapshot(sid)).summary;return s.status==="idle"&&!s.inputSummary?.pendingMessageIds.length;},30000);
    const cli=async(sid:string,args:string[])=>{
      await r.send(sid,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,join(r.root,"tools/run.py"),...args],cwd:r.root}));await idle(sid);
      const reply=(await r.snapshot(sid)).items.filter(i=>i.type==="assistantMessage").at(-1);
      if(reply?.type!=="assistantMessage")throw new Error("Agent CLI had no result");return JSON.parse(reply.text) as {code:number;out:string;err:string};
    };
    const ok=async(sid:string,args:string[])=>{const v=await cli(sid,args);t.assertions.assert(v.code===0,"public Task command failed: "+v.err);return JSON.parse(v.out.trim().split("\n").at(-1)!);};
    const front=await r.create("ctl-cli-command");
    const task=await ok(front,["task","start","--space","leader","--desc","busy parent","--request-id","ready.parent","Coordinate independent evidence"]);
    const owner=task.owner.sessionId as string;await idle(owner);
    const children=[] as string[];
    for(let n=0;n<2;n++){const c=await ok(owner,["task","support",task.taskId,"--space","qa","--desc","ready child "+n,"--request-id","ready.child."+n,"Complete independent evidence"]);children.push(c.collaborator);await idle(c.collaborator);}
    const {mkdirSync}=await import("node:fs");const dir=join(r.root,"child-resource");mkdirSync(dir);
    const binding=await ok(children[0]!,["task","bind-directory",task.taskId,"--directory",dir]);
    const gate=join(r.root,"long-operation.py"),started=join(r.root,"parent-operation-started"),attempt=join(r.root,"attempt-parent-finish"),attempted=join(r.root,"parent-finish-attempt.json");
    writeFileSync(gate,`import os,time,json,subprocess\nfrom pathlib import Path\nroot=Path(${JSON.stringify(r.root)})\n(root/'parent-operation-started').write_text('100-minute-cap operation')\nend=time.monotonic()+6000\nwhile not (root/'release-parent-operation').exists():\n if time.monotonic()>end:raise RuntimeError('fixture operation deadline reached')\n if (root/'attempt-parent-finish').exists():\n  (root/'attempt-parent-finish').unlink()\n  r=subprocess.run([${JSON.stringify(process.env.GENEHUB_PYTHON)},str(root/'tools/run.py'),'task','finish',${JSON.stringify(task.taskId)},'--outcome','success','Attempt finish before reading child results'],capture_output=True,text=True)\n  (root/'parent-finish-attempt.json').write_text(json.dumps({'code':r.returncode,'out':r.stdout,'err':r.stderr}))\n time.sleep(.02)\nprint('long operation released by fixture')\n`);
    await r.send(owner,JSON.stringify({argv:[process.env.GENEHUB_PYTHON!,gate],cwd:r.root}));
    await t.tools.waitUntil(async()=>existsSync(started)&&(await r.snapshot(owner)).summary.status==="running",10000);
    const resultRows=async()=>{
      const rows=(await r.snapshot(owner)).items.filter(i=>i.type==="userMessage"&&i.text.startsWith("用途: result\n"));return rows;
    };
    for(let n=0;n<2;n++){
      await ok(children[n]!,["task","finish",task.taskId,"--outcome","success","READY_CHILD_EVIDENCE_"+n]);
      const before=Date.now();r.ok(["hook"]);const elapsed=Date.now()-before;
      const rows=await resultRows();const found=rows.find(i=>i.type==="userMessage"&&i.text.includes("READY_CHILD_EVIDENCE_"+n));
      t.assertions.assert(!!found&&elapsed<15000&&(await r.snapshot(owner)).summary.status==="running",
        "one tick held a ready child behind the running parent or sibling: "+JSON.stringify({n,elapsed}));
      t.assertions.assert((await r.snapshot(owner)).summary.inputSummary?.pendingMessageIds.includes(found!.id),"result bypassed the native input queue");
      t.assertions.assert(!existsSync(binding.lock),"completed child's resource still waits for parent delivery/consumption");
    }
    writeFileSync(attempt,"finish now");await t.tools.waitUntil(()=>existsSync(attempted),15000);
    const refused=JSON.parse(readFileSync(attempted,"utf8"));
    t.assertions.assert(refused.code!==0&&!JSON.parse(readFileSync(r.state("tasks",task.taskId+".json"),"utf8")).finished,
      "all children concluded but unread results allowed the parent to finish");
    r.ok(["hook"]);
    for(let n=0;n<2;n++)t.assertions.assert((await resultRows()).filter(i=>i.type==="userMessage"&&i.text.includes("READY_CHILD_EVIDENCE_"+n)).length===1,"unread result was queued twice");
    writeFileSync(release,"release");await idle(owner);
    await ok(owner,["task","finish",task.taskId,"--outcome","success","Read all independently queued child evidence"]);
    r.ok(["hook"]);await idle(front);r.ok(["hook"]);
    t.assertions.assert(JSON.parse(readFileSync(r.state("tasks",task.taskId+".json"),"utf8")).state==="delivered","native consumption did not unblock final delivery");
    t.note("Real Agent-bound 100-minute-cap operation held until assertions, not a claim of 100 elapsed minutes; two independent native inputs, prompt lease release, finish rejected before read then accepted, exact-once ticks.");
  } finally {writeFileSync(release,"fixture cleanup");await r.dispose();}
});

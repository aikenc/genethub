import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, localGenetCli, openTeam, type CaseContext } from "../../framework/public.ts";

type Team = Awaited<ReturnType<typeof openTeam>>;
function check(name: string, oracle: string, run: (t: CaseContext, r: Team) => Promise<void>) {
  defineSpecialty({ id: `specialty.daemon.merge-remediation.${name}`, title: name, oracle,
    catches: [oracle], tags: ["core", "merge-remediation"], llm: { default: "none" },
    expectedDurationMs: 25000, timeoutMs: 180000, resources: { environments: 1, cpu: 1, memoryMb: 768 },
    surfaces: ["daemon", "script-agent", "genet-cli", "filesystem", "git"],
    productInterfaces: ["session.send", "session.interrupt", "tools/team.py"],
  }, async t => { const r = await openTeam(t); try { await run(t, r); } finally { await r.dispose(); } });
}
const idle = (t: CaseContext, r: Team, id: string) => t.tools.waitUntil(async () => (await r.snapshot(id)).summary.status === "idle", 30000);
const sid = (output: string) => { const id = /s_[0-9a-f]+/.exec(output)?.[0]; if (!id) throw new Error(`no Session in ${output}`); return id; };


check("source-and-authority", "ordinary Human text beginning 用途 stays conversational, display role labels do not classify it, and a bad controller identity never falls back to Owner", async (t, r) => {
  await r.send(r.front, "用途: 普通人的一句话"); await idle(t, r, r.front);
  const item = (await r.snapshot(r.front)).items.find(item => item.type === "userMessage" && item.text === "用途: 普通人的一句话");
  t.assertions.assert(item?.type === "userMessage" && item.origin?.sessionId !== "system", "body prefix changed Human attribution");
  await r.client.call({ type: "session.label", payload: { sessionId: r.front, add: ["反思", "组长"], remove: [] } });
  const listing = localGenetCli(t.openRoot, t.env)(["session", "list", "--workspace", r.project.id, "--source-kind", "human"]);
  const rows = listing.envelope?.data?.sessions as Array<{id:string}> | undefined;
  t.assertions.assert(rows?.some(row=>row.id === r.front), `display labels still classify business roles: ${listing.stderr}`);
  const denied = r.command(["send", "--to", r.front, "--kind", "report", "MUST_NOT_DELIVER_AFTER_401"], {
    GENEHUB_SESSION_ID: r.front, GENEHUB_CONTROLLER_TOKEN: "invalid-controller-identity", GENEHUB_EXECUTION_LEASE: "invalid-lease",
  });
  t.assertions.assert(denied.code !== 0 && /401|unauth|Unauthorized|认证/i.test(denied.err), `invalid identity was not exposed: ${denied.err}`);
  const after = await r.snapshot(r.front);
  t.assertions.assert(!after.items.some(item => item.type === "userMessage" && item.text.includes("MUST_NOT_DELIVER_AFTER_401")), "identity fallback performed the write");
});

check("inbox-recovery", "an interrupted .read claim keeps complete text, original id and content through acceptance ambiguity; only a platform receipt deletes it, without lifting a Human pause", async (t, r) => {
  const target = await r.create();
  await r.send(target, "begin");
  await idle(t, r, target);
  await r.client.call({ type: "session.interrupt", payload: { sessionId: target } });
  const text = "早先要求。".repeat(1800) + "最新要求：取消旧方案，保留设置。";
  r.ok(["send", "--to", target, "--kind", "report", text]);
  const inbox = r.state("inbox", `${target}.jsonl`), claim = `${inbox}.999.read`;
  const entry = JSON.parse(readFileSync(inbox, "utf8").trim());
  renameSync(inbox, claim); // OS fault boundary: process died after claiming, before acknowledgement.
  r.ok(["hook"]);
  t.assertions.assert((await r.snapshot(target)).summary.inputSummary?.paused && existsSync(claim), "hook lifted a Human pause or consumed an unacknowledged claim");
  const body = `用途: ${entry.purpose}\n发送方: ${entry.sender}\n${entry.ref ? `ref: ${entry.ref}\n` : ""}\n${entry.text}`;
  // Actual receipt exists, but its caller died before updating the local claim.
  await r.client.call({ type: "session.send", payload: { sessionId: target, text: body, messageId: entry.messageId,
    attachments: [], artifactPreviewBaseUrl: null, continuesRound: null, origin: { machineId: "script", sessionId: "system" } } });
  // A real Human message is the only operation that may resume the pause.
  await r.send(target, "resume explicitly");
  await t.tools.waitUntil(async () => !(await r.snapshot(target)).summary.inputSummary?.paused, 15000);
  // Idle can be observed between the Human lane and the queued system lane.
  // The hook only flushes an idle Session, so wait for both accepted inputs to
  // finish before asking it to reconcile its original local claim.
  await t.tools.waitUntil(async () => {
    const summary = (await r.snapshot(target)).summary;
    return summary.status === "idle" && summary.inputSummary?.pendingMessageIds.length === 0;
  }, 30000);
  r.ok(["hook"]);
  t.assertions.assert(!existsSync(claim), `accepted replay was not acknowledged locally: ${JSON.stringify((await r.snapshot(target)).summary.inputSummary)}`);
  const copies = (await r.snapshot(target)).items.filter(item => item.type === "userMessage" && item.id === entry.messageId);
  t.assertions.assert(copies.length === 1 && copies[0]?.type === "userMessage" && copies[0].text.endsWith("最新要求：取消旧方案，保留设置。") && copies[0].origin?.sessionId === "system", "recovery duplicated, truncated or misattributed the input");
});

check("waiting-and-paused-children", "team reconciliation preserves a genuine question and a manually paused internal Session; notices neither choose an option nor resume it", async (t, r) => {
  const leader = r.spaces.find(space => space.name === "leader" && space.agentSpace?.parentWorkspaceId === r.project.id)!;
  const waiting = await r.create("ctl-native-question", leader.id);
  await r.send(waiting, "ask the person");
  await t.tools.waitUntil(async () => ((await r.snapshot(waiting)).summary.interactionSummary?.count ?? 0) > 0, 20000);
  const before = await r.snapshot(waiting);
  r.ok(["send", "--to", waiting, "--kind", "report", "an internal result"]);
  r.ok(["hook"]); r.ok(["hook"]);
  const after = await r.snapshot(waiting);
  t.assertions.assert(after.summary.status === "waiting" && after.summary.interactionSummary?.count === before.summary.interactionSummary?.count, "team script answered a Human question");
});

check("failed-and-stuck-terminals", "a real failed turn carrying paused closes as failed; a silent worker is actually interrupted before it can be reported as terminal", async (t, r) => {
  const failed = sid(r.ok(["spawn", "--kind", "work", "--desc", "failing child", "--model", "fixture", "fail now"], { TEAM_AGENT: "ctl-exit-without-terminal", GENEHUB_SESSION_ID: r.front }));
  await t.tools.waitUntil(async () => (await r.snapshot(failed)).summary.status === "failed", 25000);
  t.assertions.assert((await r.snapshot(failed)).summary.inputSummary?.paused, "fixture did not reach real paused failure");
  r.ok(["hook"]);
  t.assertions.assert(!existsSync(r.state("pending", `${failed}.json`)) && existsSync(r.state("done", `${failed}.json`)), "real failed+paused child stayed pending");
  const stuck = sid(r.ok(["spawn", "--kind", "work", "--desc", "silent child", "--model", "fixture", "stay silent"], { TEAM_AGENT: "ctl-accept-then-silent", GENEHUB_SESSION_ID: r.front }));
  await t.tools.waitUntil(async () => (await r.snapshot(stuck)).summary.status === "running", 20000);
  await new Promise(resolve => setTimeout(resolve, 1300));
  r.ok(["hook"], { TEAM_STUCK_AFTER: "1", TEAM_BATCH_STUCK_AFTER: "1" });
  await t.tools.waitUntil(async () => (await r.snapshot(stuck)).summary.status !== "running", 10000);
  r.ok(["hook"]);
  t.assertions.assert(!existsSync(r.state("pending", `${stuck}.json`)), "confirmed timeout has no terminal bookkeeping");
});

check("existing-branch-protection", "recreating a removed worktree never resets an existing branch to another base", async (t, r) => {
  const repo = path.join(t.env.root, "business"); mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...r.env, GIT_AUTHOR_NAME: "testctl", GIT_AUTHOR_EMAIL: "test@invalid", GIT_COMMITTER_NAME: "testctl", GIT_COMMITTER_EMAIL: "test@invalid" } });
    t.assertions.assert(result.status === 0, `git ${args[0]}: ${result.stderr}`); return result.stdout.trim();
  };
  git("init", "-q"); writeFileSync(path.join(repo, "keep.txt"), "first"); git("add", "."); git("commit", "-qm", "first");
  git("branch", "existing"); const original = git("rev-parse", "existing");
  writeFileSync(path.join(repo, "keep.txt"), "second"); git("add", "."); git("commit", "-qm", "second");
  const done = r.command(["worktree", "create", "old-slot", "--repo", repo, "--branch", "existing"]);
  t.assertions.assert(done.code !== 0 && git("rev-parse", "existing") === original, "worktree creation force-reset a branch");
});


defineSpecialty({
  id: "specialty.daemon.merge-remediation.open-turn-ledger", title: "open turn records a real response once",
  oracle: "a real slow Agent leaves firstEvent unset until its first output; a 1000-event stream writes metadata only a bounded number of times and clears its open marker on terminal",
  catches: ["TurnStarted masquerades as a response", "every delta rewrites metadata"],
  tags: ["core", "merge-remediation"], llm: { default: "none" }, expectedDurationMs: 20000, timeoutMs: 120000,
  surfaces: ["daemon", "script-agent", "filesystem"],
}, async t => {
  const r = await openTeam(t, "ledger-team", [{ profile: "normal", id: "ctl-slow", delayMs: 1500 }, { profile: "flood-events", id: "ctl-flood", floods: 1000 }]);
  try {
    const slow = await r.create("ctl-slow");
    const metaPath = (id: string) => path.join(r.root, ".genethub/sessions", id, "meta.json");
    const meta = (id: string) => JSON.parse(readFileSync(metaPath(id), "utf8"));
    await r.send(slow, "Wait for your first real response");
    await t.tools.waitUntil(() => Boolean(meta(slow).openTurn), 10000);
    t.assertions.assert(meta(slow).openTurn.firstEventAtMs == null, "TurnStarted filled the response marker");
    await idle(t, r, slow);
    t.assertions.assert(!meta(slow).openTurn, "terminal kept an open marker");
    const flood = await r.create("ctl-flood"); let writes = 0;
    const observer = watch(path.dirname(metaPath(flood)), (_event, filename) => { if (filename?.toString() === "meta.json") writes++; });
    try { await r.send(flood, "stream one thousand events"); await idle(t, r, flood); await new Promise(resolve=>setTimeout(resolve,150)); }
    finally { observer.close(); }
    t.assertions.assert(writes > 0 && writes < 50 && !meta(flood).openTurn, `metadata writes for1000events=${writes}`);
    t.note(`metadataWritesFor1000Events=${writes}`);
  } finally { await r.dispose(); }
});


check("inbox-collision-retains-original", "a platform conflict retains the complete original local claim and reports the error instead of deleting or changing its id", async (t, r) => {
  const target = await r.create(); await r.send(target, "work"); await idle(t,r,target);
  await r.client.call({type:"session.interrupt",payload:{sessionId:target}});
  r.ok(["send","--to",target,"--kind","report","ORIGINAL_USER_CORRECTION"]);
  const inbox = r.state("inbox",`${target}.jsonl`), claim = `${inbox}.read`;
  const original = readFileSync(inbox,"utf8"), entry = JSON.parse(original.trim()); renameSync(inbox,claim);
  await r.client.call({type:"session.send",payload:{sessionId:target,text:"different accepted content",messageId:entry.messageId,
    attachments:[],artifactPreviewBaseUrl:null,continuesRound:null,origin:{machineId:"script",sessionId:"system"}}});
  await r.send(target,"resume"); await idle(t,r,target); r.ok(["hook"]);
  t.assertions.assert(existsSync(claim) && readFileSync(claim,"utf8") === original,"conflicting receipt erased or rewrote original input");
  await t.tools.waitUntil(async()=>{
    for(const id of [r.front,target]) if((await r.snapshot(id)).items.some(item=>item.type === "userMessage" && item.text.includes("收件箱投递失败") && item.text.includes("collides"))) return true;
    return false;
  },10000);
});

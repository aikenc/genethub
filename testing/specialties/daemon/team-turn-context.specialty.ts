import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, readScriptAgentJournal, registerControlledAgent, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-turn-context",
  title: "Each real Agent turn receives current bounded Team observations without changing its user timeline or pause",
  oracle: "Real SDK Agents report only whether a known marker reached each actual prompt. A case-owned observation file is added/cleared/restored between turns; missing, stale, aliased and oversized observations stay unknown, an ordinary workspace has no Team context, actual blocked Task conclusion is distinct from control state, and system input cannot resume a real user pause.",
  catches: ["Team context only exists at process creation", "business cwd hides Team root", "stale or missing observation is treated as healthy", "read-only context becomes a user message or permission", "ordinary workspace inherits Team data", "recorded blocked conclusion is mistaken for no conclusion"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["session.send", "session.get", "session.interrupt", "tools/run.py task", "agent-serve-protocol-1 session.send"],
  surfaces: ["daemon", "agent-protocol", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const red = registerControlledAgent(t.env, { id: "ctl-brief-red", profile: "normal", expectedResume: "fixture-red-context" });
  const absent = registerControlledAgent(t.env, { id: "ctl-brief-unknown", profile: "normal", expectedResume: "live-state-unavailable" });
  const stale = registerControlledAgent(t.env, { id: "ctl-brief-stale", profile: "normal", expectedResume: "live-state-stale" });
  const outcome = registerControlledAgent(t.env, { id: "ctl-brief-outcome", profile: "cli-command", expectedResume: '"recordedOutcome":"blocked"' });
  const r = await openTeam(t, "turn-context", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const leader = r.spaces.find(x => x.name === "leader" && x.agentSpace?.parentWorkspaceId === r.project.id)!;
    const idle = (sid: string) => t.tools.waitUntil(async () => { const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length; }, 30000);
    const marker = (handle: { journalPath: string }) => readScriptAgentJournal(handle).filter(x => x.event === "continuation-received").at(-1)?.matched;
    const file = r.state("quality", "live-alerts.json"); mkdirSync(join(r.root, ".genethub/team/quality"), { recursive: true });
    const observation = (withRed: boolean, at = Date.now()) => writeFileSync(file, JSON.stringify({ schema: "team-quality-live-alerts/1", asOfMs: at, redLines: withRed ? [{ id: "fixture-red-context", rule: "R6", workItemId: "fixture-observation-only" }] : [], unknown: [], warnings: [], fixture: "case-owned observational input, no native execution claim" }));
    observation(true);
    const businessCwd = join(leader.root, "deep", "business", "working"); mkdirSync(businessCwd, { recursive: true });
    const createdSubject = await r.client.call({ type: "session.create", payload: { workspaceId: leader.id,
      agentId: red.agentId, modelId: null, modeId: null, title: "Deep business cwd", cwd: businessCwd } });
    if (createdSubject?.type !== "session") throw Error("actual Session with business cwd missing");
    const subject = createdSubject.data.id;
    t.assertions.assert((await r.snapshot(subject)).summary.cwd === businessCwd, "native Session did not retain the explicit business cwd");
    await r.send(subject, "First ordinary business input"); await idle(subject);
    t.assertions.assert(marker(red) === true, "actual first Agent turn did not receive its Team redline");
    observation(false); await r.send(subject, "Second ordinary business input"); await idle(subject);
    t.assertions.assert(marker(red) === false, "existing Agent kept a removed Team observation");
    observation(true); await r.send(subject, "Third ordinary business input"); await idle(subject);
    t.assertions.assert(marker(red) === true, "existing Agent did not refresh a restored Team observation");
    const view = await r.snapshot(subject), users = view.items.filter(x => x.type === "userMessage");
    t.assertions.assert(users.some(x => x.type === "userMessage" && x.text.includes("Third ordinary business input"))
      && !users.some(x => x.type === "userMessage" && (x.text.includes("fixture-red-context") || x.text.includes("team-turn-context/1"))),
      "read-only Team metadata changed the actual user timeline");
    await r.client.call({ type: "session.interrupt", payload: { sessionId: subject } });
    await t.tools.waitUntil(async () => (await r.snapshot(subject)).summary.inputSummary?.paused === true, 10000);
    const count = readScriptAgentJournal(red).filter(x => x.event === "continuation-received").length;
    const sent = await runGenetAsync(r.daemon.genet, ["session", "send", subject, "Queued system information", "--system", "--message-id", "brief.paused.system", "--no-wait"], r.env);
    t.assertions.assert(sent.code === 0 && (await r.snapshot(subject)).summary.inputSummary?.paused === true
      && readScriptAgentJournal(red).filter(x => x.event === "continuation-received").length === count,
      "Team observation resumed a genuine user pause");
    await r.send(subject, "Explicit user continuation"); await idle(subject);
    const ordinaryRoot = join(t.env.root, "ordinary-project"); mkdirSync(ordinaryRoot);
    await r.client.call({ type: "workspace.open", payload: { root: ordinaryRoot } });
    const catalog = await r.client.call({ type: "workspace.list" }); if (catalog?.type !== "workspaces") throw Error("workspace catalog absent");
    const ordinary = catalog.data.find(x => x.root === ordinaryRoot)!;
    const other = await r.create(red.agentId, ordinary.id); await r.send(other, "Ordinary project input"); await idle(other);
    t.assertions.assert(marker(red) === false, "non-Team workspace inherited another Team's context");
    unlinkSync(file);
    const unknown = await r.create(absent.agentId, leader.id); await r.send(unknown, "Observe missing metadata"); await idle(unknown);
    t.assertions.assert(marker(absent) === true, "missing Team observation was represented as no alerts");
    observation(true, Date.now() - 660000);
    const old = await r.create(stale.agentId, leader.id); await r.send(old, "Observe stale metadata"); await idle(old);
    t.assertions.assert(marker(stale) === true, "stale Team observation lacked an explicit unknown marker");
    unlinkSync(file); const outside = join(t.env.root, "case-owned-other-file.json"); observation(false); writeFileSync(outside, readFileSync(file)); unlinkSync(file); symlinkSync(outside, file);
    await r.send(unknown, "Observe aliased metadata"); await idle(unknown);
    t.assertions.assert(marker(absent) === true, "aliased observation was followed as current Team data");
    unlinkSync(file); writeFileSync(file, " ".repeat(262145));
    await r.send(unknown, "Observe oversized metadata"); await idle(unknown);
    t.assertions.assert(marker(absent) === true, "oversized Team observation was represented as healthy");
    observation(false);
    const config = join(r.root, ".genethub/open.env"); writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-brief-outcome\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\n");
    const caller = await r.create("ctl-cli-command"); let sequence = 0;
    const invoke = async (sid: string, args: string[]) => {
      const requestId = "brief.command." + (++sequence);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId })); await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage" && x.text.includes(JSON.stringify(requestId))).at(-1);
      if (item?.type !== "assistantMessage") throw Error("real Task command receipt missing");
      const reply = JSON.parse(item.text); t.assertions.assert(reply.code === 0, reply.out + reply.err); return JSON.parse(reply.out.trim().split("\n").at(-1)!);
    };
    const task = await invoke(caller, ["task", "start", "--space", "leader", "--desc", "recorded outcome", "--request-id", "brief.goal", "Conclude honestly while retaining an unfinished support"]);
    const owner = task.owner.sessionId; await idle(owner);
    const support = await invoke(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "retained work", "--request-id", "brief.support", "Retain genuine unfinished work"]); await idle(support.collaborator);
    await invoke(owner, ["task", "finish", task.taskId, "--outcome", "blocked", "Actual blocked conclusion; support remains unfinished"]);
    const status = await invoke(owner, ["task", "status", task.taskId]);
    t.assertions.assert(status.finished?.outcome === "blocked" && marker(outcome) === true,
      "recorded native blocked conclusion disappeared from the next actual Agent prompt");
    t.note("Actual SDK prompt delivery/pause/Task commands; only Team observational file is a labelled fixture. User messages, native records and approval provenance are unchanged.");
  } finally { await r.dispose(); }
});

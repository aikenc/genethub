import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  connectProductClient, daemonEndpoint, defineSpecialty, hideHostAgentClis,
  installScriptAgent, readScriptAgentJournal, runGenet, seedScriptAgentRuntime,
} from "../../framework/public.ts";

// Boundary: an ordinary user-layer Agent, shipped SDK, real child processes.
// The real built-in Codex install/login case is the compensating canary.
for (const scenario of ["answer", "cancel", "uncertain"] as const) {
  defineSpecialty({
    id: `specialty.agent.durable.${scenario}`,
    title: `Stopped Agent action survives process and daemon restart: ${scenario}`,
    oracle: "An outstanding question has an on-disk obligation and no owned CLI; script and daemon restart preserve its identity. A concurrent answer is consumed once without writing the secret; cancellation stays canceled; an uncertain external effect is inspected and never replayed automatically",
    catches: ["waiting Future is required to answer", "CLI retained during Human pause", "duplicate answer dispatch", "secret in continuation record", "unknown effect replayed"],
    tags: ["core", "agent", "script-agent", "durable-interaction"],
    llm: { default: "none" }, expectedDurationMs: 15_000, timeoutMs: 90_000,
    surfaces: ["daemon", "script-agent", "workbench-client", "os-process", "filesystem"],
    productInterfaces: ["agent.action", "agent.requestAnswer", "agent.requests", "genet daemon start"],
  }, async t => {
    hideHostAgentClis(t.env); seedScriptAgentRuntime(t.env);
    const agent = installScriptAgent(t.env, { id: "durable-fixture", control: { profile: "durable" } });
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let client = opened.client;
    let second: Awaited<ReturnType<typeof t.flows.main.pairDevice>> | undefined;
    const secret = "sk-durable-" + randomBytes(24).toString("hex");
    const receipt = path.join(agent.stateDir, "receipts.jsonl");
    const pendingFile = path.join(t.env.data, "agents", "pending", agent.agentId + ".json");
    const receipts = () => existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean) : [];
    const requests = async () => {
      const reply = await client.call({ type: "agent.requests" });
      if (reply?.type !== "agentRequests") throw new Error("no request list");
      return reply.data.filter(r => r.agentId === agent.agentId);
    };
    const restart = async () => {
      client.close(); opened.daemon.stop();
      const started = runGenet(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
      t.assertions.assert(started.code === 0, "restart failed");
      client = await connectProductClient(daemonEndpoint(opened.daemon));
    };
    try {
      await t.flows.branches.waitForAgent(client, agent.agentId, a => a.probe.state === "ready");
      await t.flows.branches.agentControl(client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: scenario === "uncertain" ? "uncertain" : "login" } });
      await t.tools.waitUntil(async () => (await requests()).length === 1, 15_000);
      const request = (await requests())[0]!;
      const journal = readScriptAgentJournal(agent);
      const childPid = Number(journal.find(e => e.event === "job-child")?.childPid);
      t.assertions.assert(childPid > 0 && journal.some(e => e.event === "job-unwound"), "did not unwind action before presentation");
      t.assertions.assert(!t.flows.branches.processAlive(childPid), "Human card retained an owned child");
      const grandchildPid = Number(journal.find(e => e.event === "job-child")?.grandchildPid);
      const stat = (() => { try { return readFileSync(`/proc/${grandchildPid}/stat`, "utf8"); } catch { return ""; } })();
      t.assertions.assert(!stat || stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z", "Human card retained a TERM-resistant grandchild");
      t.assertions.assert(existsSync(pendingFile) && readFileSync(pendingFile, "utf8").includes(request.id), "card was not saved");
      // A serve crash does not abandon the daemon-owned obligation.
      process.kill(Number(journal.find(e => e.event === "job-child")?.pid), "SIGKILL");
      await t.flows.branches.waitForAgent(client, agent.agentId, a => a.probe.state === "ready");
      await restart();
      t.assertions.assert((await requests())[0]?.id === request.id, "restart lost or re-created the question");
      second = await t.flows.main.pairDevice(client, opened.daemon, ["read", "settings"], "durable-second-device");
      const response = { agentId: agent.agentId, requestId: request.id, outcome: scenario === "cancel"
        ? { type: "canceled" as const }
        : { type: "answered" as const, optionId: "ok", answers: [{ questionId: "token", selectedOptionIds: [], freeformText: secret },
            { questionId: "note", selectedOptionIds: [], freeformText: "ordinary-answer" }] } };
      const contenders = await Promise.allSettled([
        t.flows.branches.answerAgentRequest(second.client, response),
        t.flows.branches.answerAgentRequest(client, response),
      ]);
      t.assertions.assert(contenders.filter(r => r.status === "fulfilled").length === 1, "duplicate decision accepted");
      if (scenario !== "cancel") await t.tools.waitUntil(() => receipts().length === 1, 15_000);
      await t.flows.branches.waitForAgent(client, agent.agentId, a => a.job?.done === true);
      t.assertions.assert((await requests()).length === 0, "answered request revived");
      await restart();
      await t.flows.branches.waitForAgent(client, agent.agentId, a => a.probe.state === "ready");
      t.assertions.assert((await requests()).length === 0, "restart revived consumed decision");
      t.assertions.assert(receipts().length === (scenario === "cancel" ? 0 : 1), "effect repeated or cancellation performed an effect");
      if (scenario !== "cancel") {
        const saved = JSON.parse(receipts()[0]!);
        t.assertions.assert(saved.sha256 === createHash("sha256").update(secret).digest("hex"), "answer did not reach resumed execution");
      }
      const logs = await t.flows.branches.agentLogs(client, agent.agentId);
      t.assertions.assert(!JSON.stringify(logs).includes(secret) && !readFileSync(pendingFile, "utf8").includes(secret), "secret leaked");
      if (scenario === "uncertain") t.assertions.assert(readFileSync(pendingFile, "utf8").includes("ordinary-answer"), "ordinary decision was lost");
    } finally { second?.client.close(); client.close(); opened.daemon.stop(); await opened.mock.stop(); }
  });
}

defineSpecialty({
  id: "specialty.agent.durable.corrupt-record",
  title: "A corrupt continuation is preserved and stops action dispatch until repaired",
  oracle: "A damaged daemon-owned continuation is shown as unavailable and agent.action cannot overwrite it or reach the script. Fixing the file and reloading restores action dispatch without deleting Agent state",
  catches: ["corruption silently loses outstanding obligation", "new action overwrites unreadable record", "reload cannot repair continuation"],
  tags: ["core", "agent", "script-agent", "durable-interaction"], llm: { default: "none" },
  expectedDurationMs: 10_000, timeoutMs: 60_000,
  surfaces: ["daemon", "script-agent", "filesystem"], productInterfaces: ["agent.list", "agent.action", "agent.reload"],
}, async t => {
  hideHostAgentClis(t.env); seedScriptAgentRuntime(t.env);
  const agent = installScriptAgent(t.env, { id: "damaged-pending", control: { profile: "durable" } });
  const file = path.join(t.env.data, "agents", "pending", agent.agentId + ".json");
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "damaged continuation", { mode: 0o600 });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.branches.waitForAgent(opened.client, agent.agentId, a => (a.message ?? "").includes("原记录已保留"));
    const refused = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "login" } });
    t.assertions.assert(!refused.ok && readFileSync(file, "utf8") === "damaged continuation"
      && !readScriptAgentJournal(agent).some(e => e.event === "action"), "damaged record overwritten or action dispatched");
    writeFileSync(file, "{}", { mode: 0o600 });
    const reload = await t.flows.branches.agentControl(opened.client, { type: "agent.reload", payload: { agentId: agent.agentId } });
    t.assertions.assert(reload.ok, "repair reload failed");
    await t.flows.branches.waitForAgent(opened.client, agent.agentId, a => a.probe.state === "ready");
    const ran = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "noop" } });
    t.assertions.assert(ran.ok, "action remained blocked after repair");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

for (const changed of ["agent", "sdk"] as const) {
  defineSpecialty({
    id: `specialty.agent.durable.revision-${changed}`,
    title: `An old Human decision cannot continue changed ${changed} code`,
    oracle: "The persisted question is bound to the loaded adapter and SDK bytes. Changing source after a safe pause rejects an answer without claiming it, revealing the secret or performing an effect. Human can cancel the stale obligation without executing new code; reload produces a fresh question",
    catches: ["new code consumes old approval", "source revision comes from untrusted notification", "stale secret dispatched", "old request cannot be canceled"],
    tags: ["core", "agent", "script-agent", "durable-interaction"], llm: { default: "none" },
    expectedDurationMs: 12_000, timeoutMs: 75_000,
    surfaces: ["daemon", "script-agent", "filesystem"], productInterfaces: ["agent.action", "agent.requestAnswer", "agent.requests", "agent.reload"],
  }, async t => {
    hideHostAgentClis(t.env); seedScriptAgentRuntime(t.env);
    const agent = installScriptAgent(t.env, { id: "bound-revision", control: { profile: "durable" } });
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const requests = async () => {
      const reply = await opened.client.call({ type: "agent.requests" });
      if (reply?.type !== "agentRequests") throw new Error("no requests");
      return reply.data.filter(r => r.agentId === agent.agentId);
    };
    try {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, a => a.probe.state === "ready");
      await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "login" } });
      await t.tools.waitUntil(async () => (await requests()).length === 1, 15_000);
      const original = (await requests())[0]!;
      const file = path.join(t.env.data, "agents", "pending", agent.agentId + ".json");
      const before = JSON.parse(readFileSync(file, "utf8"))[original.id];
      t.assertions.assert(before.stopped && /^[a-f0-9]{64}$/.test(before.revision), "no daemon-authored code revision");
      appendFileSync(changed === "agent" ? path.join(agent.dir, "agent.py")
        : path.join(t.env.data, "agents", "sdk", "genehub_agent", "serve.py"), "\n# changed source revision\n");
      const secret = "sk-stale-" + randomBytes(12).toString("hex");
      let refused = false;
      try { await t.flows.branches.answerAgentRequest(opened.client, { agentId: agent.agentId, requestId: original.id,
        outcome: { type: "answered", optionId: "ok", answers: [{ questionId: "token", selectedOptionIds: [], freeformText: secret }] } }); }
      catch (error) { refused = /修订/.test(String(error)); }
      const held = readFileSync(file, "utf8");
      t.assertions.assert(refused && !(JSON.parse(held)[original.id]?.claimed) && !held.includes(secret)
        && (await requests())[0]?.id === original.id && !existsSync(path.join(agent.stateDir, "receipts.jsonl")), "old approval consumed by changed code");
      await t.flows.branches.answerAgentRequest(opened.client, { agentId: agent.agentId, requestId: original.id, outcome: { type: "canceled" } });
      t.assertions.assert((await requests()).length === 0 && readScriptAgentJournal(agent).filter(e => e.event === "action").length === 1, "stale cancellation executed new code");
      await t.flows.branches.agentControl(opened.client, { type: "agent.reload", payload: { agentId: agent.agentId } });
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, a => a.probe.state === "ready");
      await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "login" } });
      await t.tools.waitUntil(async () => (await requests()).length === 1, 15_000);
      t.assertions.assert((await requests())[0]?.id !== original.id, "new revision reused old question");
    } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
  });
}

defineSpecialty({
  id: "specialty.agent.durable.crash-before-stop",
  title: "A crash during stop retains the saved obligation without publishing a false waiting card",
  oracle: "The real SDK receives persistence acknowledgment before its action finally exits the process. A saved stopped:false record survives script/daemon restart, no Human card is published, the job reports unknown stop and a second action is refused rather than replayed. The case separately reaps only its deliberately orphaned known process group",
  catches: ["cleanup starts before obligation is saved", "crash loses prepared question", "unconfirmed stop presented as waiting", "unknown stop replayed"],
  tags: ["core", "agent", "script-agent", "durable-interaction"], llm: { default: "none" },
  expectedDurationMs: 12_000, timeoutMs: 80_000,
  surfaces: ["daemon", "script-agent", "filesystem", "os-process"], productInterfaces: ["agent.action", "agent.requests", "genet daemon start"],
}, async t => {
  hideHostAgentClis(t.env); seedScriptAgentRuntime(t.env);
  const agent = installScriptAgent(t.env, { id: "crash-in-stop", control: { profile: "durable" } });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let client = opened.client;
  const pushes = t.flows.branches.recordAgentPushes(client);
  const file = path.join(t.env.data, "agents", "pending", agent.agentId + ".json");
  let group = 0;
  try {
    await t.flows.branches.waitForAgent(client, agent.agentId, a => a.probe.state === "ready");
    await t.flows.branches.agentControl(client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "prepare-crash" } });
    await t.tools.waitUntil(() => readScriptAgentJournal(agent).some(e => e.event === "job-unwound"), 15_000);
    const child = readScriptAgentJournal(agent).find(e => e.event === "job-child")!;
    group = Number(child.childPid);
    t.assertions.assert(t.flows.branches.processAlive(group) && existsSync(file), "crash did not occur after save and before stop");
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { stopped: boolean; claimed: boolean }>;
    t.assertions.assert(Object.values(records).length === 1 && Object.values(records)[0]?.stopped === false, "preparation was not saved before action finally");
    client.close(); opened.daemon.stop();
    t.assertions.assert(runGenet(opened.daemon.genet, ["daemon", "start"], opened.daemon.env).code === 0, "restart failed");
    client = await connectProductClient(daemonEndpoint(opened.daemon));
    const state = await t.flows.branches.waitForAgent(client, agent.agentId, a => a.job?.phase === "unknown" && a.job.done);
    t.assertions.assert(!!state.job?.error, "unconfirmed stop has no actionable error");
    const list = await client.call({ type: "agent.requests" });
    t.assertions.assert(list?.type === "agentRequests" && !list.data.some(r => r.agentId === agent.agentId)
      && !pushes.requests.some(r => r.agentId === agent.agentId), "unconfirmed stop was published as a Human card");
    const refused = await t.flows.branches.agentControl(client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "prepare-crash" } });
    t.assertions.assert(!refused.ok && readScriptAgentJournal(agent).filter(e => e.event === "action").length === 1, "prepared operation replayed");
  } finally {
    pushes.stop();
    if (!group) group = Number(readScriptAgentJournal(agent).find(e => e.event === "job-child")?.childPid);
    if (group > 0) { try { process.kill(-group, "SIGKILL"); } catch { /* Known test group already gone. */ } }
    client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

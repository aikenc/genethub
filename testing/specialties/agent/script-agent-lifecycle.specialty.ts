// Third-party Agents are script directories the daemon does not understand:
// it scans `<data>/agents/{builtin,user}`, keeps one `serve` process per Agent
// alive and relays state, jobs, Agent-level requests and session events
// (docs/agent-serve-protocol.md). These cases hold that kernel to what a user
// sees through the product client, with the shipped SDK and real processes.
//
// The fixture Agent (`testing/fixtures/script-agent`) is ordinary user-layer
// content: what varies is only what a script is free to do. Codex is driven
// through its built-in script against the declared app-server double
// (`registerScriptedCodex`). The pinned Python the daemon would download is
// copied from the test cache to where the shipped install script looks; the
// download itself is covered by install-runtime.specialty.ts.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BlockedError,
  breakScriptAgentManifest,
  defineSpecialty,
  HOST_AGENT_CLIS,
  hideHostAgentClis,
  installScriptAgent,
  pathWithout,
  readScriptAgentJournal,
  registerScriptedCodex,
  runtimeInstallerLines,
  scriptAgentRuntimeIdentity,
  seedScriptAgentRuntime,
  type CaseContext,
  type ScriptAgentHandle,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type AgentInfo = Awaited<ReturnType<CaseContext["flows"]["branches"]["listAgents"]>>[number];
type EventLog = Awaited<ReturnType<CaseContext["flows"]["main"]["attachEventLog"]>>;

function lifecycleCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
  durationMs = 25_000,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.script.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "script-agent", "script-agent-lifecycle"],
      llm: { default: "none" },
      expectedDurationMs: durationMs,
      timeoutMs: durationMs * 4,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent-adapter", "script-agent", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
    },
    run,
  );
}

/** Runs against one daemon. On failure the watched Agents' `agent.logs` tail
 * and the fixture journal are noted: bounded, and nothing secret is in them
 * by construction (the secret case asserts so itself). */
async function withWorkspace(
  t: CaseContext,
  run: (opened: Opened) => Promise<void>,
  watched: Array<ScriptAgentHandle | string> = [],
  // Off only where the case has already put the one CLI it needs on PATH.
  hideHostClis = true,
): Promise<void> {
  if (hideHostClis) hideHostAgentClis(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } catch (error) {
    for (const agent of watched) {
      const id = typeof agent === "string" ? agent : agent.agentId;
      const logs = await t.flows.branches.agentLogs(opened.client, id, 15).catch((e: unknown) => [`agent.logs failed: ${String(e)}`]);
      const journal = typeof agent === "string" ? [] : readScriptAgentJournal(agent).slice(-20).map((entry) => `${entry.pid}:${entry.event}`);
      t.note(`${id} logs: ${logs.join(" | ")}\n${id} journal: ${journal.join(" ")}`);
    }
    throw error;
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

/** The CLIs are installed on many developer machines; "not installed" has to
 * be arranged, and an install directory the built-in scripts search beyond
 * PATH makes it impossible here. */
function withoutThirdPartyClis(t: CaseContext): void {
  t.env.env.PATH = pathWithout(HOST_AGENT_CLIS);
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin"]) {
    if (existsSync(path.join(dir, "codex"))) {
      throw new BlockedError(`${dir}/codex is installed; the built-in codex script finds it outside PATH`);
    }
  }
}

const serveStarts = (agent: ScriptAgentHandle) =>
  readScriptAgentJournal(agent).filter((entry) => entry.event === "start");
const journalOf = (agent: ScriptAgentHandle, event: string) =>
  readScriptAgentJournal(agent).filter((entry) => entry.event === event);
const primary = (agent: AgentInfo) => agent.actions?.find((action) => action.primary)?.id;
const eventOf = (entry: { raw: unknown }) =>
  (entry.raw as { event?: Record<string, unknown> }).event ?? {};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForTerminal(t: CaseContext, events: EventLog, after: number, timeoutMs = 20_000) {
  let found: { raw: unknown } | undefined;
  await t.tools
    .waitUntil(() => {
      found = events.slice(after).find((item) => item.type === "turnCompleted" || item.type === "turnFailed");
      return found !== undefined;
    }, timeoutMs)
    .catch(() => {
      throw new Error(`no terminal turn event; saw ${events.slice(after).map((item) => item.type).join(",")}`);
    });
  return eventOf(found!);
}

async function assistantText(opened: Opened, sessionId: string): Promise<string> {
  const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
  if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
  return reply.data.items
    .filter((item) => item.type === "assistantMessage")
    .map((item) => (item as { text: string }).text)
    .join("\n");
}

lifecycleCase(
  "builtin-listed-without-cli",
  "Built-in codex and cursor are listed and offer install when their CLI is absent",
  "with neither CLI reachable, agent.list carries codex and cursor with source builtin, probe unavailable and a primary install action; the seeded pinned runtime is the same tree (inode) afterwards and neither Agent's agent.logs carries an install-script progress line, so nothing was downloaded",
  [
    "built-in script Agents not materialized or not scanned",
    "an absent CLI reported as ready",
    "not-ready Agent offers no way forward",
    "the runtime install script downloads although the pinned build is present",
  ],
  async (t) => {
    withoutThirdPartyClis(t);
    const seeded = seedScriptAgentRuntime(t.env);
    await withWorkspace(t, async (opened) => {
      const settled = (agent: AgentInfo) => agent.probe.state !== "ready" && primary(agent) !== undefined;
      const codex = await t.flows.branches.waitForAgent(opened.client, "codex", settled, { what: "settled without a CLI" });
      const cursor = await t.flows.branches.waitForAgent(opened.client, "cursor", settled, { what: "settled without a CLI" });
      for (const agent of [codex, cursor]) {
        t.assertions.assert(agent.source === "builtin", `${agent.id} source ${agent.source}`);
        t.assertions.assert(agent.probe.state === "unavailable", `${agent.id} probe ${JSON.stringify(agent.probe)}`);
        t.assertions.assert(primary(agent) === "install", `${agent.id} primary action ${primary(agent)}`);
        t.assertions.assert(agent.builtin === false, `${agent.id} claims to be the native built-in Agent`);
      }
      const all = await t.flows.branches.listAgents(opened.client);
      const genet = all.find((agent) => agent.id === "genet");
      t.assertions.assert(genet?.builtin === true && genet.source === undefined, "the native built-in Agent changed shape");
      // A download replaces the tree (rm + mv of a fresh unpack) and reports
      // its phases, which the daemon writes to the Agent's logs.
      const runtime = readdirSync(path.join(t.env.data, "agents", "runtime"));
      t.assertions.assert(
        runtime.filter((name) => name.startsWith("python-") || name.startsWith(".staging")).length === 1,
        `runtime directory changed: ${runtime.join(",")}`,
      );
      t.assertions.assert(scriptAgentRuntimeIdentity(seeded.dir) === seeded.identity, "the install script replaced the seeded runtime");
      for (const id of ["codex", "cursor"]) {
        const installer = runtimeInstallerLines(await t.flows.branches.agentLogs(opened.client, id, 200));
        t.assertions.assert(installer.length === 0, `${id} ran an install: ${installer.join(" | ")}`);
      }
      t.note(JSON.stringify([codex, cursor].map(t.flows.branches.summarizeAgent)));
    }, ["codex", "cursor"]);
  },
);

lifecycleCase(
  "user-agent-reload-and-turn",
  "A user-layer Agent added after start appears on reload and completes a turn",
  "a user/<id> directory written after daemon start is absent until agent.reload, then ready with source user, and a session turn sent through the product client reaches the script and completes with its text",
  [
    "user/ is polled instead of reloaded on request",
    "agent.reload cannot pick up a new directory",
    "turnStarted is not emitted before session.send",
    "script session events dropped or misrouted",
  ],
  async (t) => {
    seedScriptAgentRuntime(t.env);
    await withWorkspace(t, async (opened) => {
      const agent = installScriptAgent(t.env, { id: "fixture-echo", control: { profile: "normal", chunks: 3 } });
      const before = await t.flows.branches.listAgents(opened.client);
      t.assertions.assert(!before.some((item) => item.id === agent.agentId), "a user directory took effect without reload");
      const reloaded = await t.flows.branches.agentControl(opened.client, { type: "agent.reload", payload: { agentId: agent.agentId } });
      t.assertions.assert(reloaded.ok, `agent.reload failed: ${reloaded.ok ? "" : reloaded.error}`);
      const ready = await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      t.assertions.assert(ready.source === "user" && ready.label === "Fixture Agent" && ready.version === "1.0.0",
        `unexpected info ${JSON.stringify(t.flows.branches.summarizeAgent(ready))}`);

      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: "fixture",
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "echo please");
      const terminal = await waitForTerminal(t, events, 0);
      t.assertions.assert(terminal.type === "turnCompleted", `turn ended ${JSON.stringify(terminal)}`);
      const started = events.findIndex((item) => item.type === "turnStarted");
      const ended = events.findIndex((item) => item.type === "turnCompleted");
      t.assertions.assert(started >= 0 && started < ended, `turnStarted missing or late: ${events.map((item) => item.type).join(",")}`);
      const prompt = journalOf(agent, "prompt").at(-1);
      t.assertions.assert(prompt?.turnId === eventOf(events[started]!).turnId, "the script never saw the turn the daemon announced");
      const text = await assistantText(opened, sessionId);
      t.assertions.assert(text.includes("chunk-0 chunk-1 chunk-2"), `assistant text: ${text}`);
    }, ["fixture-echo"]);
  },
);

lifecycleCase(
  "action-request-secret",
  "An action's job, its Agent-level request and a secret answer reach the right places only",
  "agent.action streams job progress into AgentInfo.job, the script's request reaches the client as an agentRequest frame, agent.requestAnswer delivers the secret to the script (sha256 marker matches), the request closes, the Agent turns ready, and the secret is absent from agent.logs, the Agent list and the daemon log",
  [
    "job.progress not reflected in AgentInfo",
    "agentRequest never pushed to an owner client",
    "answer not delivered to the script",
    "request left pending after an answer",
    "a secret answer echoed into logs or state",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-login", control: { profile: "login" } });
    await withWorkspace(t, async (opened) => {
      const pushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        const waiting = await t.flows.branches.waitForAgent(opened.client, agent.agentId,
          (info) => info.probe.state === "unavailable" && primary(info) === "login", { what: "asking for login" });
        t.assertions.assert(waiting.source === "user", `source ${waiting.source}`);
        const ran = await t.flows.branches.agentControl(opened.client, {
          type: "agent.action", payload: { agentId: agent.agentId, actionId: "login" },
        });
        t.assertions.assert(ran.ok, `agent.action failed: ${ran.ok ? "" : ran.error}`);

        const inJob = await t.flows.branches.waitForAgent(opened.client, agent.agentId, (info) =>
          info.job?.action === "login" && info.job.phase === "waiting" && info.job.percent === 50
          && (info.pendingRequests?.length ?? 0) === 1, { what: "waiting on its request" });
        t.assertions.assert(
          inJob.job!.logTail.includes("fixture-login: step 1 of 2") && inJob.job!.logTail.includes("fixture-login: step 2 of 2"),
          `job log tail ${JSON.stringify(inJob.job!.logTail)}`,
        );
        await t.tools.waitUntil(() => pushes.requests.some((request) => request.agentId === agent.agentId), 10_000)
          .catch(() => { throw new Error("no agentRequest frame reached the client"); });
        const request = pushes.requests.find((item) => item.agentId === agent.agentId)!;
        t.assertions.assert(request.id === inJob.pendingRequests![0]!.id, "pushed request differs from the pending one");
        t.assertions.assert(request.questions[0]?.input === "secret" && request.display.some((item) => item.kind === "code"),
          `request shape ${JSON.stringify(request)}`);

        const secret = `fixture-secret-${randomBytes(12).toString("hex")}`;
        await t.flows.branches.answerAgentRequest(opened.client, {
          agentId: agent.agentId,
          requestId: request.id,
          outcome: { type: "answered", optionId: "ok", answers: [{ questionId: "token", selectedOptionIds: [], freeformText: secret }] },
        });
        await t.tools.waitUntil(() => pushes.closed.some((item) => item.requestId === request.id), 10_000)
          .catch(() => { throw new Error("no agentRequestClosed frame after the answer"); });
        const done = await t.flows.branches.waitForAgent(opened.client, agent.agentId,
          (info) => info.probe.state === "ready" && info.job?.done === true, { what: "logged in" });
        t.assertions.assert(!done.job?.error && (done.pendingRequests?.length ?? 0) === 0, `after answer ${JSON.stringify(t.flows.branches.summarizeAgent(done))}`);

        const marker = readFileSync(path.join(agent.stateDir, "login.sha256"), "utf8").trim();
        t.assertions.assert(marker === createHash("sha256").update(secret).digest("hex"), "the script received a different secret");

        const logs = await t.flows.branches.agentLogs(opened.client, agent.agentId);
        t.assertions.assert(logs.some((line) => line.includes("fixture-login: received token ***")),
          `the script's own echo of the token never reached agent.logs: ${logs.slice(-10).join(" | ")}`);
        const remaining = await opened.client.call({ type: "agent.requests" });
        t.assertions.assert(remaining?.type === "agentRequests" && !remaining.data.some((item) => item.id === request.id),
          "the answered request is still listed");
        const leaks: string[] = [];
        if (logs.join("\n").includes(secret)) leaks.push("agent.logs");
        if (JSON.stringify(await t.flows.branches.listAgents(opened.client)).includes(secret)) leaks.push("agent.list");
        if (JSON.stringify(pushes.lists).includes(secret)) leaks.push("agents pushes");
        const daemonLog = t.env.env.GENEHUB_LOG;
        if (daemonLog && existsSync(daemonLog) && readFileSync(daemonLog, "utf8").includes(secret)) leaks.push("daemon log");
        t.assertions.assert(leaks.length === 0, `the secret leaked into ${leaks.join(", ")}`);
      } finally {
        pushes.stop();
      }
    }, [agent]);
  },
);

lifecycleCase(
  "invalid-reload-keeps-process",
  "Reloading an invalid agent.toml is refused and the running process keeps serving",
  "agent.reload with protocol = 99 returns an error naming the manifest, the list shows that reason, the same serve pid still completes a turn in the open session, and a fixed manifest reloads into a new ready process",
  [
    "an invalid manifest kills the running Agent",
    "reload accepts a manifest the daemon cannot speak",
    "the refusal is not shown where the Agent is listed",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-reload", control: { profile: "normal" } });
    await withWorkspace(t, async (opened) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: "fixture",
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "first");
      t.assertions.assert((await waitForTerminal(t, events, 0)).type === "turnCompleted", "first turn failed");
      const servePid = Number(journalOf(agent, "prompt").at(-1)!.pid);
      const startsBefore = serveStarts(agent).length;

      breakScriptAgentManifest(agent);
      const refused = await t.flows.branches.agentControl(opened.client, { type: "agent.reload", payload: { agentId: agent.agentId } });
      t.assertions.assert(!refused.ok && /protocol/i.test(refused.error), `reload of protocol 99: ${JSON.stringify(refused)}`);
      const shown = await t.flows.branches.waitForAgent(opened.client, agent.agentId,
        (info) => /protocol/i.test(info.message ?? ""), { what: "showing the manifest problem" });
      t.note(`after refused reload: ${JSON.stringify(t.flows.branches.summarizeAgent(shown))}`);
      t.assertions.assert(alive(servePid) && serveStarts(agent).length === startsBefore, "the running process was restarted or stopped");

      const mark = events.length;
      await t.flows.main.sendPrompt(opened.client, sessionId, "still there?");
      t.assertions.assert((await waitForTerminal(t, events, mark)).type === "turnCompleted", "the previous process stopped serving");
      t.assertions.assert(Number(journalOf(agent, "prompt").at(-1)!.pid) === servePid, "the turn was served by another process");

      copyFileSync(fileURLToPath(new URL("../../fixtures/script-agent/agent.toml", import.meta.url)), path.join(agent.dir, "agent.toml"));
      const fixed = await t.flows.branches.agentControl(opened.client, { type: "agent.reload", payload: { agentId: agent.agentId } });
      t.assertions.assert(fixed.ok, `reload of the fixed manifest failed: ${fixed.ok ? "" : fixed.error}`);
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready after the fix" });
      t.assertions.assert(serveStarts(agent).length === startsBefore + 1 && !alive(servePid), "a valid reload did not replace the process");
    }, [agent]);
  },
);

lifecycleCase(
  "crash-mid-turn-recovers",
  "A serve process that dies mid-turn fails that turn and the session recovers",
  "when the script exits mid-turn the turn ends turnFailed(agentCrashed), the daemon restarts the process and re-starts the session with its persisted resume value, and the next send in the same session completes",
  [
    "a dead serve process leaves the turn running",
    "the crash code is not agentCrashed",
    "no automatic restart after an exit",
    "live sessions are not started again with their resume value",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-crash", control: { profile: "exit-without-terminal", once: true } });
    await withWorkspace(t, async (opened) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: "fixture",
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "crash now");
      const failed = await waitForTerminal(t, events, 0);
      const error = failed.error as { code?: string } | undefined;
      t.assertions.assert(failed.type === "turnFailed" && error?.code === "agentCrashed", `crash turn ended ${JSON.stringify(failed)}`);
      const native = journalOf(agent, "session-start")[0]?.sessionId;
      const crashedPid = Number(journalOf(agent, "exit")[0]?.pid ?? 0);
      t.assertions.assert(typeof native === "string" && crashedPid > 0, "the fixture never opened a session or never crashed");

      await t.tools.waitUntil(() => serveStarts(agent).some((entry) => entry.pid !== crashedPid), 30_000)
        .catch(() => { throw new Error("the daemon never restarted the script"); });
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready after the crash" });
      t.assertions.assert(await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "noop" } }).then((r) => r.ok),
        "the restarted process does not answer");

      const mark = events.length;
      await t.flows.main.sendPrompt(opened.client, sessionId, "again");
      const second = await waitForTerminal(t, events, mark, 30_000);
      t.assertions.assert(second.type === "turnCompleted", `the next send after the restart ended ${JSON.stringify(second)}`);
      const resumed = journalOf(agent, "resumed").filter((entry) => entry.pid !== crashedPid);
      t.assertions.assert(resumed.some((entry) => entry.sessionId === native),
        `the session was not started again with its resume value: ${JSON.stringify(resumed)}`);
      t.assertions.assert(Number(journalOf(agent, "prompt").at(-1)!.pid) !== crashedPid, "the second turn reached the dead process");
    }, [agent]);
  },
  35_000,
);

lifecycleCase(
  "missed-deadline-restarts",
  "A request the script never answers restarts it, even one that ignores SIGTERM",
  "against a script that never answers session.interrupt and ignores SIGTERM, the interrupt returns to the user within 15s, the daemon logs the missed deadline, the old pid is gone and a new process is ready, and the same session completes a later turn",
  [
    "a missed deadline leaves a deaf process in place",
    "a process ignoring SIGTERM survives the restart",
    "the user's stop waits on the script's reply",
    "the session cannot be used after the restart",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, {
      id: "fixture-deadline", control: { profile: "ignore-interrupt", once: true, ignoreSigterm: true },
    });
    await withWorkspace(t, async (opened) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: "fixture",
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "ignore my stop");
      await t.tools.waitUntil(() => journalOf(agent, "went-silent").length > 0, 10_000);
      const deafPid = Number(journalOf(agent, "went-silent")[0]!.pid);

      const timed = await t.flows.branches.timeControlCall(() =>
        opened.client.call({ type: "session.interrupt", payload: { sessionId } }));
      t.assertions.assert(timed.ms < 15_000, `session.interrupt took ${timed.ms}ms`);
      await t.tools.waitUntil(() => journalOf(agent, "cancel-ignored").length > 0, 10_000);

      await t.tools.waitUntil(() => serveStarts(agent).some((entry) => entry.pid !== deafPid), 45_000)
        .catch(() => { throw new Error("no restart after the missed deadline"); });
      t.assertions.assert(!alive(deafPid), `the deaf process ${deafPid} survived the restart`);
      const logs = await t.flows.branches.agentLogs(opened.client, agent.agentId);
      t.assertions.assert(logs.some((line) => line.startsWith("[daemon]") && line.includes("session.interrupt")),
        `no daemon note about the missed deadline: ${logs.slice(-8).join(" | ")}`);
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready after the restart" });
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        return reply?.type === "snapshot" && reply.data.summary.status !== "running";
      }, 20_000);

      const mark = events.length;
      await t.flows.main.sendPrompt(opened.client, sessionId, "now answer");
      const terminal = await waitForTerminal(t, events, mark, 30_000);
      t.assertions.assert(terminal.type === "turnCompleted", `the turn after the restart ended ${JSON.stringify(terminal)}`);
    }, [agent]);
  },
  45_000,
);

lifecycleCase(
  "missed-deadline-on-a-waited-call-restarts",
  "A control request the script never answers fails within its deadline and restarts the script",
  "after a completed turn, session.setModel against a script that never answers it returns an error within 25s, the daemon logs the missed deadline, the old serve pid is gone, a new process is ready and the same session completes another turn",
  [
    "a hung control request blocks the caller past its deadline",
    "a missed deadline leaves the deaf process in place",
    "the session cannot be used after the restart",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-setmodel", control: { profile: "ignore-set-model", once: true } });
    await withWorkspace(t, async (opened) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: "fixture",
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "first");
      t.assertions.assert((await waitForTerminal(t, events, 0)).type === "turnCompleted", "first turn failed");
      const servePid = Number(journalOf(agent, "prompt").at(-1)!.pid);

      const timed = await t.flows.branches.timeControlCall(() =>
        opened.client.call({ type: "session.setModel", payload: { sessionId, modelId: "fixture-alt" } }));
      t.note(`setModel ${timed.outcome} in ${timed.ms}ms`);
      t.assertions.assert(journalOf(agent, "set-model-ignored").length === 1, "the script never received setModel");
      t.assertions.assert(timed.outcome === "error" && timed.ms < 25_000, `setModel against a deaf script: ${JSON.stringify(timed)}`);

      await t.tools.waitUntil(() => serveStarts(agent).some((entry) => entry.pid !== servePid), 30_000)
        .catch(() => { throw new Error("no restart after the missed deadline"); });
      t.assertions.assert(!alive(servePid), `the deaf process ${servePid} survived the restart`);
      const logs = await t.flows.branches.agentLogs(opened.client, agent.agentId);
      t.assertions.assert(logs.some((line) => line.startsWith("[daemon]") && line.includes("session.setModel")),
        `no daemon note about the missed deadline: ${logs.slice(-8).join(" | ")}`);
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready after the restart" });

      const mark = events.length;
      await t.flows.main.sendPrompt(opened.client, sessionId, "after the restart");
      const terminal = await waitForTerminal(t, events, mark, 30_000);
      t.assertions.assert(terminal.type === "turnCompleted", `the turn after the restart ended ${JSON.stringify(terminal)}`);
    }, [agent]);
  },
  40_000,
);

lifecycleCase(
  "override-crash-falls-back",
  "A user override of codex that keeps crashing falls back to the built-in; reset removes it",
  "user/codex exiting before initialize is retried with backoff, set aside for builtin/codex after at least three failed starts (source builtin, not ready without a CLI, primary install), and agent.reset deletes user/codex while keeping state/codex",
  [
    "a crashing override is retried forever",
    "fallback before the documented threshold",
    "fallback keeps reporting source override",
    "agent.reset leaves the override or deletes the Agent's state",
  ],
  async (t) => {
    withoutThirdPartyClis(t);
    const override = installScriptAgent(t.env, { id: "codex", control: { profile: "crash-on-start" } });
    await withWorkspace(t, async (opened) => {
      const sources = new Set<string>();
      const off = opened.client.onAgents((agents) => {
        const codex = agents.find((item) => item.id === "codex");
        if (codex?.source) sources.add(codex.source);
      });
      try {
        const fellBack = await t.flows.branches.waitForAgent(opened.client, "codex",
          (info) => info.source === "builtin" && primary(info) === "install", { timeoutMs: 120_000, what: "back on the built-in" });
        const attempts = journalOf(override, "fault").length;
        t.note(`override starts before fallback: ${attempts}; sources seen: ${[...sources].join(",")}`);
        t.assertions.assert(attempts >= 3, `fell back after ${attempts} failed starts`);
        t.assertions.assert(fellBack.probe.state !== "ready", "the built-in claims a CLI that is not there");
        t.assertions.assert(existsSync(path.join(override.dir, "agent.toml")), "fallback deleted the user's override");
        const logs = await t.flows.branches.agentLogs(opened.client, "codex");
        t.assertions.assert(logs.some((line) => line.startsWith("[daemon]") && line.includes("reload")),
          `no daemon note about the fallback: ${logs.slice(-8).join(" | ")}`);

        const after = journalOf(override, "fault").length;
        const reset = await t.flows.branches.agentControl(opened.client, { type: "agent.reset", payload: { agentId: "codex" } });
        t.assertions.assert(reset.ok, `agent.reset failed: ${reset.ok ? "" : reset.error}`);
        t.assertions.assert(!existsSync(override.dir), "agent.reset left user/codex");
        t.assertions.assert(existsSync(override.stateDir), "agent.reset deleted state/codex");
        const restored = await t.flows.branches.waitForAgent(opened.client, "codex",
          (info) => info.source === "builtin" && primary(info) === "install", { what: "built-in after reset" });
        t.assertions.assert(restored.overrideStale !== true, "a reset Agent still reports an override");
        t.assertions.assert(journalOf(override, "fault").length === after, "the override ran again after reset");
      } finally {
        off();
      }
    }, [override]);
  },
  60_000,
);

const frame = (method: string, body: Record<string, unknown>) => ({ method, params: { threadId: "$THREAD", turnId: "$TURN", ...body } });

lifecycleCase(
  "codex-scripted-turn",
  "Codex completes a turn through its built-in script",
  "with the app-server double on PATH, built-in codex becomes ready with the double's model, and a session turn reaches the double once and ends turnCompleted with its agentMessage text",
  [
    "the built-in codex script cannot reach app-server",
    "app-server agentMessage items not translated",
    "codex turn never completes through the script kernel",
  ],
  async (t) => {
    const journal = registerScriptedCodex(t.env, [[
      frame("item/started", { item: { id: "pong", type: "agentMessage", text: "" } }),
      frame("item/agentMessage/delta", { itemId: "pong", delta: "scripted-pong" }),
      frame("item/completed", { item: { id: "pong", type: "agentMessage", text: "scripted-pong" } }),
    ]]);
    await withWorkspace(t, async (opened) => {
      const codex = await t.flows.branches.waitForAgent(opened.client, "codex", t.flows.branches.agentReady,
        { timeoutMs: 60_000, what: "ready on the app-server double" });
      t.assertions.assert(codex.source === "builtin" && codex.catalog.models.some((model) => model.id === "scripted"),
        `codex catalog ${JSON.stringify(codex.catalog.models.map((model) => model.id))}`);
      const sessionId = await t.flows.main.createAgentSession(opened.client, {
        workspaceId: opened.workspaceId, agentId: "codex", modelId: "scripted",
      });
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Reply with pong");
      const terminal = await waitForTerminal(t, events, 0, 30_000);
      t.assertions.assert(terminal.type === "turnCompleted", `codex turn ended ${JSON.stringify(terminal)}`);
      t.assertions.assert((await assistantText(opened, sessionId)).includes("scripted-pong"), "the double's text is not in the session");
      const turns = existsSync(journal) ? readFileSync(journal, "utf8").split("\n").filter(Boolean) : [];
      t.assertions.assert(turns.length === 1, `the double saw ${turns.length} turns`);
    }, ["codex"], false);
  },
  30_000,
);

const REPAIR_TRIGGER = "RUN_SCRIPT_AGENT_REPAIR";

defineSpecialty(
  {
    id: "specialty.agent.script.repair-from-session",
    title: "A built-in Agent session can read and reload a script Agent, but not run its actions",
    oracle: "a user/<id> directory written after daemon start is picked up when the built-in Genet session itself runs `$GENEHUB_CLI agent reload <id>` (exit 0, Agent ready with source user); `agent logs` from the same session exits 0, while `agent action` from it is refused because actions stay with a person",
    catches: [
      "a session Agent cannot reach agent reload / logs, so 让内置 Agent 修复 cannot finish",
      "a session Agent can run Agent actions (install, login) without a person",
    ],
    tags: ["core", "agent", "script-agent", "script-agent-lifecycle", "genet-cli"],
    llm: { default: "mock" },
    expectedDurationMs: 30_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "script-agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client", "genet-cli", "agent-serve-protocol-1"],
  },
  async (t) => {
    seedScriptAgentRuntime(t.env);
    await withWorkspace(t, async (opened) => {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const agent = installScriptAgent(t.env, { id: "fixture-repair", control: { profile: "normal" } });
      const root = opened.workspaceRoot;
      const step = (name: string, command: string) =>
        `"$GENEHUB_CLI" ${command} < /dev/null > ${name}.out 2>&1; echo $? > ${name}.exit`;
      const command = [
        `cd "${root}"`,
        step("reload", `agent reload ${agent.agentId}`),
        step("logs", `agent logs ${agent.agentId}`),
        step("action", `agent action ${agent.agentId} noop`),
        "touch repair.done",
      ].join("; ");
      let issued = false;
      opened.mock.script(...Array.from({ length: 20 }, () => ({
        respond: (request: unknown) => {
          if (!issued && JSON.stringify(request).includes(REPAIR_TRIGGER)) {
            issued = true;
            return { tool: { name: "bash", arguments: { command } } };
          }
          return { text: "Done." };
        },
      })));
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, sessionId, `${REPAIR_TRIGGER}: reload the repaired Agent.`);
      await t.tools.waitUntil(() => existsSync(path.join(root, "repair.done")), 60_000)
        .catch(() => { throw new Error(`the session never finished its commands: ${readdirSync(root).join(",")}`); });
      const read = (name: string) => {
        const file = path.join(root, name);
        return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
      };
      for (const name of ["reload", "logs"]) {
        t.assertions.assert(read(`${name}.exit`) === "0", `agent ${name} from the session failed: ${read(`${name}.out`).slice(-600)}`);
      }
      t.assertions.assert(read("action.exit") !== "0", `agent action ran from a session Agent: ${read("action.out").slice(-600)}`);
      const ready = await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready after the session's reload" });
      t.assertions.assert(ready.source === "user", `source ${ready.source}`);
      t.assertions.assert(!journalOf(agent, "action").length, "the refused action reached the script");
    }, ["fixture-repair"]);
  },
);

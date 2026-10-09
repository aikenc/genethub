// Installing and logging in to Cursor from GeneHub: the built-in cursor
// script asks a person before it runs Cursor's official installer, runs it
// for real into the user's home, then runs `cursor-agent login` and shows the
// link it prints. Only a CLI GeneHub installed is updated in the background.
//
// Everything here is real: the daemon, the shipped script and SDK, Cursor's
// installer and CLI, and the network they use. Cursor's backend is not an LLM
// endpoint and is not replaced; no case here completes a login or a turn
// (real Cursor turns stay with the release-only real-LLM journeys). The
// network is a declared prerequisite: unreachable blocks, it does not fail.

import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  CURSOR_INSTALL_URL,
  cursorInstall,
  cursorScriptState,
  defineSpecialty,
  installCursorAsUser,
  isolateFromHostCursor,
  leaseProcesses,
  requireHttpsReachable,
  seedScriptAgentRuntime,
  type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Client = Opened["client"];
type AgentInfo = Awaited<ReturnType<CaseContext["flows"]["branches"]["listAgents"]>>[number];
type Pushes = ReturnType<CaseContext["flows"]["branches"]["recordAgentPushes"]>;
type AgentRequest = Pushes["requests"][number];

const INSTALL_TITLE = "安装 Cursor CLI";
/** `cursor-agent login`, however the CLI's launcher re-executes itself:
 * every process of it runs from the install's own directory. */
const LOGIN_PROCESS = /cursor-agent\S*(\s\S+)*\slogin(\s|$)/;
const LOGIN_TITLE = "登录 Cursor";

function cursorCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
  durationMs: number,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.install.${id}`,
      title,
      oracle,
      catches,
      tags: ["agent", "script-agent", "agent-install", "cursor-install", "network"],
      llm: { default: "none" },
      expectedDurationMs: durationMs,
      timeoutMs: Math.max(durationMs * 4, 300_000),
      resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0, pool: "heavy" },
      surfaces: ["daemon", "script-agent", "builtin-cursor", "workbench-client", "network"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
    },
    run,
  );
}

const primary = (agent: AgentInfo) => agent.actions?.find((action) => action.primary)?.id;
const notInstalled = (agent: AgentInfo) => agent.source === "builtin" && agent.probe.state !== "ready" && primary(agent) === "install";
const notLoggedIn = (agent: AgentInfo) => agent.probe.state !== "ready" && primary(agent) === "login";

async function open(t: CaseContext): Promise<Opened> {
  return t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
}

async function close(opened: Opened): Promise<void> {
  opened.client.close();
  opened.daemon.stop();
  await opened.mock.stop();
}

/** Before any daemon: network, a user without Cursor, a runtime in place. */
async function prepare(t: CaseContext): Promise<void> {
  await requireHttpsReachable(CURSOR_INSTALL_URL);
  isolateFromHostCursor(t.env);
  seedScriptAgentRuntime(t.env);
}

async function nextRequest(t: CaseContext, pushes: Pushes, title: string, after: number, timeoutMs: number): Promise<AgentRequest> {
  let found: AgentRequest | undefined;
  await t.tools.waitUntil(() => {
    found = pushes.requests.slice(after).find((item) => item.agentId === "cursor" && item.title === title);
    return found !== undefined;
  }, timeoutMs).catch(() => {
    throw new Error(`no "${title}" request within ${timeoutMs}ms; saw ${JSON.stringify(pushes.requests.slice(after).map((item) => item.title))}`);
  });
  return found!;
}

/** The install job is shown as soon as the action is accepted, while its
 * confirmation is still waiting for a person. */
async function installJobWaiting(t: CaseContext, client: Client, ask: AgentRequest): Promise<void> {
  await t.flows.branches.waitForAgent(client, "cursor", (info) =>
    info.job?.action === "install" && info.job.done === false
    && (info.pendingRequests ?? []).some((item) => item.id === ask.id), { timeoutMs: 10_000, what: "showing the install job waiting on its confirmation" });
}

async function choose(t: CaseContext, client: Client, pushes: Pushes, request: AgentRequest, optionId: string): Promise<void> {
  t.assertions.assert(request.options.some((option) => option.id === optionId), `"${request.title}" offers ${JSON.stringify(request.options.map((option) => option.id))}`);
  await t.flows.branches.answerAgentRequest(client, {
    agentId: "cursor", requestId: request.id, outcome: { type: "answered", optionId, answers: [] },
  });
  await t.tools.waitUntil(() => pushes.closed.some((item) => item.requestId === request.id), 15_000)
    .catch(() => { throw new Error(`"${request.title}" never closed after ${optionId}`); });
}

/** Lease processes still running a piece of the install or login. */
function leftovers(t: CaseContext, what: RegExp): string[] {
  return leaseProcesses(t.env).map((item) => item.cmd).filter((cmd) => what.test(cmd));
}

async function noLeftovers(t: CaseContext, what: RegExp, label: string): Promise<void> {
  await t.tools.waitUntil(() => leftovers(t, what).length === 0, 10_000)
    .catch(() => { throw new Error(`${label} still running: ${leftovers(t, what).join(" | ").slice(0, 400)}`); });
}

/** Upstream account login cannot survive a stopped CLI. The durable card
 * records the obligation and limit, never an expiring authorization URL. */
function assertLoginRequest(t: CaseContext, request: AgentRequest): void {
  t.assertions.assert(request.display.length === 0 && (request.detail ?? "").includes("此版本不能在工作台完成账号登录"), "login must explain upstream pause limitation without an expiring URL");
  t.assertions.assert(["check", "cancel"].every(id => request.options.some(option => option.id === id)), "login has no check/cancel actions");
}

cursorCase(
  "cursor-official-installer-then-login-request",
  "Install asks first, runs Cursor's official installer, then stops at a durable account-login instruction; a restart updates only that copy",
  "with no cursor-agent anywhere, built-in cursor offers install; the install action raises \"安装 Cursor CLI\" naming cursor.com/install while AgentInfo.job already shows the install job (done false) waiting on it, and runs nothing until answered; `run` installs the real CLI into the lease home (~/.local/bin link into ~/.local/share/cursor-agent/versions) and state.json records installedByGenehub; the same job then raises \"登录 Cursor\" with a durable account-login capability limitation, no expiring link and no live login process; cancel ends the job without error, leaves no `cursor-agent login` process and the Agent offering login; the login action asks again and its cancel ends done; after a daemon restart a background `update` job runs and finishes without error, stamps lastUpdateCheckMs, and the CLI still answers",
  [
    "the installer runs without asking, or does not show what it will run",
    "install succeeds but the CLI is not found where the official installer puts it",
    "a GeneHub install is not recorded, so it is never kept up to date",
    "no durable login obligation after install",
    "the login link written into the Agent's log",
    "a canceled login leaves cursor-agent login running or the job failed",
    "the background update breaks the installed CLI",
  ],
  async (t) => {
    await prepare(t);
    let opened = await open(t);
    try {
      const pushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        await t.flows.branches.waitForAgent(opened.client, "cursor", notInstalled, { what: "offering install" });
        const ran = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: "cursor", actionId: "install" } });
        t.assertions.assert(ran.ok, `install action: ${ran.ok ? "" : ran.error}`);
        const ask = await nextRequest(t, pushes, INSTALL_TITLE, 0, 30_000);
        await installJobWaiting(t, opened.client, ask);
        t.assertions.assert((ask.detail ?? "").includes(CURSOR_INSTALL_URL) && (ask.detail ?? "").includes("| bash"),
          `the install request does not show the command and source: ${JSON.stringify(ask.detail)}`);
        t.assertions.assert(cursorInstall(t.env).target === null && leftovers(t, /cursor\.com\/install/).length === 0,
          "the installer ran before anyone answered");

        const asked = pushes.requests.length;
        await choose(t, opened.client, pushes, ask, "run");
        const login = await nextRequest(t, pushes, LOGIN_TITLE, asked, 10 * 60_000);
        const installed = cursorInstall(t.env);
        const versions = path.join(realpathSync(t.env.home), ".local", "share", "cursor-agent", "versions");
        t.assertions.assert(installed.target !== null && installed.target.startsWith(versions + path.sep) && installed.versions.length === 1,
          `after install: link ${installed.bin} -> ${installed.target}, versions ${installed.versions.join(",")}`);
        const recorded = cursorScriptState(t.env).installedByGenehub;
        t.assertions.assert(typeof recorded === "string" && existsSync(recorded) && statSync(recorded).isFile()
          && realpathSync(recorded).startsWith(versions + path.sep),
          `state.json installedByGenehub ${JSON.stringify(recorded)}`);
        assertLoginRequest(t, login);
        const logs = await t.flows.branches.agentLogs(opened.client, "cursor");
        t.assertions.assert(!logs.join("\n").includes("loginDeepControl"), "a temporary login link leaked");
        t.assertions.assert(leftovers(t, LOGIN_PROCESS).length === 0, "cursor-agent login retained during Human pause");

        await choose(t, opened.client, pushes, login, "cancel");
        const afterInstall = await t.flows.branches.waitForAgent(opened.client, "cursor",
          (info) => info.job?.action === "install" && info.job.done === true, { what: "install job finished" });
        t.assertions.assert(!afterInstall.job?.error, `install job ended in error: ${afterInstall.job?.error}`);
        await noLeftovers(t, LOGIN_PROCESS, "cursor-agent login");
        await t.flows.branches.waitForAgent(opened.client, "cursor", notLoggedIn, { what: "installed, offering login" });

        const again = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: "cursor", actionId: "login" } });
        t.assertions.assert(again.ok, `login action: ${again.ok ? "" : again.error}`);
        const second = await nextRequest(t, pushes, LOGIN_TITLE, pushes.requests.indexOf(login) + 1, 90_000);
        assertLoginRequest(t, second);
        await choose(t, opened.client, pushes, second, "cancel");
        const canceled = await t.flows.branches.waitForAgent(opened.client, "cursor",
          (info) => info.job?.action === "login" && info.job.done === true, { what: "login job finished" });
        t.assertions.assert(!canceled.job?.error, `canceled login ended in error: ${canceled.job?.error}`);
        await noLeftovers(t, LOGIN_PROCESS, "cursor-agent login");
      } finally {
        pushes.stop();
      }

      // A new serve process: the installed copy is GeneHub's, never checked.
      t.assertions.assert(cursorScriptState(t.env).lastUpdateCheckMs === undefined, "an update check ran before the restart");
      await close(opened);
      const restartedAt = Date.now();
      opened = await open(t);
      const updated = await t.flows.branches.waitForAgent(opened.client, "cursor",
        (info) => info.job?.action === "update" && info.job.done === true, { timeoutMs: 10 * 60_000, what: "background update finished" });
      t.note(`background update: ${updated.job?.message ?? ""}`);
      t.assertions.assert(!updated.job?.error, `background update ended in error: ${updated.job?.error}`);
      const stamped = cursorScriptState(t.env).lastUpdateCheckMs;
      t.assertions.assert(typeof stamped === "number" && stamped >= restartedAt, `lastUpdateCheckMs ${JSON.stringify(stamped)}`);
      const after = cursorInstall(t.env);
      t.assertions.assert(after.target !== null && existsSync(after.target), `the CLI link is broken after the update: ${readlinkSafe(after.bin)}`);
      const settled = await t.flows.branches.waitForAgent(opened.client, "cursor", notLoggedIn, { what: "still installed, offering login" });
      t.assertions.assert(typeof settled.version === "string" && settled.version.trim() !== "", "the updated CLI reports no version");
    } finally {
      await close(opened);
    }
  },
  40_000,
);

function readlinkSafe(file: string): string {
  try { return readlinkSync(file); } catch { return "(no link)"; }
}

cursorCase(
  "cursor-install-canceled",
  "Canceling the install request installs nothing and leaves nothing running",
  "with no cursor-agent anywhere, answering \"安装 Cursor CLI\" (its install job already shown, not done) with cancel ends the install job done without error, nothing appears under the lease home's ~/.local/bin or ~/.local/share/cursor-agent, no curl/bash of the installer is running, and the Agent still offers install",
  [
    "cancel still runs the installer",
    "a canceled install reported as a failure",
    "installer processes left behind after cancel",
  ],
  async (t) => {
    await prepare(t);
    const opened = await open(t);
    const pushes = t.flows.branches.recordAgentPushes(opened.client);
    try {
      await t.flows.branches.waitForAgent(opened.client, "cursor", notInstalled, { what: "offering install" });
      const ran = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: "cursor", actionId: "install" } });
      t.assertions.assert(ran.ok, `install action: ${ran.ok ? "" : ran.error}`);
      const ask = await nextRequest(t, pushes, INSTALL_TITLE, 0, 30_000);
      await installJobWaiting(t, opened.client, ask);
      await choose(t, opened.client, pushes, ask, "cancel");
      const done = await t.flows.branches.waitForAgent(opened.client, "cursor",
        (info) => info.job?.action === "install" && info.job.done === true, { what: "install job finished" });
      t.assertions.assert(!done.job?.error, `canceled install ended in error: ${done.job?.error}`);
      await noLeftovers(t, /cursor\.com\/install|\bcurl\b/, "the installer");
      const left = cursorInstall(t.env);
      t.assertions.assert(left.target === null && !existsSync(left.bin) && !existsSync(path.join(t.env.home, ".local", "share", "cursor-agent")),
        `a canceled install left ${left.bin} / versions ${left.versions.join(",")}`);
      await t.flows.branches.waitForAgent(opened.client, "cursor", notInstalled, { what: "still offering install" });
      t.assertions.assert(!pushes.requests.some((item) => item.title === LOGIN_TITLE), "a login request followed a canceled install");
    } finally {
      pushes.stop();
      await close(opened);
    }
  },
  10_000,
);

/** How long the observation lasts after the Agent reported its state. In the
 * GeneHub-installed case the update job starts right after that report (one
 * `cursor-agent --help`), well inside this window. */
const QUIET_WINDOW_MS = 15_000;

cursorCase(
  "cursor-user-installed-not-auto-updated",
  "A Cursor CLI the user installed is found but never updated in the background",
  "with Cursor installed into the lease home by running the official installer by hand before the daemon starts, built-in cursor finds it (not logged in, offers login) and records no installedByGenehub; over a 15s window after that report no `update` job appears in agent.list or pushes, no lease process runs `cursor-agent update`, state.json gets no lastUpdateCheckMs, and the version directories and link target are unchanged. Oracle strength: absence over a bounded window; the positive control is the restart step of cursor-official-installer-then-login-request",
  [
    "a user's own CLI updated behind their back",
    "a user-installed CLI recorded as installed by GeneHub",
    "a CLI in ~/.local/bin not found without PATH",
  ],
  async (t) => {
    await prepare(t);
    const before = await installCursorAsUser(t.env);
    const sampled = new Set<string>();
    const sample = setInterval(() => {
      for (const item of leaseProcesses(t.env)) {
        if (/cursor-agent/.test(item.cmd) && /(^|\s)update(\s|$)/.test(item.cmd)) sampled.add(item.cmd);
      }
    }, 200);
    const opened = await open(t);
    const pushes = t.flows.branches.recordAgentPushes(opened.client);
    try {
      const found = await t.flows.branches.waitForAgent(opened.client, "cursor", notLoggedIn, { timeoutMs: 60_000, what: "found, offering login" });
      t.assertions.assert(found.source === "builtin" && typeof found.version === "string", `found ${JSON.stringify(t.flows.branches.summarizeAgent(found))}`);
      await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
      const now = await t.flows.branches.listAgents(opened.client);
      const jobs = [...pushes.lists, now].flatMap((agents) => agents.filter((item) => item.id === "cursor" && item.job).map((item) => item.job!.action));
      const state = cursorScriptState(t.env);
      const after = cursorInstall(t.env);
      t.note(`jobs seen: ${JSON.stringify([...new Set(jobs)])}; versions ${after.versions.length}`);
      t.assertions.assert(!jobs.includes("update"), "an update job ran for a CLI the user installed");
      t.assertions.assert(sampled.size === 0, `cursor-agent update ran: ${[...sampled].join(" | ").slice(0, 300)}`);
      t.assertions.assert(state.installedByGenehub === undefined, `state.json claims GeneHub installed it: ${JSON.stringify(state.installedByGenehub)}`);
      t.assertions.assert(state.lastUpdateCheckMs === undefined, "an update check was stamped for a user-installed CLI");
      t.assertions.assert(JSON.stringify(after) === JSON.stringify(before), `the user's install changed: ${JSON.stringify(before.versions)} -> ${JSON.stringify(after.versions)}`);
    } finally {
      clearInterval(sample);
      pushes.stop();
      await close(opened);
    }
  },
  35_000,
);

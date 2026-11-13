// Terminating a project is the user's decision that nothing in it runs any
// more, and the platform keeps it: a team's own scripts, timer hooks and
// Agents cannot start it again, only an explicit resume of the terminated
// project can. Members added later are covered too, and so is every channel
// that has the project open, because the mark lives in the project. Removing a
// busy project stops it first instead of refusing, without leaving it
// terminated (fb_KGMfudZVL1CT).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createLease,
  daemonEndpoint,
  defineSpecialty,
  localGenetCli,
  openWorkbenchPage,
  releaseLease,
  type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Client = Opened["client"];

const TERMINATED = "已被用户终止";

async function team(t: CaseContext, client: Client) {
  const make = async (name: string, parent?: string) => {
    const root = path.join(t.env.root, "spaces", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "agent-space.genet.json"), JSON.stringify({ schema: "agent-space.v1", name, tags: ["team"], folders: [{ path: "." }] }));
    const opened = await client.call({ type: "workspace.open", payload: { root } });
    if (opened?.type !== "workspace") throw new Error(`open ${name} failed`);
    const configured = await client.call({ type: "agentSpace.configure", payload: { workspaceId: opened.data.id, expectedRevision: opened.data.agentSpace?.revision ?? 0,
      operation: parent ? { kind: "setParent", parentWorkspaceId: parent } : { kind: "setLifecycle", lifecycle: "persistent" } } });
    if (configured?.type !== "workspace") throw new Error(`configure ${name} failed`);
    writeFileSync(path.join(root, "sentinel.txt"), name);
    return { id: opened.data.id, root };
  };
  const root = await make("stopped-team");
  const child = await make("member", root.id);
  const nested = await make("nested", child.id);
  const survivor = await make("bystander");
  return { make, root, child, nested, survivor, ids: [root.id, child.id, nested.id] };
}

/** A session in `workspaceId` that is waiting on the Human, as a busy team member is. */
async function waitingSession(t: CaseContext, opened: Opened, workspaceId: string): Promise<string> {
  const sid = await t.flows.main.createBuiltinSession(opened.client, workspaceId);
  opened.mock.script({ tool: { name: "request_user_input", arguments: { questions: [{ id: "decision", header: "检查", question: "是否继续？",
    options: [{ label: "继续", description: "继续任务" }, { label: "稍后", description: "等待确认" }] }] } } });
  await t.flows.main.sendPrompt(opened.client, sid, "请先确认再继续");
  await t.tools.waitUntil(async () => (await status(opened.client, sid)) === "waiting", 30_000);
  return sid;
}

async function status(client: Client, sid: string): Promise<string | undefined> {
  const got = await client.call({ type: "session.get", payload: { sessionId: sid, summaryOnly: true } });
  return got?.type === "session" ? got.data.status : got?.type === "snapshot" ? got.data.summary.status : undefined;
}

async function refused(call: () => Promise<unknown>): Promise<string> {
  try { await call(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return "";
}

async function terminatedIds(client: Client): Promise<string[]> {
  const listed = await client.call({ type: "workspace.list" });
  return listed?.type === "workspaces" ? listed.data.filter(w => w.terminatedAtMs !== undefined).map(w => w.id) : [];
}

const ticks = (root: string) => existsSync(path.join(root, "ticks.log")) ? readFileSync(path.join(root, "ticks.log"), "utf8").split("\n").filter(Boolean).length : 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Running, not merely an unreaped zombie. */
function alive(pid: number): boolean {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

async function hookStaysQuiet(t: CaseContext, root: string, why: string) {
  await sleep(2_500);
  const frozen = ticks(root);
  await sleep(3_000);
  t.assertions.assert(ticks(root) === frozen, `${why}: the team's timer hook kept running (${frozen} -> ${ticks(root)})`);
}

defineSpecialty({
  id: "specialty.daemon.workspace-terminate.team-stays-stopped",
  title: "A terminated team stays stopped until the user resumes it, across a daemon restart",
  oracle: "workspace terminate stops a waiting member session, ends a running timer hook and keeps the team's hooks silent; session.send, system notices and script sends are refused before and after a restart, also in a member added afterwards and in a session created afterwards; resuming a member points at the terminated project; workspace resume of that project lifts it for the whole team without restarting anything, after which a message runs again",
  catches: ["termination that a team script or timer hook undoes", "a running hook left running", "a member added after termination escaping it", "termination lost on restart", "a waiting member left waiting", "termination spilling onto an unrelated project", "resume restarting sessions by itself", "a member resume that silently does nothing"],
  tags: ["core", "daemon", "workspace-terminate", "genet-cli"], llm: { default: "mock" },
  expectedDurationMs: 40_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "genet-cli"], productInterfaces: ["workspace.terminate", "workspace.resume", "workspace.list", "agentSpace.configure", "session.send", "session.create", "timer hooks", "genet workspace terminate", "genet workspace resume"],
}, async t => {
  const cli = localGenetCli(t.openRoot, t.env);
  let opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const { make, root, child, nested, survivor, ids } = await team(t, opened.client);
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    mkdirSync(path.join(root.root, ".genethub", "hooks"), { recursive: true });
    writeFileSync(path.join(root.root, ".genethub", "hooks", "tick.genet.json"), JSON.stringify({ schema: "genet.hook.v1", event: "timer", every: "1s", exec: ["sh", "-c", "date +%s%N >> ticks.log"] }));
    writeFileSync(path.join(root.root, "hold"), "");
    writeFileSync(path.join(root.root, ".genethub", "hooks", "long.genet.json"), JSON.stringify({ schema: "genet.hook.v1", event: "timer", every: "1s", exec: ["sh", "-c", "test -f hold || exit 0; echo $$ > long.pid; exec sleep 25"] }));
    await t.tools.waitUntil(() => ticks(root.root) >= 2 && existsSync(path.join(root.root, "long.pid")), 30_000);
    const longPid = Number(readFileSync(path.join(root.root, "long.pid"), "utf8").trim());
    t.assertions.assert(alive(longPid), "the long hook was not running before termination");
    const sid = await waitingSession(t, opened, nested.id);

    const terminated = cli(["workspace", "terminate", root.id]);
    t.assertions.assert(terminated.code === 0 && terminated.envelope?.type === "workspace.terminate", `genet workspace terminate: ${terminated.code} ${terminated.stdout.slice(-300)} ${terminated.stderr.slice(-300)}`);
    t.assertions.assert(JSON.stringify((await terminatedIds(opened.client)).sort()) === JSON.stringify([...ids].sort()), "termination did not cover exactly the team and its members");
    const after = await status(opened.client, sid);
    t.assertions.assert(after !== "waiting" && after !== "running", `the member session is still ${after}`);
    await t.tools.waitUntil(() => !alive(longPid), 10_000).catch(() => t.assertions.assert(false, "termination left the running hook running"));
    rmSync(path.join(root.root, "hold"));

    const late = await make("late-member", child.id);
    t.assertions.assert((await terminatedIds(opened.client)).includes(late.id), "a member added after termination is not shown as terminated");
    const wholeTeam = [...ids, late.id].sort();
    const memberResume = cli(["workspace", "resume", child.id]);
    t.assertions.assert(memberResume.code !== 0 && `${memberResume.stdout}${memberResume.stderr}`.includes(root.id), `resuming a member did not point at the terminated project: ${memberResume.code} ${memberResume.stdout.slice(-300)} ${memberResume.stderr.slice(-300)}`);

    const refusals = async (client: Client, when: string) => {
      const send = await refused(() => client.call({ type: "session.send", payload: { sessionId: sid, text: "继续干活", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } }));
      t.assertions.assert(send.includes(TERMINATED), `${when}: session.send was not refused: ${send}`);
      const notice = await refused(() => client.call({ type: "session.send", payload: { sessionId: sid, messageId: `wake-${when}`, text: "团队调度唤醒", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null, origin: { machineId: "", sessionId: "system" } } }));
      t.assertions.assert(notice.includes(TERMINATED), `${when}: a team system notice was not refused: ${notice}`);
      for (const workspaceId of [child.id, late.id]) {
        const created = await t.flows.main.createBuiltinSession(client, workspaceId);
        const first = await refused(() => client.call({ type: "session.send", payload: { sessionId: created, text: "新会话开工", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } }));
        t.assertions.assert(first.includes(TERMINATED) && first.includes(root.id), `${when}: a session created in ${workspaceId} accepted work: ${first}`);
      }
      const scripted = cli(["session", "send", sid, "团队脚本补发", "--system", "--message-id", `script-${when}`, "--no-wait"]);
      t.assertions.assert(scripted.code !== 0 && `${scripted.stdout}${scripted.stderr}`.includes(TERMINATED), `${when}: genet session send from a script was not refused: ${scripted.code} ${scripted.stdout.slice(-300)}`);
      await hookStaysQuiet(t, root.root, when);
    };
    await refusals(opened.client, "terminated");
    const unrelated = await t.flows.main.createBuiltinSession(opened.client, survivor.id);
    t.assertions.assert(Boolean(unrelated), "an unrelated project was affected");

    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
    opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    t.assertions.assert(JSON.stringify((await terminatedIds(opened.client)).sort()) === JSON.stringify(wholeTeam), "termination did not survive a daemon restart");
    await refusals(opened.client, "restarted");

    const resumed = cli(["workspace", "resume", root.id]);
    t.assertions.assert(resumed.code === 0 && resumed.envelope?.type === "workspace.resume", `genet workspace resume: ${resumed.code} ${resumed.stdout.slice(-300)}`);
    t.assertions.assert((await terminatedIds(opened.client)).length === 0, "resume left part of the team terminated");
    const idle = await status(opened.client, sid);
    t.assertions.assert(idle !== "running" && idle !== "waiting", `resume restarted the session by itself: ${idle}`);
    const before = ticks(root.root);
    await t.tools.waitUntil(() => ticks(root.root) > before, 30_000);
    opened.mock.script({ text: "resumed-reply-marker" });
    await t.flows.main.sendPrompt(opened.client, sid, "恢复后继续");
    await t.tools.waitUntil(async () => {
      const got = await opened.client.call({ type: "session.get", payload: { sessionId: sid } });
      return got?.type === "snapshot" && got.data.summary.status === "idle" && JSON.stringify(got.data).includes("resumed-reply-marker");
    }, 45_000);
    for (const item of [root, child, nested]) t.assertions.assert(readFileSync(path.join(item.root, "sentinel.txt"), "utf8") !== "", "termination changed user files");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

defineSpecialty({
  id: "specialty.daemon.workspace-terminate.remove-busy-team",
  title: "Removing a busy team stops it, removes every registration and leaves no termination behind",
  oracle: "workspace.remove with terminate succeeds while a nested member waits on the Human; the member stops waiting, all three registrations go and files and history stay; reopening the project finds it runnable, while a project the user had terminated before removing it is still terminated when reopened; removing a project whose folder was deleted leaves no folder behind",
  catches: ["a busy project that cannot be removed", "removal that leaves a session waiting or running", "removal that silently terminates the project for every channel", "removal that clears a termination the user chose", "removal that recreates a project folder the user deleted"],
  tags: ["core", "daemon", "workspace-terminate", "workspace-team-removal"], llm: { default: "mock" },
  expectedDurationMs: 15_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon"], productInterfaces: ["workspace.remove", "workspace.open", "workspace.list", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const { make, root, nested, survivor, ids } = await team(t, opened.client);
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const sid = await waitingSession(t, opened, nested.id);
    const removed = await opened.client.call({ type: "workspace.remove", payload: { workspaceId: root.id, terminate: true } });
    t.assertions.assert(removed?.type === "workspaces" && ids.every(id => !removed.data.some(w => w.id === id)) && removed.data.some(w => w.id === survivor.id), "terminating removal left registrations or removed an unrelated project");
    t.assertions.assert(readFileSync(path.join(nested.root, "sentinel.txt"), "utf8") === "nested", "removal changed user files");
    t.assertions.assert(!existsSync(path.join(root.root, ".genethub", "terminated.json")), "removal left a termination in the project");
    const reopened = await opened.client.call({ type: "workspace.open", payload: { root: root.root } });
    t.assertions.assert(reopened?.type === "workspace" && reopened.data.id === root.id && reopened.data.terminatedAtMs === undefined, "removal left the reopened project terminated");
    const member = await opened.client.call({ type: "workspace.open", payload: { root: nested.root } });
    t.assertions.assert(member?.type === "workspace" && member.data.id === nested.id && member.data.terminatedAtMs === undefined, "the removed member could not be reopened as runnable");

    const chosen = await opened.client.call({ type: "workspace.terminate", payload: { workspaceId: survivor.id } });
    t.assertions.assert(chosen?.type === "workspaces", "terminating the bystander failed");
    const gone = await opened.client.call({ type: "workspace.remove", payload: { workspaceId: survivor.id, terminate: true } });
    t.assertions.assert(gone?.type === "workspaces" && !gone.data.some(w => w.id === survivor.id), "the terminated project was not removed");
    const kept = await opened.client.call({ type: "workspace.open", payload: { root: survivor.root } });
    t.assertions.assert(kept?.type === "workspace" && kept.data.terminatedAtMs !== undefined, "removal cleared a termination the user chose");

    const deleted = await make("deleted-on-disk");
    rmSync(deleted.root, { recursive: true, force: true });
    const forgotten = await opened.client.call({ type: "workspace.remove", payload: { workspaceId: deleted.id, terminate: true } });
    t.assertions.assert(forgotten?.type === "workspaces" && !forgotten.data.some(w => w.id === deleted.id), "a project whose folder was deleted could not be removed");
    t.assertions.assert(!existsSync(deleted.root), "removal recreated the deleted project folder");
    const history = await opened.client.call({ type: "session.get", payload: { sessionId: sid } });
    t.assertions.assert(history?.type === "snapshot" && history.data.summary.status !== "waiting" && history.data.summary.status !== "running", "the member session still waited when it was removed");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

defineSpecialty({
  id: "specialty.page-experience.workspace-terminate",
  title: "The project list terminates a waiting project and then removes it after confirming",
  oracle: "In a real browser, 终止 next to 移除 asks for confirmation that says what it stops and who can resume, stops the waiting session and marks the project 已终止; 移除 on a still-busy project then explains it will stop it first and completes instead of being refused, leaving it runnable when reopened",
  catches: ["no way to stop a project from the list", "termination without confirmation", "removal of a busy project refused (fb_KGMfudZVL1CT)", "terminated state invisible"],
  tags: ["page-experience", "workspace-terminate"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 20_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 3, memoryMb: 3072, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon"], productInterfaces: ["workspace.terminate", "workspace.remove", "project-list confirmation"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const make = async (name: string) => {
      const root = path.join(t.env.root, "spaces", name); mkdirSync(root, { recursive: true });
      const w = await opened.client.call({ type: "workspace.open", payload: { root } });
      if (w?.type !== "workspace") throw new Error("open failed");
      await opened.client.call({ type: "workspace.rename", payload: { workspaceId: w.data.id, name } });
      return w.data.id;
    };
    const stopped = await make("stop-target"), busy = await make("busy-target");
    const busyRoot = path.join(t.env.root, "spaces", "busy-target");
    const stoppedSid = await waitingSession(t, opened, stopped);
    const busySid = await waitingSession(t, opened, busy);
    await opened.client.call({ type: "session.rename", payload: { sessionId: stoppedSid, title: "Removal bystander conversation" } });
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, stoppedSid, { viewport: { width: 1280, height: 900 } }, { trace: false }, {
      targets: () => [{ id: "terminate-source", deviceHandle: opened.client.identity!.machineId, fingerprint: opened.client.identity!.fingerprint, label: "Terminate source", kind: "local", online: true }],
      endpoint: () => daemonEndpoint(opened.daemon),
    });
    const page = browser.page;
    await page.getByRole("button", { name: "当前项目", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "项目", exact: true }).click();
    const projects = page.getByRole("complementary", { name: "项目列表面板", exact: true });
    const project = projects.getByRole("region", { name: "项目 stop-target", exact: true });
    await project.waitFor();
    await projects.getByRole("button", { name: "批量", exact: true }).click();
    await project.getByRole("checkbox", { name: "选择项目 stop-target", exact: true }).check();
    await projects.getByRole("button", { name: "终止", exact: true }).click();
    const terminate = page.getByRole("dialog", { name: "终止所选项目", exact: true });
    await terminate.getByText("未升级的旧版本 GeneHub 除外", { exact: false }).waitFor();
    await terminate.getByText("恢复需由你操作或明确要求 Agent 执行", { exact: false }).waitFor();
    await terminate.getByRole("button", { name: "确认终止 1 项", exact: true }).click();
    await projects.getByText("1 项已终止", { exact: true }).waitFor({ timeout: 15_000 });
    await project.getByText("已终止", { exact: true }).waitFor({ timeout: 5_000 });
    t.assertions.assert(!["waiting", "running"].includes((await status(opened.client, stoppedSid)) ?? ""), "the browser termination left the session waiting");
    t.assertions.assert((await terminatedIds(opened.client)).includes(stopped), "the daemon did not record the termination");

    const busyProject = projects.getByRole("region", { name: "项目 busy-target", exact: true });
    await busyProject.getByRole("checkbox", { name: "选择项目 busy-target", exact: true }).check();
    await projects.getByRole("button", { name: "移除", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "移除所选项目", exact: true });
    await remove.getByText("会先被平台停止", { exact: false }).waitFor();
    await remove.getByRole("button", { name: "确认移除 1 项", exact: true }).click();
    await busyProject.waitFor({ state: "detached", timeout: 15_000 });
    await projects.getByText("1 项已移除", { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    await page.getByRole("heading", { name: "Removal bystander conversation", exact: true }).waitFor();
    const listed = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(listed?.type === "workspaces" && !listed.data.some(w => w.id === busy), "the busy project is still registered");
    const reopened = await opened.client.call({ type: "workspace.open", payload: { root: busyRoot } });
    t.assertions.assert(reopened?.type === "workspace" && reopened.data.id === busy && reopened.data.terminatedAtMs === undefined, "the removal left the busy project terminated");
    t.assertions.assert(!["waiting", "running"].includes((await status(opened.client, busySid)) ?? ""), "the removed project's session still waited");
    const history = await opened.client.call({ type: "session.get", payload: { sessionId: busySid } });
    t.assertions.assert(history?.type === "snapshot" && history.data.items.some(item => item.type === "userMessage" && item.text.includes("请先确认再继续")), "registration removal erased conversation history");
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

type InboxEntry = { messageId: string; state: string; turnId?: string | null };
const inboxEntry = (root: string, sid: string, messageId: string): InboxEntry | undefined =>
  (JSON.parse(readFileSync(path.join(root, ".genethub", "sessions", sid, "meta.json"), "utf8")).inbox?.entries as InboxEntry[] | undefined)?.find(entry => entry.messageId === messageId);

defineSpecialty({
  id: "specialty.daemon.workspace-terminate.every-channel",
  title: "Terminating a project in one channel stops it in another channel that has it open, keeping the team's queued input paused",
  oracle: "Two daemons with separate data directories open the same project; terminating it in the first makes the second stop its waiting session, end the team's timer hook and refuse new input, while a team notice queued behind the question stays queued; resuming in the first lifts it in the second without delivering that notice by itself, and the user's next message runs",
  catches: ["termination kept in one channel's data directory (L13)", "a channel that keeps running a project terminated elsewhere", "a team notice lost by termination, leaving the team waiting on a receipt", "queued input replayed by resume alone"],
  tags: ["core", "daemon", "workspace-terminate"], llm: { default: "mock" },
  expectedDurationMs: 40_000, timeoutMs: 180_000,
  resources: { environments: 2, cpu: 3, memoryMb: 3072, io: 1, browser: 0 },
  surfaces: ["daemon"], productInterfaces: ["workspace.terminate", "workspace.resume", "workspace.open", "workspace.list", "session.send", "timer hooks"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const peerLease = createLease("terminate-peer-");
  let peer: Opened | undefined;
  try {
    peer = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: peerLease });
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await t.flows.main.configureMockProvider(peer.client, peer.mock);
    const root = path.join(t.env.root, "spaces", "shared-project");
    mkdirSync(path.join(root, ".genethub", "hooks"), { recursive: true });
    const here = await opened.client.call({ type: "workspace.open", payload: { root } });
    const there = await peer.client.call({ type: "workspace.open", payload: { root } });
    if (here?.type !== "workspace" || there?.type !== "workspace") throw new Error("opening the shared project failed");
    writeFileSync(path.join(root, ".genethub", "hooks", "tick.genet.json"), JSON.stringify({ schema: "genet.hook.v1", event: "timer", every: "1s", exec: ["sh", "-c", "date +%s%N >> ticks.log"] }));
    await t.tools.waitUntil(() => ticks(root) >= 2, 30_000);

    const sid = await waitingSession(t, peer, there.data.id);
    await peer.client.call({ type: "session.send", payload: { sessionId: sid, messageId: "stale-team-order", text: "团队调度：继续上一个任务", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null, origin: { machineId: "", sessionId: "system" } } });
    await t.tools.waitUntil(() => inboxEntry(root, sid, "stale-team-order")?.state === "queued", 10_000)
      .catch(() => t.assertions.assert(false, `the team notice was not queued behind the question: ${JSON.stringify(inboxEntry(root, sid, "stale-team-order"))}`));

    const terminated = await opened.client.call({ type: "workspace.terminate", payload: { workspaceId: here.data.id } });
    t.assertions.assert(terminated?.type === "workspaces", "terminating in the first channel failed");
    await t.tools.waitUntil(async () => !["waiting", "running"].includes((await status(peer!.client, sid)) ?? ""), 10_000)
      .catch(() => t.assertions.assert(false, "the other channel kept its session waiting in a terminated project"));
    t.assertions.assert((await terminatedIds(peer.client)).includes(there.data.id), "the other channel does not list the project as terminated");
    const send = await refused(() => peer!.client.call({ type: "session.send", payload: { sessionId: sid, text: "继续干活", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } }));
    t.assertions.assert(send.includes(TERMINATED), `the other channel accepted input: ${send}`);
    await hookStaysQuiet(t, root, "terminated elsewhere");
    t.assertions.assert(inboxEntry(root, sid, "stale-team-order")?.state === "queued", `termination changed the team's queued notice: ${JSON.stringify(inboxEntry(root, sid, "stale-team-order"))}`);

    const resumed = await opened.client.call({ type: "workspace.resume", payload: { workspaceId: here.data.id } });
    t.assertions.assert(resumed?.type === "workspaces", "resuming in the first channel failed");
    await t.tools.waitUntil(async () => !(await terminatedIds(peer!.client)).includes(there.data.id), 10_000)
      .catch(() => t.assertions.assert(false, "the other channel still lists the resumed project as terminated"));
    const before = ticks(root);
    await t.tools.waitUntil(() => ticks(root) > before, 30_000);
    const waiting = inboxEntry(root, sid, "stale-team-order");
    t.assertions.assert(waiting?.state === "queued" && !waiting.turnId, `resume delivered the queued notice by itself: ${JSON.stringify(waiting)}`);
    peer.mock.script({ text: "peer-resumed-marker" }, { text: "team-notice-read" });
    await t.flows.main.sendPrompt(peer.client, sid, "恢复后继续");
    await t.tools.waitUntil(async () => {
      const got = await peer!.client.call({ type: "session.get", payload: { sessionId: sid } });
      return got?.type === "snapshot" && got.data.summary.status === "idle" && JSON.stringify(got.data).includes("peer-resumed-marker");
    }, 45_000);
  } finally {
    if (peer) { peer.client.close(); peer.daemon.stop(); await peer.mock.stop(); }
    releaseLease(peerLease);
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

defineSpecialty({
  id: "specialty.daemon.workspace-terminate.other-channel-continues",
  title: "After a terminate and resume in one channel, another channel can continue the sessions it stopped",
  oracle: "A session another channel started waits on the Human and that daemon restarts; the first channel terminates and resumes the project, stopping the session; the other channel then sends to that session and gets an answer instead of a write-lock refusal",
  catches: ["a channel that keeps the write lock of every session it stopped"],
  tags: ["core", "daemon", "workspace-terminate"], llm: { default: "mock" },
  expectedDurationMs: 30_000, timeoutMs: 150_000,
  resources: { environments: 2, cpu: 3, memoryMb: 3072, io: 1, browser: 0 },
  surfaces: ["daemon"], productInterfaces: ["workspace.terminate", "workspace.resume", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const peerLease = createLease("terminate-continue-");
  let peer: Opened | undefined;
  try {
    peer = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: peerLease });
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await t.flows.main.configureMockProvider(peer.client, peer.mock);
    const root = path.join(t.env.root, "spaces", "shared-project");
    mkdirSync(root, { recursive: true });
    const here = await opened.client.call({ type: "workspace.open", payload: { root } });
    const there = await peer.client.call({ type: "workspace.open", payload: { root } });
    if (here?.type !== "workspace" || there?.type !== "workspace") throw new Error("opening the shared project failed");
    const sid = await waitingSession(t, peer, there.data.id);
    peer.client.close(); peer.daemon.stop(); await peer.mock.stop();

    const terminated = await opened.client.call({ type: "workspace.terminate", payload: { workspaceId: here.data.id } });
    t.assertions.assert(terminated?.type === "workspaces", "terminating failed");
    t.assertions.assert(!["waiting", "running"].includes((await status(opened.client, sid)) ?? ""), "the waiting session was not stopped");
    const resumed = await opened.client.call({ type: "workspace.resume", payload: { workspaceId: here.data.id } });
    t.assertions.assert(resumed?.type === "workspaces", "resuming failed");

    peer = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: peerLease });
    await t.flows.main.configureMockProvider(peer.client, peer.mock);
    await peer.client.call({ type: "workspace.open", payload: { root } });
    peer.mock.script({ text: "continued-elsewhere-marker" });
    const send = await refused(() => peer!.client.call({ type: "session.send", payload: { sessionId: sid, text: "恢复后继续", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } }));
    t.assertions.assert(send === "", `the other channel could not continue the session: ${send}`);
    await t.tools.waitUntil(async () => {
      const got = await peer!.client.call({ type: "session.get", payload: { sessionId: sid } });
      return got?.type === "snapshot" && got.data.summary.status === "idle" && JSON.stringify(got.data).includes("continued-elsewhere-marker");
    }, 45_000);
  } finally {
    if (peer) { peer.client.close(); peer.daemon.stop(); await peer.mock.stop(); }
    releaseLease(peerLease);
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

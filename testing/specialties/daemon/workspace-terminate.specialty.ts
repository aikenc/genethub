// Terminating a project is the user's decision that nothing in it runs any
// more, and the platform keeps it: a team's own scripts, timer hooks and
// Agents cannot start it again, only an explicit resume can. Removing a busy
// project terminates it first instead of refusing (fb_KGMfudZVL1CT).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  daemonEndpoint,
  defineSpecialty,
  localGenetCli,
  openWorkbenchPage,
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
  return { root, child, nested, survivor, ids: [root.id, child.id, nested.id] };
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

async function hookStaysQuiet(t: CaseContext, root: string, why: string) {
  await sleep(2_500);
  const frozen = ticks(root);
  await sleep(3_000);
  t.assertions.assert(ticks(root) === frozen, `${why}: the team's timer hook kept running (${frozen} -> ${ticks(root)})`);
}

defineSpecialty({
  id: "specialty.daemon.workspace-terminate.team-stays-stopped",
  title: "A terminated team stays stopped until the user resumes it, across a daemon restart",
  oracle: "workspace terminate stops a waiting member session and the team's timer hook; session.send, system notices, session.create and the hook are refused or silent before and after a restart; workspace resume lifts it without restarting anything, after which a message runs again",
  catches: ["termination that a team script or timer hook undoes", "termination lost on restart", "a waiting member left waiting", "termination spilling onto an unrelated project", "resume restarting sessions by itself"],
  tags: ["core", "daemon", "workspace-terminate", "genet-cli"], llm: { default: "mock" },
  expectedDurationMs: 40_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "genet-cli"], productInterfaces: ["workspace.terminate", "workspace.resume", "workspace.list", "session.send", "session.create", "timer hooks", "genet workspace terminate", "genet workspace resume"],
}, async t => {
  const cli = localGenetCli(t.openRoot, t.env);
  let opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const { root, child, nested, survivor, ids } = await team(t, opened.client);
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    mkdirSync(path.join(root.root, ".genethub", "hooks"), { recursive: true });
    writeFileSync(path.join(root.root, ".genethub", "hooks", "tick.genet.json"), JSON.stringify({ schema: "genet.hook.v1", event: "timer", every: "1s", exec: ["sh", "-c", "date +%s%N >> ticks.log"] }));
    await t.tools.waitUntil(() => ticks(root.root) >= 2, 30_000);
    const sid = await waitingSession(t, opened, nested.id);

    const terminated = cli(["workspace", "terminate", root.id]);
    t.assertions.assert(terminated.code === 0 && terminated.envelope?.type === "workspace.terminate", `genet workspace terminate: ${terminated.code} ${terminated.stdout.slice(-300)} ${terminated.stderr.slice(-300)}`);
    t.assertions.assert(JSON.stringify((await terminatedIds(opened.client)).sort()) === JSON.stringify([...ids].sort()), "termination did not cover exactly the team and its members");
    const after = await status(opened.client, sid);
    t.assertions.assert(after !== "waiting" && after !== "running", `the member session is still ${after}`);

    const refusals = async (client: Client, when: string) => {
      const send = await refused(() => client.call({ type: "session.send", payload: { sessionId: sid, text: "继续干活", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } }));
      t.assertions.assert(send.includes(TERMINATED), `${when}: session.send was not refused: ${send}`);
      const notice = await refused(() => client.call({ type: "session.send", payload: { sessionId: sid, messageId: `wake-${when}`, text: "团队调度唤醒", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null, origin: { machineId: "", sessionId: "system" } } }));
      t.assertions.assert(notice.includes(TERMINATED), `${when}: a team system notice was not refused: ${notice}`);
      const create = await refused(() => t.flows.main.createBuiltinSession(client, child.id));
      t.assertions.assert(create.includes(TERMINATED), `${when}: session.create in a member was not refused: ${create}`);
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
    t.assertions.assert(JSON.stringify((await terminatedIds(opened.client)).sort()) === JSON.stringify([...ids].sort()), "termination did not survive a daemon restart");
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
  title: "Removing a busy team with terminate stops it and removes every registration",
  oracle: "workspace.remove with terminate succeeds while a nested member waits on the Human; the member stops waiting, all three registrations go, files and history stay, and reopening the member finds it still terminated",
  catches: ["a busy project that cannot be removed", "removal that leaves a session waiting or running", "a removed project silently restartable by reopening it"],
  tags: ["core", "daemon", "workspace-terminate", "workspace-team-removal"], llm: { default: "mock" },
  expectedDurationMs: 15_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon"], productInterfaces: ["workspace.remove", "workspace.open", "workspace.list", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const { root, nested, survivor, ids } = await team(t, opened.client);
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const sid = await waitingSession(t, opened, nested.id);
    const removed = await opened.client.call({ type: "workspace.remove", payload: { workspaceId: root.id, terminate: true } });
    t.assertions.assert(removed?.type === "workspaces" && ids.every(id => !removed.data.some(w => w.id === id)) && removed.data.some(w => w.id === survivor.id), "terminating removal left registrations or removed an unrelated project");
    t.assertions.assert(readFileSync(path.join(nested.root, "sentinel.txt"), "utf8") === "nested", "removal changed user files");
    const reopened = await opened.client.call({ type: "workspace.open", payload: { root: nested.root } });
    t.assertions.assert(reopened?.type === "workspace" && reopened.data.id === nested.id && reopened.data.terminatedAtMs !== undefined, "reopening a terminated member cleared the termination");
    const history = await opened.client.call({ type: "session.get", payload: { sessionId: sid } });
    t.assertions.assert(history?.type === "snapshot" && history.data.summary.status !== "waiting" && history.data.summary.status !== "running", "the member session still waited when it was removed");
    const send = await refused(() => opened.client.call({ type: "session.send", payload: { sessionId: sid, text: "重新打开后继续", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } }));
    t.assertions.assert(send.includes(TERMINATED), `a reopened terminated member accepted work: ${send}`);
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

defineSpecialty({
  id: "specialty.page-experience.workspace-terminate",
  title: "The project list terminates a waiting project and then removes it after confirming",
  oracle: "In a real browser, 终止 next to 移除 asks for confirmation, stops the waiting session and marks the project 已终止; 移除 on a still-busy project then explains it will terminate first and completes instead of being refused",
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
    await terminate.getByText("团队也无法自行恢复", { exact: false }).waitFor();
    await terminate.getByRole("button", { name: "确认终止 1 项", exact: true }).click();
    await projects.getByText("1 项已终止", { exact: true }).waitFor({ timeout: 15_000 });
    await project.getByText("已终止", { exact: true }).waitFor({ timeout: 5_000 });
    t.assertions.assert(!["waiting", "running"].includes((await status(opened.client, stoppedSid)) ?? ""), "the browser termination left the session waiting");
    t.assertions.assert((await terminatedIds(opened.client)).includes(stopped), "the daemon did not record the termination");

    const busyProject = projects.getByRole("region", { name: "项目 busy-target", exact: true });
    await busyProject.getByRole("checkbox", { name: "选择项目 busy-target", exact: true }).check();
    await projects.getByRole("button", { name: "移除", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "移除所选项目", exact: true });
    await remove.getByText("会先被平台终止", { exact: false }).waitFor();
    await remove.getByRole("button", { name: "确认移除 1 项", exact: true }).click();
    await busyProject.waitFor({ state: "detached", timeout: 15_000 });
    await projects.getByText("1 项已移除", { exact: true }).waitFor({ timeout: 5_000 });
    const listed = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(listed?.type === "workspaces" && !listed.data.some(w => w.id === busy), "the busy project is still registered");
    const reopened = await opened.client.call({ type: "workspace.open", payload: { root: busyRoot } });
    t.assertions.assert(reopened?.type === "workspace" && reopened.data.id === busy && reopened.data.terminatedAtMs !== undefined, "the removal did not terminate the busy project first");
    t.assertions.assert(!["waiting", "running"].includes((await status(opened.client, busySid)) ?? ""), "the removed project's session still waited");
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

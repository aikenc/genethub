import { spawnSync } from "node:child_process";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.pm-task-control",
  title: "An idle PM remains available beside its active task and pending Human card",
  oracle: "The real Workbench renders active Run facts, accepts PM input beside a Human card and during PM execution, and the task button cancels the Worker directly",
  catches: ["PM idle hides task progress", "input is disabled by a Human request", "PM interruption reaches a Worker", "task cancellation requires an LLM reply", "refresh loses the pending card or task state"],
  tags: ["page-experience", "workflow-control"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 60_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent"], productInterfaces: ["@genehub/workbench", "session.send", "workflow.cancel"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    const exec = (command: string, args: string[]) => {
      const result = spawnSync(command, args, { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    exec(opened.daemon.genet, ["workflow", "init", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash"]);
    exec("git", ["add", "."]);
    exec("git", ["commit", "-m", "browser workflow fixture"]);
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    let pmCalls = 0, workerCalls = 0, asked = false, consulted = false;
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("你是当前项目直达流程中的实现 Worker")) {
        workerCalls++;
        return { tool: { name: "request_user_input", arguments: { questions: [{ id: "worker-scope", header: "范围", question: "确认 Worker 验收范围", options: [{ label: "启动", description: "检查启动" }, { label: "全部", description: "检查全部关卡" }] }] } } };
      }
      if (pmCalls++ === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task browser-task --message "等待进一步实现要求" --no-wait' } } };
      if (body.includes("BROWSER_ASK_COLOR") && !asked) {
        asked = true;
        return { tool: { name: "request_user_input", arguments: { questions: [{ id: "color", header: "颜色", question: "选择一个颜色", options: [{ label: "蓝色", description: "使用蓝色" }, { label: "绿色", description: "使用绿色" }] }] } } };
      }
      if (body.includes("BROWSER_CONSULT") && !consulted) { consulted = true; return { hang: true as const }; }
      return { text: "BROWSER_PM_ANSWER：已核对当前任务，原问题保持待回答。" };
    };
    opened.mock.script(...Array.from({ length: 30 }, () => ({ respond })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const snapshot = async () => {
      const result = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (result?.type !== "snapshot") throw new Error("missing PM snapshot");
      return result.data;
    };
    await opened.client.call({ type: "session.send", payload: { sessionId: pm, messageId: "u_browser_start", text: "执行 browser-task，随后等待我的问题。", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } });
    await t.tools.waitUntil(async () => workerCalls === 1 && (await snapshot()).summary.status === "idle", 35_000);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, pm);
    const page = browser.page;
    const task = page.getByRole("region", { name: "任务进度" });
    await task.getByText("任务进行中 · PM 待命", { exact: true }).waitFor();
    await task.getByText("工作节点正在等待用户处理。", { exact: true }).waitFor();
    await task.getByRole("button", { name: /查看 .* 待处理问题/ }).waitFor();
    const input = page.getByRole("textbox", { name: "任务描述" });
    const send = async (text: string) => { await input.fill(text); await page.getByRole("button", { name: "发送", exact: true }).click(); };
    await send("BROWSER_ASK_COLOR：先问我选什么颜色。");
    await page.getByRole("group", { name: "选择一个颜色", exact: true }).waitFor();
    const requestId = (await snapshot()).pendingPermissions?.[0]?.id;
    await send("BROWSER_CONSULT：先解释两个颜色的区别，保留原问题。");
    await page.getByRole("button", { name: "停止 PM 本轮", exact: true }).waitFor();
    t.assertions.assert(await input.isEnabled(), "active PM turn disabled the shared composer");
    t.assertions.assert((await snapshot()).pendingPermissions?.[0]?.id === requestId, "consultation replaced the Human card");
    await page.setViewportSize({ width: 390, height: 844 });
    await send("BROWSER_STEER：现在先回答我的这条补充。");
    await t.tools.waitUntil(async () => (await snapshot()).summary.status === "waiting", 30_000);
    await page.reload();
    await page.getByRole("group", { name: "选择一个颜色", exact: true }).waitFor();
    await input.waitFor();
    t.assertions.assert(await input.isEnabled() && workerCalls === 1, "refresh lost input availability or PM input restarted its Worker");
    const beforeCancelCalls = pmCalls;
    await task.getByRole("button", { name: "终止任务", exact: true }).click();
    await t.tools.waitUntil(async () => (await snapshot()).summary.workSummary?.tasks[0]?.status === "cancelled", 35_000);
    await task.getByText("browser-task · 已取消", { exact: true }).waitFor();
    t.assertions.assert(workerCalls === 1, "task cancellation relaunched the Worker");
    t.assertions.assert((await snapshot()).pendingPermissions?.[0]?.id === requestId, "task cancellation implicitly answered PM's Human question");
    t.note(`PM calls before direct cancel=${beforeCancelCalls}; worker calls=${workerCalls}; original Human card preserved across reload`);
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

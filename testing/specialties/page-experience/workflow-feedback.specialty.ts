import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage, runGenetAsync } from "../../framework/public.ts";

for (const width of [390, 1280]) defineSpecialty({
  id: `specialty.page-experience.workflow-feedback.${width}`,
  title: `Legacy workflow edges and managed Worker navigation at ${width}px`,
  oracle: "A real completed legacy Run displays its saved edge and evidence; opening its managed Worker never renders the Executor-only flow panel",
  catches: ["legacy DAG has no structure view", "Worker with an Executor component requests a nonexistent flow", "viewing history restarts a task", "narrow workflow view overflows"],
  tags: ["page-experience", "workflow-feedback"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 30_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent", "genet-cli"],
  productInterfaces: ["@genehub/workbench", "workflow.get", "session.flow", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    const cli = async (args: string[], cwd = opened.workspaceRoot) => {
      const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd });
      t.assertions.assert(result.code === 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
    };
    const createSpace = async (parentId: string, parentRoot: string, name: string, includeProject = false) => {
      const root = path.join(parentRoot, "spaces", name);
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "pipespace.json"), JSON.stringify({ schema: "pipespace.v1", name, agents: ["codex"], skills: [], tags: [], skillProviders: [] }));
      const workspaceFile = path.join(root, `${name}.code-workspace`);
      writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: "." }, ...(includeProject ? [{ name: "project", path: "../.." }] : [])] }));
      await cli(["space", "builder", "build", "--workspace", parentId, "--name", name]);
      const reply = await opened.client.call({ type: "workspace.open", payload: { root: workspaceFile } });
      if (reply?.type !== "workspace") throw new Error(`Could not open ${name}`);
      return { id: reply.data.id, root };
    };
    const project = await createSpace(opened.workspaceId, opened.workspaceRoot, "project");
    t.data.git.init(project.root);
    // A manually configured legacy project has no PM takeover. Register its
    // tree through the public lifecycle action, then attach a real executor.
    await cli(["space", "lifecycle", "set", "--workspace", project.id, "--lifecycle", "persistent"]);
    const executor = await createSpace(project.id, project.root, "executor", true);
    await cli(["space", "parent", "set", "--workspace", executor.id, "--parent", project.id]);
    await cli(["space", "component", "set", "--workspace", executor.id, "--component", "executor"]);
    const workerSpace = await createSpace(project.id, project.root, "specialist", true);
    await cli(["space", "parent", "set", "--workspace", workerSpace.id, "--parent", executor.id]);
    await cli(["space", "component", "set", "--workspace", workerSpace.id, "--component", "worker", "--role", "worker"]);
    await cli(["space", "component", "set", "--workspace", workerSpace.id, "--component", "executor"]);
    const root = t.flows.main.seedDirectChangePackage({ projectRoot: project.root });
    writeFileSync(path.join(root, "prompts/direct-worker.md"), "LEGACY_FEEDBACK_WORKER: submit evidence for your assigned node.");
    writeFileSync(path.join(root, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "direct-change", version: 1, entry: "specialist",
      nodes: [
        { id: "specialist", uses: "agent.session", with: { role: "worker" }, completion: { all: [{ key: "report", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    }));
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    let dispatched = false, completed = false, workerCalls = 0;
    opened.mock.script(...Array.from({ length: 16 }, () => ({ respond: (request: unknown) => {
      if (JSON.stringify(request).includes("LEGACY_FEEDBACK_WORKER")) {
        workerCalls++;
        if (!completed) { completed = true; return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence report=legacy-evidence' } } }; }
        return { text: "节点已汇报。" };
      }
      if (!dispatched) { dispatched = true; return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow activate --workspace ${project.id} --revision 1 && "$GENEHUB_CLI" workflow dispatch --workspace ${project.id} --workflow direct-change --task legacy-view --message "核对旧流程展示" --no-wait` } } }; }
      return { text: "流程结果已核对。" };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, project.id);
    await t.flows.main.sendPrompt(opened.client, pm, "执行 legacy-view。");
    let runId = "";
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: project.id, limit: 10 } });
      if (reply?.type !== "workflowRuns" || reply.data[0]?.status !== "completed") return false;
      runId = reply.data[0].id;
      return true;
    }, 45_000).catch(async error => {
      const history = await opened.client.call({ type: "workflow.history", payload: { workspaceId: project.id, limit: 10 } });
      const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      const last = opened.mock.requests.at(-1) as { messages?: Array<{ role: string; content: unknown }> } | undefined;
      const toolResults = last?.messages?.filter(message => message.role === "tool").map(message => message.content);
      throw new Error(`${error}; history=${JSON.stringify(history)}; origin=${JSON.stringify(snapshot).slice(-8_000)}; tool results=${JSON.stringify(toolResults ?? []).slice(-8_000)}`);
    });
    const saved = await opened.client.call({ type: "workflow.get", payload: { workspaceId: project.id, runId } });
    t.assertions.assert(saved?.type === "workflowRun", "missing completed Run");
    if (saved?.type !== "workflowRun") return;
    const workerId = saved.data.nodes.find(node => node.id === "specialist")?.sessionId;
    t.assertions.assert(!!workerId, "Run has no Worker");
    const worker = await opened.client.call({ type: "session.get", payload: { sessionId: workerId! } });
    t.assertions.assert(!!saved.data.executorSessionId && worker?.type === "snapshot" && !!worker.data.summary.managed && worker.data.summary.workspaceId === workerSpace.id, "fixture is not an Executor-managed Worker with its own Executor component");
    const beforeCalls = workerCalls;
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), project.id, pm, { viewport: { width, height: 844 } });
    const page = browser.page;
    await page.getByRole("button", { name: /小队任务/ }).click();
    const dialog = page.getByRole("dialog", { name: "小队任务", exact: true });
    await dialog.getByText("查看流程结构", { exact: true }).click();
    await dialog.getByRole("region", { name: "结构化流程" }).getByText("已完成 → publish", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "查看执行记录", exact: true }).click();
    const flow = page.getByRole("region", { name: "Executor 执行信息流" });
    const structure = flow.getByRole("region", { name: "结构化流程" });
    await structure.getByText("入口：specialist", { exact: true }).waitFor();
    await structure.getByText("本次证据", { exact: true }).click();
    await structure.getByText("legacy-evidence", { exact: true }).waitFor();
    const box = await structure.boundingBox();
    t.assertions.assert(!!box && box.x >= 0 && box.x + box.width <= width + 1, "DAG view overflows");
    await structure.getByRole("button", { name: "查看本次工作会话" }).click();
    await page.getByRole("button", { name: "返回", exact: true }).waitFor();
    t.assertions.assert(await flow.count() === 0, "managed Worker was mistaken for an Executor Session");
    t.assertions.assert(workerCalls === beforeCalls, "history navigation restarted a Worker");
    t.note(`Legacy saved edge, evidence and managed Worker navigation verified at ${width}px`);
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

defineSpecialty({
  id: "specialty.page-experience.input-retry-feedback",
  title: "A restored input receipt can resend a missing message without duplicating accepted work",
  oracle: "Browser retry against a real daemon resolves notFound using the original ID, clears an accepted receipt on reload, and preserves missing-attachment receipts",
  catches: ["404 blocks retry forever", "retry changes the input ID", "accepted message executes twice", "missing attachments are silently dropped"],
  tags: ["page-experience", "workflow-feedback"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 20_000, timeoutMs: 100_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent"], productInterfaces: ["@genehub/workbench", "session.narrative", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    let calls = 0;
    opened.mock.script(...Array.from({ length: 6 }, () => ({ respond: () => { calls++; return { text: "RETRY_FEEDBACK_DELIVERED" }; } })));
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, session, { viewport: { width: 390, height: 844 } });
    const page = browser.page;
    await page.getByRole("textbox", { name: "任务描述" }).waitFor();
    const machine = daemonEndpoint(opened.daemon).localServerProof.machineId;
    // A persisted receipt is the disk fact left when a browser loses acceptance.
    // No product store, client or daemon is mocked; reload exercises restoration.
    const restore = async (messageId: string, missingAttachments = 0) => {
      await page.evaluate(({ machine, session, messageId, missingAttachments }) => {
        localStorage.setItem(`genehub.conversation.v1:input:${machine}:${session}:${messageId}`, JSON.stringify({ messageId, text: `RETRY_FEEDBACK ${messageId}`, sentAtMs: Date.now(), missingAttachments }));
      }, { machine, session, messageId, missingAttachments });
      await page.reload();
      await page.getByRole("textbox", { name: "任务描述" }).waitFor();
    };
    await restore("u_feedback_missing");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    // The reply can also become a sidebar title; require its message body.
    const delivered = page.getByTestId("markdown").getByText("RETRY_FEEDBACK_DELIVERED", { exact: true });
    await delivered.waitFor();
    const narrative = await opened.client.call({ type: "session.narrative", payload: { sessionId: session, itemId: "u_feedback_missing", throughRoundId: null, cursor: null, limit: null } });
    t.assertions.assert(narrative?.type === "sessionNarrative" && narrative.data.items.filter(item => item.id === "u_feedback_missing").length === 1, "retry did not retain the original ID");
    t.assertions.assert(calls === 1, "retry executed more than once");
    await restore("u_feedback_missing");
    await delivered.waitFor();
    t.assertions.assert(await page.getByRole("button", { name: "重试", exact: true }).count() === 0 && calls === 1, "accepted receipt re-executed or stayed pending");
    await restore("u_feedback_attachment", 1);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText(/本地附件已失效/).waitFor();
    t.assertions.assert(calls === 1, "retry silently discarded an attachment");
    t.note("Real browser: missing input retried once with original ID, accepted input reconciled, missing attachment kept pending");
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkspaceInfo } from "@genehub/proto";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage, runGenetAsync } from "../../framework/public.ts";

for (const width of [390, 1280]) defineSpecialty({
  id: `specialty.page-experience.conversation-groups.${width}`,
  title: `Flat conversations and explicit project observation at ${width}px`,
  oracle: "A real browser lists ordinary and nested Space conversations flat, preserves an explicit project group across rename/reload, opens child history and actionable archived work, and opens a team-delivered page through Asset Preview",
  catches: ["role names silently change layout", "child conversations or archived failures disappear", "grouping loses entry conversations or nested ownership", "phone controls require hover", "progress depends on platform-hardcoded paths"],
  tags: ["page-experience", "conversation-groups"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 45_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent", "asset-preview"],
  productInterfaces: ["@genehub/workbench", "workspace.list", "workspace.rename", "agentSpace.configure", "session.create", "session.send", "session.archive", "asset.preview", "genet space builder"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "观察项目" } });
    const project = { id: opened.workspaceId };
    const root = opened.workspaceRoot;
    writeFileSync(path.join(root, "pipespace.json"), JSON.stringify({ schema: "pipespace.v1", name: "observation-project", agents: ["codex"], skills: [], skillProviders: [], tags: [] }));
    writeFileSync(path.join(root, "observation-project.code-workspace"), JSON.stringify({ folders: [{ path: "." }] }));
    const rootBuild = await runGenetAsync(opened.daemon.genet, ["space", "builder", "build", "--workspace", project.id, "--target-workspace", project.id, "--name", "observation-project", "--require-no-post-commands"], opened.daemon.env, { cwd: root });
    t.assertions.assert(rootBuild.code === 0, rootBuild.stderr || rootBuild.stdout);
    const registered = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: project.id,
      expectedRevision: 0, operation: { kind: "setLifecycle", lifecycle: "persistent" } } });
    t.assertions.assert(registered?.type === "workspace", "root registration failed");
    // Supply Space sources through the real public Builder and composition APIs.
    const createSpace = async (name: string, parentWorkspaceId: string): Promise<WorkspaceInfo> => {
      const dir = path.join(root, "spaces", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "pipespace.json"), JSON.stringify({ schema: "pipespace.v1", name, agents: ["codex"], skills: [], skillProviders: [], tags: [] }));
      const entry = path.join(dir, `${name}.code-workspace`);
      writeFileSync(entry, JSON.stringify({ folders: [{ path: "." }] }));
      const built = await runGenetAsync(opened.daemon.genet, ["space", "builder", "build", "--workspace", project.id, "--name", name, "--require-no-post-commands"], opened.daemon.env, { cwd: root });
      t.assertions.assert(built.code === 0, built.stderr || built.stdout);
      const reply = await opened.client.call({ type: "workspace.open", payload: { root: entry } });
      if (reply?.type !== "workspace") throw new Error(`Could not open ${name}`);
      const attached = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: reply.data.id,
        expectedRevision: reply.data.agentSpace?.revision ?? 0, operation: { kind: "setParent", parentWorkspaceId } } });
      if (attached?.type !== "workspace" || attached.data.agentSpace?.parentWorkspaceId !== parentWorkspaceId) throw new Error(`Could not attach ${name}`);
      return attached.data;
    };
    const qa = await createSpace("qa", project.id);
    const work = await createSpace("work", qa.id);
    const plainRoot = path.join(t.env.root, "ordinary-project"); mkdirSync(plainRoot);
    const plainReply = await opened.client.call({ type: "workspace.open", payload: { root: plainRoot } });
    if (plainReply?.type !== "workspace") throw new Error("Could not open ordinary project");
    mkdirSync(path.join(root, "deliverables"), { recursive: true });
    writeFileSync(path.join(root, "deliverables", "progress.html"), '<!doctype html><meta charset="utf-8"><h1>TEAM_PROGRESS_FROM_MESSAGE</h1>');
    const create = async (workspaceId: string, title: string) => {
      const id = await t.flows.main.createBuiltinSession(opened.client, workspaceId);
      await opened.client.call({ type: "session.rename", payload: { sessionId: id, title } });
      return id;
    };
    const snapshot = async (sessionId: string): Promise<SessionSnapshot> => {
      const r = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (r?.type !== "snapshot") throw new Error("snapshot missing");
      return r.data;
    };
    const front = await create(project.id, "入口沟通一");
    await create(project.id, "入口沟通二");
    await create(qa.id, "验证会话一");
    await create(qa.id, "验证会话二");
    const nested = await create(work.id, "深层工作会话");
    const history = await create(work.id, "已完成历史");
    await opened.client.call({ type: "session.archive", payload: { sessionId: history, archived: true } });
    const pending = await create(qa.id, "归档问题会话");
    opened.mock.script({ tool: { name: "request_user_input", arguments: { questions: [{ id: "review", header: "验收", question: "请选择验收范围", options: [{ label: "桌面", description: "桌面验收" }, { label: "手机", description: "手机验收" }] }] } } });
    await t.flows.main.sendPrompt(opened.client, pending, "请确认验收范围");
    await t.tools.waitUntil(async () => (await snapshot(pending)).summary.interactionSummary?.count === 1, 30_000);
    await opened.client.call({ type: "session.archive", payload: { sessionId: pending, archived: true } });
    const failed = await create(work.id, "归档失败会话");
    opened.mock.script({ status: 400 });
    await t.flows.main.sendPrompt(opened.client, failed, "执行失败场景");
    await t.tools.waitUntil(async () => (await snapshot(failed)).summary.status === "failed", 30_000);
    await opened.client.call({ type: "session.archive", payload: { sessionId: failed, archived: true } });
    const plain = await create(plainReply.data.id, "另一项目普通会话");
    opened.mock.script({ text: "[团队进展](deliverables/progress.html)" });
    await t.flows.main.sendPrompt(opened.client, front, "请交付进展页面");
    await t.tools.waitUntil(async () => (await snapshot(front)).summary.status === "idle" && !!(await snapshot(front)).summary.latestReply, 30_000);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, plain, {
      viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768,
    });
    const page = browser.page;
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    const showList = async () => {
      if (width < 768) await page.getByRole("button", { name: "会话列表", exact: true }).click();
      await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
      await list.waitFor();
    };
    const row = (title: string) => list.locator(".conversation-row").filter({ hasText: title });
    await page.getByRole("button", { name: "当前项目", exact: true }).waitFor();
    await showList();
    for (const title of ["入口沟通一", "入口沟通二", "验证会话一", "验证会话二", "深层工作会话", "归档问题会话", "归档失败会话", "另一项目普通会话"]) await row(title).waitFor();
    t.assertions.assert(await list.locator(".project-session-group").count() === 0, "role-like Space names created implicit groups");
    t.assertions.assert(await row("已完成历史").count() === 0, "completed history leaked into current sessions");
    await row("深层工作会话").getByText("观察项目 / qa / work").waitFor();
    await list.getByRole("button", { name: "待你处理", exact: true }).click();
    await row("归档问题会话").waitFor();
    t.assertions.assert(await row("归档失败会话").count() === 0, "a provider failure was presented as a Human request");
    await list.getByRole("button", { name: "异常／受阻", exact: true }).click();
    await row("归档失败会话").waitFor();
    t.assertions.assert(await row("归档问题会话").count() === 0, "a Human question was presented as failure");
    await list.getByRole("button", { name: "全部", exact: true }).click();
    await list.getByRole("button", { name: "会话筛选", exact: true }).click();
    const scope = page.getByRole("dialog", { name: "筛选会话", exact: true });
    await scope.getByRole("combobox", { name: "会话范围", exact: true }).selectOption("primary");
    await scope.getByRole("button", { name: "查看结果", exact: true }).click();
    await row("归档问题会话").waitFor(); await row("归档失败会话").waitFor();
    t.assertions.assert(await row("深层工作会话").count() === 0, "explicit primary scope did not filter idle internal work");
    await list.getByRole("button", { name: "会话筛选", exact: true }).click();
    await scope.getByRole("button", { name: "清除筛选", exact: true }).click();
    await scope.getByRole("button", { name: "查看结果", exact: true }).click();
    // Grouping is opt-in, and entry sessions remain directly reachable.
    await list.getByRole("button", { name: "会话分组", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "会话分组", exact: true });
    await dialog.getByRole("checkbox", { name: "按项目分组 观察项目", exact: true }).check();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    const group = list.getByLabel("项目分组 观察项目", { exact: true });
    await group.waitFor();
    await row("入口沟通一").waitFor(); await row("入口沟通二").waitFor();
    t.assertions.assert(await row("验证会话一").count() === 0, "child collapse had no effect");
    const children = group.getByRole("button", { name: "子 Space 会话 观察项目", exact: true });
    await children.getByText("1 等待", { exact: true }).waitFor();
    await children.getByText("1 失败", { exact: true }).waitFor();
    await children.click();
    await row("验证会话一").waitFor(); await row("验证会话二").waitFor();
    await group.getByRole("combobox").selectOption(qa.id);
    await row("验证会话二").waitFor();
    t.assertions.assert(await row("深层工作会话").count() === 0, "Space filter mixed sibling/deeper conversations");
    await group.getByRole("combobox").selectOption("");
    await row("深层工作会话").getByRole("button").first().click();
    await page.getByRole("heading", { name: "深层工作会话", exact: true }).waitFor();
    await page.getByRole("button", { name: "当前项目", exact: true }).getByText("观察项目 / qa / work").waitFor();
    // Persisted structural membership must not depend on role names.
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: project.id, name: "改名项目" } });
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: qa.id, name: "验证空间" } });
    await page.reload();
    await page.getByRole("heading", { name: "深层工作会话", exact: true }).waitFor();
    await showList();
    const renamedGroup = list.getByLabel("项目分组 改名项目", { exact: true });
    await renamedGroup.waitFor();
    await row("另一项目普通会话").waitFor();
    await renamedGroup.getByRole("button", { name: "子 Space 会话 改名项目", exact: true }).click();
    await row("深层工作会话").getByText("改名项目 / 验证空间 / work").waitFor();
    await row("归档问题会话").getByRole("button").first().click();
    await page.getByRole("group", { name: "请选择验收范围", exact: true }).waitFor();
    t.assertions.assert((await snapshot(pending)).summary.interactionSummary?.count === 1, "opening a question consumed it");
    await showList();
    await row("归档失败会话").getByRole("button").first().click();
    await page.getByRole("heading", { name: "归档失败会话", exact: true }).waitFor();
    await showList();
    await list.getByRole("button", { name: "会话列表选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "已归档列表", exact: true }).click();
    await row("已完成历史").waitFor();
    await row("已完成历史").getByRole("button").first().click();
    await page.getByRole("heading", { name: "已完成历史", exact: true }).waitFor();
    await showList();
    await list.getByRole("button", { name: "返回当前会话", exact: true }).click();
    await list.getByRole("button", { name: "会话分组", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "按项目分组 改名项目", exact: true }).uncheck();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await row("深层工作会话").waitFor();
    t.assertions.assert(await list.locator(".project-session-group").count() === 0, "grouping could not return to flat rows");
    await row("入口沟通一").getByRole("button").first().click();
    t.assertions.assert(await page.getByRole("button", { name: /团队看板|试玩入口|打开.*团队看板/ }).count() === 0, "business page shortcuts remained in platform chrome");
    await page.getByRole("link", { name: "团队进展", exact: true }).first().click();
    await page.frameLocator('iframe[title="HTML 文件预览"]').getByRole("heading", { name: "TEAM_PROGRESS_FROM_MESSAGE", exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    t.assertions.assert(!overflow, "conversation UI overflows the viewport");
    t.note(`${width}px: real parent relationships, opt-in persistence, all entry/child sessions, archived work/history and message-delivered Asset Preview verified; nested session ${nested}`);
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

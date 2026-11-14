import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkspaceInfo } from "@genehub/proto";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

for (const width of [390, 1280]) defineSpecialty({
  id: `specialty.page-experience.conversation-groups.${width}`,
  title: `Flat conversations and source-owned project members at ${width}px`,
  oracle: "A real browser keeps all root conversations flat, lists nested Spaces as project members independently of retired grouping preferences, preserves actual ownership across reload, opens child history and actionable archived work through their Space pages, and opens a delivered page through Asset Preview",
  catches: ["actual project members disappear", "role names silently change layout", "child conversations or archived failures disappear", "flat lists lose entry conversations or member navigation loses nested ownership", "phone controls require hover", "progress depends on platform-hardcoded paths"],
  tags: ["page-experience", "conversation-groups"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 45_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent", "asset-preview"],
  productInterfaces: ["@genehub/workbench", "workspace.list", "workspace.rename", "agentSpace.configure", "session.create", "session.send", "session.archive", "asset.preview"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "观察项目" } });
    const project = { id: opened.workspaceId };
    const root = opened.workspaceRoot;
    writeFileSync(path.join(root, "agent-space.genet.json"), JSON.stringify({ name: "observation-project", tags: [], folders: [{ path: "." }] }));
    const registered = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: project.id,
      expectedRevision: 0, operation: { kind: "setLifecycle", lifecycle: "persistent" } } });
    t.assertions.assert(registered?.type === "workspace", "root registration failed");
    // Supply Space sources through the real public Builder and composition APIs.
    const createSpace = async (name: string, parentWorkspaceId: string): Promise<WorkspaceInfo> => {
      const dir = path.join(root, "spaces", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "agent-space.genet.json"), JSON.stringify({ name, tags: [], folders: [{ path: "." }] }));
      const reply = await opened.client.call({ type: "workspace.open", payload: { root: dir } });
      if (reply?.type !== "workspace") throw new Error(`Could not open ${name}`);
      const attached = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: reply.data.id,
        expectedRevision: reply.data.agentSpace?.revision ?? 0, operation: { kind: "setParent", parentWorkspaceId } } });
      if (attached?.type !== "workspace" || attached.data.agentSpace?.parentWorkspaceId !== parentWorkspaceId) throw new Error(`Could not attach ${name}`);
      return attached.data;
    };
    const qa = await createSpace("verification", project.id);
    const work = await createSpace("delivery", qa.id);
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
    if (width === 390) {
      await page.getByRole("button", { name: "当前项目", exact: true }).waitFor();
      // Exercise the deployed old browser preference through its real persistence boundary.
      await page.evaluate(machine => localStorage.setItem(`genehub.conversation.v1:conversation-groups:${machine}`, "[]"), daemonEndpoint(opened.daemon).localServerProof.machineId);
      await page.reload();
    }
    await page.getByRole("button", { name: "当前项目", exact: true }).waitFor();
    await showList();
    await row("入口沟通一").waitFor(); await row("入口沟通二").waitFor();
    await row("另一项目普通会话").waitFor();
    t.assertions.assert(await list.locator(".project-session-group").count()===0,
      "root conversations reverted to project grouping");
    t.assertions.assert(await row("验证会话一").count()===0 && await row("深层工作会话").count()===0,
      "internal conversations leaked into the flat root list");
    const navigation=page.getByRole("navigation",{name:"工作台导航",exact:true});
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    const showProjects=async()=>{
      for(let depth=0;depth<4 && !await navigation.isVisible();depth++)
        await page.getByRole("button",{name:/^(会话列表|返回)$/}).first().click();
      await navigation.getByRole("button",{name:"项目",exact:true}).click(); await projects.waitFor();
    };
    const openMember=async(rootName:string,memberName:string)=>{
      await showProjects();
      const owner=projects.getByRole("region",{name:`项目 ${rootName}`,exact:true});
      const expand=owner.getByRole("button",{name:`展开成员 ${rootName}`,exact:true});
      if(await expand.count()) await expand.click();
      await owner.getByRole("list",{name:`${rootName} 成员`,exact:true})
        .getByRole("button",{name:`打开成员 ${memberName}`,exact:true}).click();
      const current=page.getByRole("region",{name:"项目页面",exact:true});
      await current.getByRole("heading",{name:memberName,exact:true}).waitFor(); return current;
    };
    await showProjects();
    const group=projects.getByRole("region",{name:"项目 观察项目",exact:true});
    await group.getByRole("img",{name:"1 待你处理",exact:true}).first().waitFor();
    await group.getByRole("img",{name:"1 运行异常",exact:true}).first().waitFor();
    t.assertions.assert(await group.getByRole("button",{name:"展开成员 观察项目",exact:true}).getAttribute("aria-expanded")==="false",
      "member rows were expanded without user action");
    const verification=await openMember("观察项目","verification");
    await verification.getByRole("button",{name:/验证会话一/}).waitFor();
    await verification.getByRole("button",{name:/验证会话二/}).waitFor();
    t.assertions.assert(await verification.getByRole("button",{name:/深层工作会话/}).count()===0,
      "selected member mixed another nested Space's history");
    await verification.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"进行中",exact:true}).click();
    await verification.getByRole("button",{name:/归档问题会话/}).waitFor();
    t.assertions.assert(await verification.getByRole("button",{name:/已完成历史|另一项目普通会话/}).count()===0,
      "current-work filter included unrelated or completed history");
    await verification.getByRole("button",{name:/归档问题会话/}).click();
    await page.getByRole("group",{name:"请选择验收范围",exact:true}).waitFor();
    t.assertions.assert((await snapshot(pending)).summary.interactionSummary?.count===1,
      "opening the archived question consumed it");
    const delivery=await openMember("观察项目","delivery");
    await delivery.getByRole("button",{name:/深层工作会话/}).waitFor();
    await delivery.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"进行中",exact:true}).click();
    await delivery.getByRole("button",{name:/归档失败会话/}).waitFor();
    await delivery.getByRole("img",{name:/运行异常/}).waitFor();
    t.assertions.assert(await delivery.getByRole("button",{name:/归档问题会话|已完成历史/}).count()===0,
      "member activity included another Space or completed history");
    await delivery.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"全部",exact:true}).click();
    await delivery.getByRole("button",{name:/深层工作会话/}).click();
    await page.getByRole("heading",{name:"深层工作会话",exact:true}).waitFor();
    await page.getByRole("button",{name:"当前项目",exact:true}).getByText("观察项目 / verification / delivery").waitFor();
    await opened.client.call({type:"workspace.rename",payload:{workspaceId:project.id,name:"改名项目"}});
    await opened.client.call({type:"workspace.rename",payload:{workspaceId:qa.id,name:"验证空间"}});
    await page.evaluate(() => window.history.replaceState(null,"",location.href));
    await page.reload();
    await page.getByRole("heading",{name:"深层工作会话",exact:true}).waitFor();
    await page.getByRole("button",{name:"当前项目",exact:true}).getByText("改名项目 / 验证空间 / delivery").waitFor();
    const renamedVerification=await openMember("改名项目","验证空间");
    await renamedVerification.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"进行中",exact:true}).click();
    await renamedVerification.getByRole("button",{name:/归档问题会话/}).click();
    await page.getByRole("group",{name:"请选择验收范围",exact:true}).waitFor();
    t.assertions.assert((await snapshot(pending)).summary.interactionSummary?.count===1,"reopened question lost its saved request");
    const renamedDelivery=await openMember("改名项目","delivery");
    await renamedDelivery.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"进行中",exact:true}).click();
    await renamedDelivery.getByRole("button",{name:/归档失败会话/}).click();
    await page.getByRole("heading",{name:"归档失败会话",exact:true}).waitFor();
    t.assertions.assert((await snapshot(failed)).summary.archived,"opening failed work silently unarchived it");
    await page.getByRole("button",{name:"当前项目",exact:true}).click();
    const historyPage=page.getByRole("region",{name:"项目页面",exact:true});
    await historyPage.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"全部",exact:true}).click();
    await historyPage.getByRole("button",{name:"项目菜单",exact:true}).click();
    await page.getByRole("menuitem",{name:"查看全部会话",exact:true}).click();
    await historyPage.getByRole("button",{name:"已归档",exact:true}).click();
    await historyPage.getByRole("button",{name:/已完成历史/}).click();
    await page.getByRole("heading",{name:"已完成历史",exact:true}).waitFor();
    for(let depth=0;depth<4 && !await navigation.isVisible();depth++)
      await page.getByRole("button",{name:/^(会话列表|返回)$/}).first().click();
    await navigation.getByRole("button",{name:"会话",exact:true}).click();
    await row("另一项目普通会话").waitFor();
    await row("入口沟通一").getByRole("button").first().click();
    t.assertions.assert(await page.getByRole("button",{name:/团队看板|试玩入口|打开.*团队看板/}).count()===0,"business page shortcuts remained in platform chrome");
    await page.getByRole("link",{name:"团队进展",exact:true}).first().click();
    await page.frameLocator('iframe[title="HTML 文件预览"]').getByRole("heading",{name:"TEAM_PROGRESS_FROM_MESSAGE",exact:true}).waitFor();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    t.assertions.assert(!overflow,"conversation UI overflows the viewport");
    t.note(`${width}px: real parent membership, retired grouping preference migration, source-owned flat root list and nested member page navigation, all entry/child sessions, archived work/history and message-delivered Asset Preview verified; nested session ${nested}`);
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

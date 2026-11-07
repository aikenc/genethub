import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceInfo } from "@genehub/proto";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

for (const width of [390,1280]) defineSpecialty({
  id: `specialty.page-experience.prototype-parity.${width}`,
  title: `Accepted prototype navigation, compact rows and actions at ${width}px`,
  oracle: "The actual browser lists ordinary conversations flat, exposes five root conversations even behind 110 newer internal conversations, opens a single Space-filtered internal list, preserves header menus and real bulk archive/recovery, pins projects and creates source-labeled drafts without writing sessions",
  catches: ["every project is collapsed", "child history displaces root previews", "missing full session actions", "status and avatars are too small", "bulk selection cannot select visible rows", "draft navigation secretly creates a session"],
  tags: ["page-experience","prototype-parity","machine-connections"], runner: "playwright", llm: {default: "mock"},
  expectedDurationMs: 60_000, timeoutMs: 240_000,
  resources: {environments: 1,cpu: 3,memoryMb: 3072,io: 1,browser: 1,pool: "browser"},
  surfaces: ["workbench-ui","daemon"], productInterfaces: ["@genehub/workbench","workspace.list","workspace.open","agentSpace.configure","session.create","session.page","session.archive","session.get"],
}, async t => {
  const o = await t.flows.main.openWorkspace({openRoot: t.openRoot,lease:t.env});
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let phase = "fixture";
  try {
    await t.flows.main.configureMockProvider(o.client,o.mock);
    await o.client.call({type:"workspace.rename",payload:{workspaceId:o.workspaceId,name:"原型团队"}});
    writeFileSync(join(o.workspaceRoot,"agent-space.genet.json"),JSON.stringify({name:"原型团队",folders:[{path:"."}]}));
    const registered = await o.client.call({type:"agentSpace.configure",payload:{workspaceId:o.workspaceId,expectedRevision:0,operation:{kind:"setLifecycle",lifecycle:"persistent"}}});
    t.assertions.assert(registered?.type === "workspace","root registration failed");
    const create = async (workspaceId:string,title:string) => {
      const id = await t.flows.main.createBuiltinSession(o.client,workspaceId);
      await o.client.call({type:"session.rename",payload:{sessionId:id,title}}); return id;
    };
    for(let i=1;i<=8;i++) await create(o.workspaceId,`前台会话${i}`);
    const spaces: WorkspaceInfo[]=[];
    for(const name of ["设计Space","验证Space"]) {
      const root=join(o.workspaceRoot,"spaces",name); mkdirSync(root,{recursive:true});
      writeFileSync(join(root,"agent-space.genet.json"),JSON.stringify({name,folders:[{path:"."}]}));
      const opened=await o.client.call({type:"workspace.open",payload:{root}});
      if(opened?.type!=="workspace") throw new Error("child open failed");
      const attached=await o.client.call({type:"agentSpace.configure",payload:{workspaceId:opened.data.id,expectedRevision:opened.data.agentSpace?.revision??0,operation:{kind:"setParent",parentWorkspaceId:o.workspaceId}}});
      if(attached?.type!=="workspace") throw new Error("child attachment failed"); spaces.push(attached.data);
    }
    for(let i=0;i<110;i++) await create(spaces[i%2]!.id,`内部会话${i}`);
    const pending=await create(spaces[1]!.id,"验证待确认");
    o.mock.script({tool:{name:"request_user_input",arguments:{questions:[{id:"review",header:"验收",question:"选择验收范围",options:[{label:"桌面",description:"桌面"},{label:"手机",description:"手机"}]}]}}});
    await t.flows.main.sendPrompt(o.client,pending,"请确认验收范围");
    await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:pending}});return r?.type==="snapshot"&&r.data.summary.interactionSummary?.count===1;},30_000);
    const ordinaryRoot=join(t.env.root,"ordinary");mkdirSync(ordinaryRoot);
    const ordinary=await o.client.call({type:"workspace.open",payload:{root:ordinaryRoot}});
    if(ordinary?.type!=="workspace") throw new Error("ordinary open failed");
    await o.client.call({type:"workspace.rename",payload:{workspaceId:ordinary.data.id,name:"普通项目"}});
    const ordinaryId=await create(ordinary.data.id,"普通会话直接可见");
    const machineId=o.client.identity!.machineId;
    browser=await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(o.daemon),ordinary.data.id,ordinaryId,
      {viewport:{width,height:844},hasTouch:width<768,isMobile:width<768},{trace:false},
      {targets:()=>[{id:machineId,deviceHandle:machineId,label:"原型验收机器",kind:"remote",online:true}],endpoint:()=>daemonEndpoint(o.daemon)});
    const page=browser.page;
    const list=page.getByRole("complementary",{name:"会话列表",exact:true});
    const showList=async()=>{if(width<768) await page.getByRole("button",{name:"会话列表",exact:true}).click();};
    const nav=page.getByRole("navigation",{name:"工作台导航",exact:true});
    await page.getByRole("heading",{name:"普通会话直接可见",exact:true}).waitFor();
    await showList();
    await list.getByRole("button",{name:"机器筛选",exact:true}).click();
    await list.getByRole("menuitemradio",{name:/全部机器.*1\/1 在线/}).waitFor();
    await page.keyboard.press("Escape");
    phase="root previews";
    const group=list.getByRole("region",{name:"项目 原型团队",exact:true});
    await group.getByRole("button",{name:/前台会话8/}).waitFor();
    t.assertions.assert(await group.getByRole("img",{name:"项目状态尚未完整读取",exact:true}).count()===0,"historical pagination displayed an unknown project warning");
    await group.getByRole("img",{name:"至少 1 待你处理",exact:true}).first().waitFor();
    t.assertions.assert(await group.locator(".conversation-row").count()===5,"front preview is not exactly five rows");
    await list.getByRole("button",{name:/普通会话直接可见/}).waitFor();
    t.assertions.assert(await list.locator(".project-session-group").count()===1,"ordinary conversations were forced into project groups");
    t.assertions.assert(await group.getByText("内部会话109",{exact:true}).count()===0,"internal conversations were expanded by default");
    const avatar=await group.getByRole("img",{name:"原型团队的头像",exact:true}).first().boundingBox();
    t.assertions.assert((avatar?.width??0)>=36,"project avatar shrank below36px");
    await group.getByRole("button",{name:"更早前台会话",exact:true}).click();
    await group.getByRole("button",{name:/前台会话1/}).waitFor();
    t.assertions.assert(await group.locator(".conversation-row").count()===8,"root history did not load");
    phase="internal Space filter";
    await group.getByRole("button",{name:/团队内部/}).click();
    const spaceFilter=group.getByRole("combobox",{name:"原型团队 Space 筛选",exact:true});
    await spaceFilter.selectOption(spaces[1]!.id);
    await group.getByRole("button",{name:/验证待确认/}).waitFor();
    t.assertions.assert((await spaceFilter.locator("option").allTextContents()).every(text=>text.startsWith("全部")||text.includes("原型验收机器")),"Space ownership omitted its machine");
    const status=group.getByRole("img",{name:/待你处理/}).last();
    const statusBox=await status.locator("svg").boundingBox();
    t.assertions.assert((statusBox?.width??0)>=16,"state icon shrank below16px");
    const spaceAvatar=await group.getByRole("button",{name:/验证待确认/}).getByRole("img",{name:"验证Space的头像"}).boundingBox();
    t.assertions.assert((spaceAvatar?.width??0)>=22,"Space avatar shrank below22px");
    phase="compact search";
    const headerHeight=await list.locator("header").boundingBox();
    await list.getByRole("button",{name:"搜索列表",exact:true}).click();
    const searchHeight=await list.locator("header").boundingBox();
    t.assertions.assert((searchHeight?.height??0)<=(headerHeight?.height??0)+1,"search added another header row");
    await list.getByRole("textbox",{name:"搜索会话",exact:true}).fill("内部会话109");
    await group.getByRole("button",{name:/内部会话109/}).waitFor();
    await list.getByRole("button",{name:"关闭搜索",exact:true}).click();
    phase="batch archive and restore";
    await list.getByRole("button",{name:"批量",exact:true}).click();
    await list.getByRole("button",{name:"全选当前可见",exact:true}).click();
    t.assertions.assert(await list.getByRole("checkbox",{checked:true}).count()>0,"select visible did not select rows");
    await list.getByRole("button",{name:"取消全选",exact:true}).click();
    await list.getByRole("checkbox",{name:"选择会话 普通会话直接可见",exact:true}).check();
    await list.getByRole("button",{name:"归档",exact:true}).click();
    await page.getByRole("dialog",{name:"归档所选会话",exact:true}).getByRole("button",{name:"确认处理 1 项",exact:true}).click();
    await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:ordinaryId}});return r?.type==="snapshot"&&r.data.summary.archived;},10_000);
    await list.getByRole("button",{name:"列表选项",exact:true}).click();
    await list.getByRole("menuitem",{name:"查看已归档",exact:true}).click();
    await list.getByRole("checkbox",{name:"选择会话 普通会话直接可见",exact:true}).check();
    await list.getByRole("button",{name:"恢复",exact:true}).click();
    await page.getByRole("dialog",{name:"恢复所选会话",exact:true}).getByRole("button",{name:"确认处理 1 项",exact:true}).click();
    await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:ordinaryId}});return r?.type==="snapshot"&&!r.data.summary.archived;},10_000);
    await list.getByRole("button",{name:"已归档会话 · 返回当前",exact:true}).click();
    await list.getByRole("button",{name:"完成",exact:true}).click();
    phase="session header actions";
    await list.getByRole("button",{name:/普通会话直接可见/}).click();
    await page.getByRole("heading",{name:"普通会话直接可见",exact:true}).waitFor();
    await page.getByRole("button",{name:"会话菜单",exact:true}).click();
    const menu=page.getByRole("menu",{name:"会话菜单",exact:true});
    for(const name of ["重命名","标签","后台进程","归档会话","删除…"]) await menu.getByRole("menuitem",{name,exact:true}).waitFor();
    t.assertions.assert(await menu.getByText(/Fork|转发/).count()===0,"message-level actions leaked into the session menu");
    await menu.getByRole("menuitem",{name:"重命名",exact:true}).click();
    await page.getByRole("textbox",{name:"会话标题",exact:true}).fill("菜单重命名已保存");
    await page.getByRole("button",{name:"保存标题",exact:true}).click();
    await page.getByRole("heading",{name:"菜单重命名已保存",exact:true}).waitFor();
    phase="project pin";
    await page.getByRole("button",{name:"当前项目",exact:true}).click();
    await page.getByRole("button",{name:"项目菜单",exact:true}).click();
    await page.getByRole("menuitem",{name:"置顶项目",exact:true}).click();
    if(width<768) await page.getByRole("button",{name:"返回",exact:true}).first().click();
    if(width<768) await showList();
    await nav.getByRole("button",{name:"项目",exact:true}).click();
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    await projects.getByRole("button",{name:"机器筛选",exact:true}).click();
    await projects.getByRole("menuitemradio",{name:/原型验收机器.*3 项目/}).waitFor();
    await page.keyboard.press("Escape");
    const pinned=projects.getByRole("button",{name:/置顶 ·/});
    await pinned.waitFor(); await pinned.click();
    t.assertions.assert(await projects.getByRole("region",{name:"项目 普通项目",exact:true}).count()===0,"collapsed pinned project remained visible");
    await pinned.click(); await projects.getByRole("region",{name:"项目 普通项目",exact:true}).waitFor();
    phase="new draft";
    await nav.getByRole("button",{name:"会话",exact:true}).click();
    await list.getByRole("button",{name:"新建会话",exact:true}).click();
    const draft=page.getByRole("region",{name:"项目页面",exact:true});
    await draft.getByRole("heading",{name:"新会话",exact:true}).waitFor();
    await draft.getByRole("button",{name:/普通项目.*原型验收机器/}).waitFor();
    t.assertions.assert(await page.getByRole("dialog").count()===0,"new conversation opened a dialog");
    const input=page.getByPlaceholder("描述任务…",{exact:true});
    await input.fill("切换项目仍保留的草稿");
    await draft.getByRole("button",{name:/原型团队.*原型验收机器/}).click();
    await t.tools.waitUntil(async()=>await input.inputValue()==="切换项目仍保留的草稿",5_000);
    const pageReply=await o.client.call({type:"session.page",payload:{requests:[{workspaceId:ordinary.data.id,limit:100,cursor:null}],includeArchived:true}});
    t.assertions.assert(pageReply?.type==="sessionPages"&&pageReply.data[0]?.sessions.length===1,"draft creation wrote a stored conversation");
    t.assertions.assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"responsive page overflowed horizontally");
    t.note(JSON.stringify({width,ordinaryFlat:true,rootPreview:5,rootHistory:8,internalHistory:111,spaceSource:true,headerMenu:true,bulkArchiveRecover:true,pinnedCollapse:true,draftWithoutWrite:true}));
  } catch(error) {
    if(browser) t.note(`Parity ${phase} failure: ${await browser.page.locator("body").innerText().then(s=>s.slice(-6000)).catch(()=>"unavailable")}`);
    throw error;
  } finally {await browser?.close();o.client.close();o.daemon.stop();await o.mock.stop();}
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceInfo } from "@genehub/proto";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

for (const width of [390,744,768,820,1280]) defineSpecialty({
  id: `specialty.page-experience.prototype-parity.${width}`,
  title: `Current flat navigation, compact rows and actions at ${width}px`,
  oracle: "The actual browser lists ordinary conversations flat, exposes five root conversations even behind 110 newer internal conversations, opens source-labelled member pages and their complete history, preserves header menus and real bulk archive/recovery, pins projects and creates source-labeled drafts without writing sessions",
  catches: ["flat root conversations become collapsed groups", "child history displaces root previews", "missing full session actions", "status and avatars are too small", "bulk selection cannot select visible rows", "draft navigation secretly creates a session", "expanding member navigation summons an editable search"],
  tags: ["page-experience","prototype-parity","machine-connections"], runner: "playwright", llm: {default: "mock"}, retention: width===744,
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
    const internalIds:string[]=[];
    for(let i=0;i<110;i++) internalIds.push(await create(spaces[i%2]!.id,`内部会话${i}`));
    const pending=await create(spaces[1]!.id,"验证待确认");
    o.mock.script({tool:{name:"request_user_input",arguments:{questions:[{id:"review",header:"验收",question:"选择验收范围",options:[{label:"桌面",description:"桌面"},{label:"手机",description:"手机"}]}]}}});
    await t.flows.main.sendPrompt(o.client,pending,"请确认验收范围");
    await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:pending}});return r?.type==="snapshot"&&r.data.summary.interactionSummary?.count===1;},30_000);
    const failed=await create(spaces[1]!.id,"执行受阻");
    o.mock.script({status:400}); await t.flows.main.sendPrompt(o.client,failed,"执行失败场景");
    await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:failed}});return r?.type==="snapshot"&&r.data.summary.status==="failed";},30_000);
    const ordinaryRoot=join(t.env.root,"ordinary");mkdirSync(ordinaryRoot);
    const ordinary=await o.client.call({type:"workspace.open",payload:{root:ordinaryRoot}});
    if(ordinary?.type!=="workspace") throw new Error("ordinary open failed");
    await o.client.call({type:"workspace.rename",payload:{workspaceId:ordinary.data.id,name:"普通项目"}});
    const ordinaryId=await create(ordinary.data.id,"普通会话直接可见");
    const machineId=o.client.identity!.machineId;
    browser=await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(o.daemon),ordinary.data.id,ordinaryId,
      {viewport:{width,height:width<1024?1133:844},hasTouch:width<1024,isMobile:width<700},{trace:false},
      {targets:()=>[{id:machineId,deviceHandle:machineId,label:"原型验收机器",kind:"remote",online:true}],endpoint:()=>daemonEndpoint(o.daemon)});
    const page=browser.page;
    const list=page.getByRole("complementary",{name:"会话列表",exact:true});
    const showList=async()=>{
      for(let depth=0;depth<4 && !await nav.isVisible();depth++) await page.getByRole("button",{name:/^(会话列表|返回)$/}).first().click();
      await nav.getByRole("button",{name:"会话",exact:true}).click(); await list.waitFor();
    };
    const nav=page.getByRole("navigation",{name:"工作台导航",exact:true});
    await page.getByRole("heading",{name:"普通会话直接可见",exact:true}).waitFor();
    await showList();
    await list.getByRole("button",{name:"机器筛选",exact:true}).click();
    await list.getByRole("menuitemradio",{name:/全部机器.*1\/1 在线/}).waitFor();
    await page.keyboard.press("Escape");
    phase="root previews";
    const roots=list.locator(".conversation-row").filter({hasText:/前台会话/});
    await list.getByRole("button",{name:/前台会话8/}).waitFor();
    const headerRows=await list.locator("header").evaluate(e=>({
      top:[...e.children[0]!.querySelectorAll("button")].map(b=>b.getAttribute("aria-label")??b.textContent),
      filters:[...e.children[1]!.querySelectorAll("button")].map(b=>b.getAttribute("aria-label")??b.textContent),
    }));
    t.assertions.assert(!headerRows.top.includes("批量")&&!headerRows.top.includes("列表选项")&&headerRows.filters.includes("批量")&&headerRows.filters.includes("列表选项"),"list actions remained on the crowded machine row");
    t.assertions.assert(!headerRows.filters.includes("待你处理")&&!headerRows.filters.includes("受阻")&&!headerRows.filters.includes("状态图标说明"),"retired filter/help controls remain");
    const font=await list.locator(".gh-conversation-title").first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize));
    const machineFont=await list.getByRole("button",{name:"机器筛选",exact:true}).evaluate(e=>parseFloat(getComputedStyle(e).fontSize));
    t.assertions.assert(font<=(width<700?15.5:13.5)&&machineFont<=(width<700?15.5:13.5),"list typography did not become slightly smaller");
    if(width>=700&&width<1024){
      const navBox=await nav.boundingBox(),listBox=await list.boundingBox(),mainBox=await page.getByRole("main").boundingBox();
      t.assertions.assert(Boolean(navBox&&navBox.width<=56&&listBox&&listBox.width>=256&&listBox.width<=280&&mainBox&&mainBox.width>=400),"tablet split layout did not reclaim content width");
      const hits=await nav.getByRole("button").evaluateAll(buttons=>buttons.map(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height})));
      t.assertions.assert(hits.every(b=>b.w>=44&&b.h>=44&&b.h<=48),"tablet navigation lost compact44px touch targets");
      if(width===744){
        // Retain one bounded acceptance image for the requested iPad UX review.
        const screenshot=join(process.env.TESTCTL_BROWSER_ARTIFACTS!,"ipad-mini-744.png");
        await page.screenshot({path:screenshot});
        t.note(JSON.stringify({tabletScreenshot:screenshot,nav:navBox,list:listBox,main:mainBox,font,machineFont}));
      }
    }
    t.assertions.assert(await roots.count()===5 && await list.locator(".project-session-group").count()===0,
      "root previews were displaced by internal history or grouped instead of flat");
    t.assertions.assert(await list.getByText("内部会话109",{exact:true}).count()===0,"internal history leaked into the root list");
    const rowAvatar=await roots.first().getByRole("img",{name:"原型团队的头像",exact:true}).boundingBox();
    t.assertions.assert((rowAvatar?.width??0)>=22,"conversation source avatar shrank below22px");
    await list.getByRole("button",{name:"进行中",exact:true}).click();
    t.assertions.assert(await list.getByRole("button",{name:/普通会话直接可见|前台会话/}).count()===0,
      "current-work filter included idle roots");
    t.assertions.assert(await list.getByRole("button",{name:/验证待确认|执行受阻/}).count()===0,
      "internal current work leaked out of its member page");
    await list.getByRole("button",{name:"全部",exact:true}).click();
    await list.getByRole("button",{name:/加载 .+ 的更早会话/}).click();
    await list.getByRole("button",{name:/前台会话1/}).waitFor();
    t.assertions.assert(await roots.count()===8,"root history did not load through the current machine paging control");
    phase="compact search";
    const headerHeight=await list.locator("header").boundingBox();
    await list.getByRole("button",{name:"搜索列表",exact:true}).click();
    const searchHeight=await list.locator("header").boundingBox();
    t.assertions.assert((searchHeight?.height??0)<=(headerHeight?.height??0)+1,"search added another header row");
    await list.getByRole("textbox",{name:"搜索会话",exact:true}).fill("前台会话8");
    await list.getByRole("button",{name:/前台会话8/}).waitFor();
    t.assertions.assert(await roots.count()===1,"root search retained unrelated rows");
    await list.getByRole("button",{name:"关闭搜索",exact:true}).click();
    phase="member Space navigation";
    await nav.getByRole("button",{name:"项目",exact:true}).click();
    const projectList=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    const group=projectList.getByRole("region",{name:"项目 原型团队",exact:true});
    await group.getByRole("img",{name:"1 待你处理",exact:true}).first().waitFor();
    await group.getByRole("img",{name:"1 运行异常",exact:true}).first().waitFor();
    const avatar=await group.getByRole("img",{name:"原型团队的头像",exact:true}).boundingBox();
    t.assertions.assert((avatar?.width??0)>=36,"project avatar shrank below36px");
    await group.getByRole("button",{name:"展开成员 原型团队",exact:true}).click();
    const members=group.getByRole("list",{name:"原型团队 成员",exact:true});
    t.assertions.assert(await members.getByRole("button").count()===spaces.length,"direct member navigation lost a Space");
    const member=members.getByRole("button",{name:"打开成员 验证Space",exact:true});
    await member.waitFor();
    t.assertions.assert((await member.innerText()).includes("原型验收机器"),"member omitted its actual machine source");
    const memberBox=await member.boundingBox();
    t.assertions.assert(Boolean(memberBox&&memberBox.x>=0&&memberBox.x+memberBox.width<=width&&memberBox.height>=40),"member navigation escaped its viewport or lost its touch target");
    await member.focus();
    t.assertions.assert(await member.evaluate(e=>e===document.activeElement) && await page.locator("input:focus,textarea:focus,[contenteditable=true]:focus").count()===0,
      "opening member navigation focused an editable search");
    await member.press("Enter");
    const memberPage=page.getByRole("region",{name:"项目页面",exact:true});
    await memberPage.getByRole("heading",{name:"验证Space",exact:true}).waitFor();
    t.assertions.assert(page.url().includes(spaces[1]!.id.slice(2,10)),"member navigation opened a different Space");
    await memberPage.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"进行中",exact:true}).click();
    await memberPage.getByRole("button",{name:/验证待确认/}).waitFor();
    await memberPage.getByRole("button",{name:/执行受阻/}).waitFor();
    t.assertions.assert(await memberPage.getByRole("button",{name:/内部会话/}).count()===0,"member current-work view included idle history");
    const statusBox=await memberPage.getByRole("img",{name:/待你处理/}).last().locator("svg").boundingBox();
    t.assertions.assert((statusBox?.width??0)>=16,"state icon shrank below16px");
    const spaceAvatar=await memberPage.getByRole("button",{name:/验证待确认/}).getByRole("img",{name:"验证Space的头像",exact:true}).boundingBox();
    // The flat sidebar source uses22px; the existing Space-page metadata uses16px.
    t.assertions.assert((spaceAvatar?.width??0)>=16,"member conversation metadata avatar shrank below16px");
    phase="older member history search";
    await memberPage.getByLabel("当前项目会话状态",{exact:true}).getByRole("button",{name:"全部",exact:true}).click();
    t.assertions.assert(await memberPage.getByText("内部会话1",{exact:true}).count()===0,"old search witness was already in the bounded default history");
    await memberPage.getByRole("button",{name:"项目菜单",exact:true}).click();
    await page.getByRole("menuitem",{name:"查看全部会话",exact:true}).click();
    await memberPage.getByRole("textbox",{name:"搜索当前项目会话",exact:true}).fill("内部会话1");
    await memberPage.getByText("内部会话1",{exact:true}).click();
    await page.getByRole("heading",{name:"内部会话1",exact:true}).waitFor();
    t.assertions.assert(page.url().includes(internalIds[1]!.slice(2,10)),"history search opened another stored conversation");
    await page.getByRole("button",{name:"当前项目",exact:true}).click();
    await memberPage.getByRole("textbox",{name:"搜索当前项目会话",exact:true}).fill("");
    await memberPage.getByRole("button",{name:"项目菜单",exact:true}).click();
    await page.getByRole("menuitem",{name:"最近会话",exact:true}).click();
    t.assertions.assert(await memberPage.getByText("内部会话1",{exact:true}).count()===0,"leaving complete history inflated the ordinary preview");
    await showList();
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
    if(width<700) await page.getByRole("button",{name:"返回",exact:true}).first().click();
    if(width<700) await showList();
    await nav.getByRole("button",{name:"项目",exact:true}).click();
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    await projects.getByRole("button",{name:"机器筛选",exact:true}).click();
    await projects.getByRole("menuitemradio",{name:/原型验收机器.*3 项目/}).waitFor();
    await page.keyboard.press("Escape");
    const types=projects.getByLabel("项目类型工具栏",{exact:true});
    await types.getByRole("button",{name:"内置",exact:true}).click();
    t.assertions.assert(await projects.getByRole("region",{name:"项目 普通项目",exact:true}).count()===0&&await projects.getByRole("region",{name:"项目 原型团队",exact:true}).count()===0,"builtin filter included user projects");
    t.assertions.assert(await projects.locator("section").count()===1,"builtin filter omitted the actual builtin project");
    await types.getByRole("button",{name:"团队",exact:true}).click();
    await projects.getByRole("region",{name:"项目 原型团队",exact:true}).waitFor();
    t.assertions.assert(await projects.locator("section").count()===1,"team filter included an ordinary or builtin project");
    await types.getByRole("button",{name:"所有",exact:true}).click();
    const pinned=projects.getByRole("button",{name:/^置顶/});
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
    t.note(JSON.stringify({width,ordinaryFlat:true,rootPreview:5,rootHistory:8,internalHistory:internalIds.length+2,memberSource:true,headerMenu:true,bulkArchiveRecover:true,pinnedCollapse:true,draftWithoutWrite:true}));
  } catch(error) {
    if(browser) t.note(`Parity ${phase} failure: ${await browser.page.locator("body").innerText().then(s=>s.slice(-6000)).catch(()=>"unavailable")}`);
    throw error;
  } finally {await browser?.close();o.client.close();o.daemon.stop();await o.mock.stop();}
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty,createLease,releaseLease,daemonEndpoint,openWorkbenchPage } from "../../framework/public.ts";

for(const width of [744,1280])defineSpecialty({
  id:`specialty.page-experience.remote-squad.${width}`,
  title:`Remote members use the same machine-qualified reference in Squad and the project member list at ${width}px`,
  oracle:"The real project Squad shows a remote Space and its actual machine; opening it selects the remote project, while the source's project member list exposes the identical machine-qualified member without a search input",
  catches:["Squad silently drops remote members","machine label missing in Squad","remote member opens a same-named local project","member navigation opens a text input"],
  tags:["page-experience","machine-connections","remote-squad"],runner:"playwright",llm:{default:"none"},
  surfaces:["workbench-ui","daemon"],productInterfaces:["workspace.list","session.page","@genehub/workbench"],
  expectedDurationMs:20000,timeoutMs:90000,resources:{environments:1,cpu:3,memoryMb:3072,io:1,browser:1,pool:"browser"},
},async t=>{
  const lease=createLease("squad-remote-");
  const a=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let b:typeof a|undefined,browser:Awaited<ReturnType<typeof openWorkbenchPage>>|undefined;
  try{
    b=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease});
    await a.client.call({type:"workspace.rename",payload:{workspaceId:a.workspaceId,name:"源团队"}});
    await b.client.call({type:"workspace.rename",payload:{workspaceId:b.workspaceId,name:"远程QA"}});
    const sid=await t.flows.main.createBuiltinSession(a.client,a.workspaceId);
    await a.client.call({type:"session.rename",payload:{sessionId:sid,title:"源团队前台"}});
    writeFileSync(join(t.env.workspace,"agent-space.genet.json"),JSON.stringify({schema:"agent-space.v1",name:"源团队",description:"源团队",agents:[],skills:[],skillProviders:[],folders:[{path:"."}],members:[{machineId:b.client.identity!.machineId,workspaceId:b.workspaceId,name:"qa"}]}));
    await t.tools.waitUntil(async()=>{
      const listed=await a.client.call({type:"workspace.list"});
      return Boolean(listed?.type==="workspaces" && listed.data.find(w=>w.id===a.workspaceId)?.agentSpace?.members?.some(m=>m.machineId===b!.client.identity!.machineId && m.workspaceId===b!.workspaceId));
    },35000);
    const targets=[a,b].map((o,i)=>({id:o.client.identity!.machineId,deviceHandle:o.client.identity!.machineId,label:i?"机器乙 · Mac":"机器甲",online:true,kind:"remote" as const}));
    browser=await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(a.daemon),a.workspaceId,sid,{viewport:{width,height:1133},hasTouch:width===744},{trace:false},{targets:()=>targets,endpoint:id=>daemonEndpoint(id===targets[0]!.id?a.daemon:b!.daemon)});
    const page=browser.page;
    // App must finish its initial deep-link navigation before the first tab click.
    await page.getByRole("heading",{name:"源团队前台",exact:true}).waitFor();
    const navigation=page.getByRole("navigation",{name:"工作台导航",exact:true});
    await navigation.getByRole("button",{name:"项目",exact:true}).click();
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    const group=projects.getByRole("region",{name:"项目 源团队",exact:true});
    await group.getByRole("button",{name:"展开成员 源团队",exact:true}).click();
    const member=group.getByRole("list",{name:"源团队 成员",exact:true})
      .getByRole("button",{name:"打开成员 远程QA",exact:true});
    await member.waitFor();
    t.assertions.assert((await member.innerText()).includes("机器乙"),"member list omitted the source machine");
    await member.focus();
    t.assertions.assert(await page.locator("input:focus,textarea:focus").count()===0,"member navigation focused an editable input");
    await member.press("Enter");
    const project=page.getByRole("region",{name:"项目页面",exact:true});
    await project.getByRole("heading",{name:"远程QA",exact:true}).waitFor();
    const memberUrl=page.url();
    t.assertions.assert(memberUrl.includes(b.client.identity!.machineId.slice(2,10)) &&
      (memberUrl.includes(`/w/${b.workspaceId}`)||memberUrl.includes(`/w-${b.workspaceId.slice(2,10)}`)),
      "project member opened a different machine or workspace");
    await navigation.getByRole("button",{name:"项目",exact:true}).click();
    await group.getByRole("button",{name:"打开项目 源团队",exact:true}).click();
    await project.getByRole("heading",{name:"源团队",exact:true}).waitFor();
    await project.getByRole("button",{name:"小队",exact:true}).click();
    const remote=project.getByRole("button",{name:"远程QA",exact:true});await remote.waitFor();
    t.assertions.assert((await remote.innerText()).includes("机器乙"),"Squad omitted the remote machine label");
    await page.screenshot({path:join(process.env.TESTCTL_BROWSER_ARTIFACTS!,`squad-${width}.png`),fullPage:true});
    await remote.click();await project.getByRole("heading",{name:"远程QA",exact:true}).waitFor();
    const p=page.url();t.assertions.assert(p.includes(`/w/${b.workspaceId}`)||p.includes(`/w-${b.workspaceId.slice(2,10)}`),"Squad opened a project on the wrong machine");
    t.note(JSON.stringify({width,remoteMachine:b.client.identity!.machineId,remoteWorkspace:b.workspaceId,squadAndMembersAgree:true}));
  }finally{await browser?.close();for(const o of [a,b])if(o){o.client.close();o.daemon.stop();await o.mock.stop();}releaseLease(lease);}
});

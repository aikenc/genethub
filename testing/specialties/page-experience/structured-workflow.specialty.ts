import {writeFileSync} from "node:fs";
import path from "node:path";
import {defineSpecialty,daemonEndpoint,openWorkbenchPage,runGenetAsync} from "../../framework/public.ts";

for (const width of [390,1280]) defineSpecialty({
  id:`specialty.page-experience.structured-workflow.${width}`,
  title:`Structured loop history is navigable at ${width}px`,
  oracle:"A real two-round Run exposes its nested structure, each round's own Worker and evidence, and can return to the originating PM",
  catches:["iterations rendered as unrelated graph nodes","completed iteration loses its evidence","narrow structure view overflows","Worker navigation loses the PM origin"],
  tags:["page-experience","structured-workflow-ui"],runner:"playwright",llm:{default:"mock"},
  expectedDurationMs:35_000,timeoutMs:150_000,
  resources:{environments:1,cpu:2,memoryMb:1536,io:1,browser:1,pool:"browser"},
  surfaces:["workbench-ui","daemon","agent","genet-cli"],productInterfaces:["workflow.get","workflow.dispatch","session.send","@genehub/workbench"],
},async t=>{
  t.data.git.init(t.env.workspace);
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let browser:Awaited<ReturnType<typeof openWorkbenchPage>>|undefined;
  try {
    const init=await runGenetAsync(opened.daemon.genet,["workflow","init","--agent","genet","--model","deepseek/deepseek-v4-flash"],opened.daemon.env,{cwd:opened.workspaceRoot});
    t.assertions.assert(init.code===0,init.stderr);
    const root=path.join(opened.workspaceRoot,".genethub/workflow");
    writeFileSync(path.join(root,"prompts/direct-worker.md"),"STRUCTURE_UI_WORKER: report the assigned operation.");
    writeFileSync(path.join(root,"workflows/direct-change.yaml"),JSON.stringify({
      schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,
      nodes:[{id:"worker",uses:"agent.session",with:{role:"worker"},completion:{all:[{key:"done",verify:"value.nonEmpty"}]}}],
      structure:{body:{id:"review-cycle",type:"loop",maxRounds:2,initial:{op:"literal",value:{done:false}},condition:{op:"not",value:{op:"ref",path:"/vars/done"}},body:{id:"review",type:"task",activity:"worker",accept:["completed","changesRequested"]},update:{op:"object",fields:{done:{op:"eq",left:{op:"ref",path:"/results/evidence/done"},right:{op:"literal",value:"yes"}}}}}},
    }));
    await t.flows.main.configureMockProvider(opened.client,opened.mock);
    const seen=new Set<string>();let dispatched=false;
    opened.mock.script(...Array.from({length:30},()=>({respond:(request:unknown)=>{
      const body=JSON.stringify(request);
      if(body.includes("STRUCTURE_UI_WORKER")){
        const operation=body.match(/当前节点：(operation-\d+)/)?.[1];
        if(!operation)throw Error("missing activity identity");
        if(!seen.has(operation)){
          seen.add(operation);
          return {tool:{name:"bash",arguments:{command:`"$GENEHUB_CLI" workflow complete --evidence done=${seen.size===2 ? "yes":"no"}`}}};
        }
        return {text:"已提交本轮证据。"};
      }
      if(!dispatched){dispatched=true;return {tool:{name:"bash",arguments:{command:'"$GENEHUB_CLI" workflow activate --revision 1 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task ui-loop --message "检查两轮流程展示" --no-wait'}}};}
      return {text:"两轮检查完成。"};
    }})));
    const pm=await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client,pm,"执行检查任务。");
    await t.tools.waitUntil(async()=>{
      const reply=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
      return reply?.type==="workflowRuns" && reply.data[0]?.status==="completed";
    },45_000);
    browser=await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(opened.daemon),opened.workspaceId,pm);
    const page=browser.page;
    await page.setViewportSize({width,height:844});
    await page.getByRole("button",{name:/小队任务/}).click();
    const dialog=page.getByRole("dialog",{name:"小队任务",exact:true});
    await dialog.getByText("查看流程结构",{exact:true}).click();
    const structure=dialog.getByRole("region",{name:"结构化流程"});
    await structure.getByText("第 2 轮",{exact:true}).waitFor();
    await structure.getByText("第 1 轮",{exact:true}).click();
    const first=structure.locator("details").filter({has:page.locator("summary",{hasText:/^第 1 轮$/})}).last();
    // Both rounds have separate evidence and navigation controls.
    await first.getByText("本次证据",{exact:true}).click();
    await first.getByText("no",{exact:true}).waitFor();
    const box=await structure.boundingBox();
    t.assertions.assert(!!box && box.x>=0 && box.x+box.width<=width+1,"structure overflows viewport");
    await first.getByRole("button",{name:"查看本次工作会话"}).click();
    await page.getByRole("button",{name:"返回",exact:true}).click();
    await page.getByRole("button",{name:/小队任务/}).waitFor();
    t.assertions.assert(seen.size===2,"viewing history restarted workflow activity");
  }finally{await browser?.close();opened.client.close();await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env);await opened.mock.stop();}
});

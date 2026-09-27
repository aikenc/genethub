import { mkdirSync, writeFileSync, cpSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { defineSpecialty, openBrowser, openPreviewBrowser, daemonEndpoint } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.observability",
  title: "Pinned views and request estimates survive source and rate changes",
  oracle: "A real Worker Run reads its original view after source changes, reports actual priced calls once, excludes PM turns and preserves historical estimates after global rates change",
  catches: ["view reads latest source rather than the Run build", "model rates retroactively reprice history", "PM conversation is counted as Worker cost", "unknown historical rate silently treated as zero"],
  retention:true, tags: ["workflow", "observability", "core", "browser"], runner: "playwright", llm: {default: "mock"},
  expectedDurationMs: 30000, timeoutMs: 120000,
  resources: {environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 1},
  surfaces: ["browser", "daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.profile", "workflow.view", "settings.setAgentPreferences"],
}, async t => {
  const equal=(actual:unknown,expected:unknown,message:string)=>t.assertions.assert(actual===expected,message);
  t.data.git.init(t.env.workspace);
  writeFileSync(join(t.env.workspace, "README.md"), "observability fixture\n");
  const git = (args: string[]) => {const r=spawnSync("git",args,{cwd:t.env.workspace,encoding:"utf8"});if(r.status)throw new Error(r.stderr);return r.stdout.trim();};
  git(["add","."]);git(["commit","-m","fixture"]);const commit=git(["rev-parse","HEAD"]);
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  try {
    await t.flows.main.configureMockProvider(opened.client,opened.mock);
    const root=t.flows.main.seedDirectChangePackage({projectRoot:opened.workspaceRoot});
    mkdirSync(join(root,"views/progress"),{recursive:true});
    const original='<!doctype html><title>真实进度</title><script src="view.js"></script><p>build-original</p>';
    writeFileSync(join(root,"views/progress/index.html"),original);
    writeFileSync(join(root,"views/progress/view.js"),'window.buildVersion="original";');
    const preferences={runtimes:{},modelProfiles:[{agentId:"genet",modelId:"deepseek/deepseek-v4-flash",tags:["Flush"],cost:"veryHigh" as const}],costRates:{veryHigh:2000,high:500,medium:100,low:20,veryLow:5}};
    const saved=await opened.client.call({type:"settings.setAgentPreferences",payload:{preferences}});
    t.assertions.assert(saved?.type === "settings","cost preferences were not saved");
    // A second real view uses the shipped HTML/CSS/JS, exercising the actual
    // workbench host and existing fileAPI rather than a replacement iframe.
    cpSync(join(t.openRoot,'apps/daemon/workflow-packages/game-delivery/views/progress'),join(root,'views/quality'),{recursive:true});
    let stage=0,workerCompleted=false;
    opened.mock.script(...Array.from({length:20},()=>({respond:(request:unknown)=>{
      const body=JSON.stringify(request);
      const command=(text:string)=>({tool:{name:"bash",arguments:{command:text}}});
      if(body.includes("<genehub_managed_session>")) {
        if(workerCompleted)return {text:"Worker finished."};workerCompleted=true;
        return command(`"$GENEHUB_CLI" workflow complete --evidence commit=${commit} --evidence checks=fixture-verified`);
      }
      if(stage++===0)return command('"$GENEHUB_CLI" workflow activate --revision 0');
      if(stage===2)return command('"$GENEHUB_CLI" workflow dispatch --task observe-fixture --message "Return this verified fixture commit" --no-wait');
      return {text:"The task was delegated."};
    }})));
    const sessionId=await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client,sessionId,"Activate the fixture and delegate its one task.");
    let runId="";
    await t.tools.waitUntil(async()=>{
      const reply=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
      if(reply?.type!=="workflowRuns")return false;
      const run=reply.data.find(run=>run.taskId==='observe-fixture');runId=run?.id||"";
      return run?.status==='completed';
    },90000);
    const view=await opened.client.call({type:"workflow.view",payload:{workspaceId:opened.workspaceId,runId,path:null}});
    t.assertions.assert(view?.type==='workflowView',"view catalog unavailable");
    const catalog=(view as any).data;
    equal(catalog.views[0]?.title,"真实进度","HTML title did not generate the entry");
    writeFileSync(join(root,"views/progress/index.html"),'<title>changed</title><p>different-build</p>');
    const asset=await opened.client.call({type:"workflow.view",payload:{workspaceId:opened.workspaceId,runId,path:"views/progress/index.html"}});
    t.assertions.assert(asset?.type==='workflowView',"immutable view unavailable");
    equal(Buffer.from((asset as any).data.base64,'base64').toString(),original,"view followed edited source");
    await t.assertions.expectProtocolCode(()=>opened.client.call({type:"workflow.view",payload:{workspaceId:opened.workspaceId,runId,path:"../../config.json"}}),"internal");
    let before:any;
    await t.tools.waitUntil(async()=>{
      const reply=await opened.client.call({type:"workflow.profile",payload:{workspaceId:opened.workspaceId,runId}});
      if(reply?.type!=='workflowProfile')return false;before=reply.data;
      return before.cost.pricedCalls>0;
    },10000);
    equal(before.cost.milliCny,before.cost.pricedCalls*2000,"estimate did not use the frozen tier");
    equal(before.cost.pricedCalls,before.budget.observedLlmRounds,"priced calls and authoritative request budget differ");
    const sessions=await opened.client.call({type:"session.list",payload:{workspaceId:opened.workspaceId,includeArchived:false}});
    t.assertions.assert(sessions?.type==='sessions'&&sessions.data.some(s=>s.id===sessionId&&!s.managed),"PM/root session missing");
    const observation=sessions?.type==='sessions'?sessions.data.find(s=>s.id===sessionId)?.workSummary?.tasks.find(task=>task.runId===runId)?.observation as any:undefined;
    t.assertions.assert(observation?.occupiedMs>0,'native task summary lost Worker occupancy');
    equal(observation.parallelism,1,'a single Worker must have serial occupancy');
    equal(observation.workerOccupiedMs,observation.occupiedMs,'serial Worker intervals differ from their union');
    await opened.client.call({type:"settings.setAgentPreferences",payload:{preferences:{...preferences,costRates:{...preferences.costRates,veryHigh:5000}}}});
    const after=await opened.client.call({type:"workflow.profile",payload:{workspaceId:opened.workspaceId,runId}});
    t.assertions.assert(after?.type==='workflowProfile',"profile disappeared after rate edit");
    equal((after as any).data.cost.milliCny,before.cost.milliCny,"history was repriced");
    equal(before.runs.length,1,"request group fabricated Runs");
    const browser=await openBrowser();
    let consumer: Awaited<ReturnType<typeof openPreviewBrowser>>|undefined;
    try {
      await browser.page.setViewportSize({width:390,height:844});
      consumer=await openPreviewBrowser({openRoot:t.openRoot,lease:t.env,page:browser.page,endpoint:daemonEndpoint(opened.daemon),workspaceId:opened.workspaceId,entryPath:runId,surface:'workflow'});
      await browser.page.getByRole('dialog',{name:'真实进度'}).waitFor();
      await browser.page.getByRole('combobox',{name:'工作流视图'}).selectOption('quality');
      const frame=browser.page.frameLocator('iframe');
      await frame.getByText('时间线与时间花在哪',{exact:true}).waitFor({timeout:30000});
      t.assertions.assert(await frame.getByText('钱花在哪',{exact:true}).isVisible(),'real Run cost view did not render');
      await frame.getByRole('button',{name:'横向',exact:true}).click();
      await frame.getByRole('button',{name:'竖向',exact:true}).click();
      // Control RPCs retain ordinary client authority; no new view whitelist.
      // Resolve the actual document through the public iframe locator. Header
      // readiness is not frame readiness, particularly after native history.
      const viewDocument=frame.locator('body');
      await browser.page.evaluate(()=>{(window as any).__viewOrigins=[];addEventListener('genehub:client-diagnostic',event=>{const detail=(event as CustomEvent).detail?.detail;if(detail?.operation==='workflow.view')(window as any).__viewOrigins.push(detail);});});
      const changed=await viewDocument.evaluate(async()=>{
        const gh=(window as any).GenetHub;
        const settings=await gh.rpc('settings.get');
        const result=await gh.rpc('settings.setAgentPreferences',{preferences:settings.agentPreferences});
        await gh.fs.writeFile('view-receipt.txt','native file API verified');
        if(await gh.fs.readFile('view-receipt.txt')!=='native file API verified')throw new Error('view file API did not roundtrip');
        return result;
      });
      t.assertions.assert(!!changed,'view control RPC was silently rejected');
      await viewDocument.evaluate(async()=>{
        parent.postMessage({source:'genehub.workflow.view.v1',instanceId:'previous-view',requestId:'previous-view:1',kind:'file',payload:{action:'writeFile',path:'wrong-view-instance.txt',content:'must not execute',workspaceId:(window as any).GenetHub.context.workspaceId}},'*');
        await (window as any).GenetHub.rpc('settings.get');
      });
      t.assertions.assert(!existsSync(join(opened.workspaceRoot,'wrong-view-instance.txt')),'stale view instance executed a control operation');

      const auditDir=join(opened.workspaceRoot,'.genethub/temp/workflow-view-calls',runId);
      const audit=readdirSync(auditDir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(auditDir,name),'utf8')));
      t.assertions.assert(audit.some(row=>row.method==='writeFile'&&row.build===catalog.build&&row.runId===runId&&row.viewId==='quality'),'view call origin was not persisted through the file API');
      t.assertions.assert(audit.every(row=>!('payload' in row)&&!('content' in row)),'audit persisted sensitive call bodies');
      await browser.page.screenshot({path:join(process.env.TESTCTL_BROWSER_ARTIFACTS||t.env.workspace,'workflow-mobile.png'),fullPage:true});
      await browser.page.setViewportSize({width:1440,height:1000});
      await browser.page.screenshot({path:join(process.env.TESTCTL_BROWSER_ARTIFACTS||t.env.workspace,'workflow-desktop.png'),fullPage:true});
      const origins=await browser.page.evaluate(()=>(window as any).__viewOrigins);
      t.assertions.assert(origins.some((o:any)=>o.method==='writeFile'&&o.build===catalog.build&&o.runId===runId&&o.viewId==='quality'),'file call source did not identify the pinned build and actual write operation');
      await browser.page.setViewportSize({width:390,height:844});
      await viewDocument.evaluate((_body,id:string)=>{void (window as any).GenetHub.intent.openSession({sessionId:id});},sessionId);
      await browser.page.getByRole('dialog',{name:'真实进度'}).waitFor({state:'hidden'});
      const header=browser.page.getByRole('region',{name:'任务进度'});
      await header.getByRole('button',{name:'真实进度 ›',exact:true}).waitFor().catch(async cause=>{throw new Error(String(cause)+'\nPublic header DOM: '+await header.evaluate(element=>element.outerHTML).catch(()=> 'missing region')+'\nPublic session summary: '+JSON.stringify(await opened.client.call({type:'session.list',payload:{workspaceId:opened.workspaceId,includeArchived:false}})));});
      const box=await header.boundingBox();
      t.assertions.assert(!!box&&box.height<=50&&box.width<=390,'multiple owned views expanded the pinned one-line header');
      equal(await header.getByRole('button').count(),2,'compact header must offer one primary entry plus task details');
      await header.getByRole('button',{name:'真实进度 ›',exact:true}).click();
      await browser.page.getByRole('combobox',{name:'工作流视图'}).waitFor();
      equal(await browser.page.getByRole('combobox',{name:'工作流视图'}).locator('option').count(),2,'compact entry hid other views in the same build');
      await browser.page.evaluate(()=>history.back());
      await browser.page.getByRole('dialog',{name:'真实进度'}).waitFor({state:'hidden'});
      await header.getByRole('button',{name:'真实进度 ›',exact:true}).waitFor();
      await browser.page.evaluate(()=>history.forward());
      await browser.page.getByRole('dialog',{name:'真实进度'}).waitFor();
      await browser.page.getByRole('combobox',{name:'工作流视图'}).waitFor();
      const focused = Object.entries(before.runs[0].nodes).find(([,node]:any)=>node.uses==='agent.session')?.[0];
      t.assertions.assert(!!focused,'fixture has no real Worker node');
      await frame.locator('body').evaluate((_body,{runId,nodeId})=>{void (window as any).GenetHub.intent.openRun({runId,nodeId});},{runId,nodeId:focused});
      await browser.page.locator(`[data-workflow-node-id="${focused}"]`).waitFor({state:'visible'});
      t.assertions.assert(!consumer.errors.length,consumer.errors.join('; '));
    } finally {await browser.close();await consumer?.close();}
    t.note(`Pinned build=${catalog.build}; Worker calls=${before.cost.pricedCalls}; estimate=${before.cost.milliCny} milliCNY`);
  } finally {opened.client.close(); opened.daemon.stop(); await opened.mock.stop();}
});

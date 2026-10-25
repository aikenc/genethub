import { defineSpecialty, daemonEndpoint, openWorkbenchPage, createLease, releaseLease } from "../../framework/public.ts";

for(const width of [390,1280]) defineSpecialty({
  id:`specialty.page-experience.team-summary.${width}`,
  title:`Cross-machine project/session overview and source-safe navigation at ${width}px`,
  oracle:"The actual Workbench lists two native sources without body reads, refreshes and filters projects, restores keyboard focus, and opens the selected source's session on desktop and touch layouts",
  catches:["summary view loads every body", "cross-source navigation keeps the old client", "mobile overview overflows", "dialog dismissal loses focus"],
  tags:["team-summary","page-experience"],runner:"playwright",llm:{default:"none"},
  resources:{environments:1,cpu:3,memoryMb:3072,io:1,browser:1,pool:"browser"},expectedDurationMs:40000,timeoutMs:180000,
  surfaces:["workbench-ui","daemon"],productInterfaces:["@genehub/workbench","session.list","workspace.list","session.get"],
},async t=>{
  const otherLease=createLease("summary-ui-");
  const a=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let b:typeof a|undefined,browser:Awaited<ReturnType<typeof openWorkbenchPage>>|undefined;
  try{
    b=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:otherLease});
    const first=await t.flows.main.createBuiltinSession(a.client,a.workspaceId),second=await t.flows.main.createBuiltinSession(b.client,b.workspaceId);
    for(const [o,id,label] of [[a,first,"甲"],[b,second,"乙"]] as const){
      await o.client.call({type:"session.rename",payload:{sessionId:id,title:`${label}机器专属会话`}});
      await o.client.call({type:"workspace.rename",payload:{workspaceId:o.workspaceId,name:`${label}机器项目`}});
    }
    const entries=[a,b].map((o,i)=>({id:daemonEndpoint(o.daemon).localServerProof.machineId,deviceHandle:daemonEndpoint(o.daemon).localServerProof.machineId,label:`机器${i===0?"甲":"乙"}`,kind:"remote" as const,online:true}));
    browser=await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(a.daemon),a.workspaceId,first,{viewport:{width,height:844},hasTouch:width<768,isMobile:width<768},{trace:false},{targets:()=>entries,endpoint:id=>daemonEndpoint(id===entries[0]!.id?a.daemon:b!.daemon)});
    const page=browser.page;
    await page.getByRole("heading",{name:"甲机器专属会话",exact:true}).waitFor();
    await page.evaluate(()=>{
      const events:Array<{operation:unknown;phase:unknown;source:unknown}>=[];
      (window as unknown as {summaryEvidence:typeof events}).summaryEvidence=events;
      window.addEventListener("genehub:client-diagnostic",e=>{const d=(e as CustomEvent).detail?.detail;if(d?.summarySourceId&&events.length<1000)events.push({operation:d.operation,phase:d.phase,source:d.summarySourceId});});
    });
    if(width<768)await page.getByRole("button",{name:"会话列表",exact:true}).click();
    const trigger=page.getByRole("button",{name:"会话列表选项",exact:true});
    const open=async()=>{await trigger.click();await page.getByRole("menuitem",{name:"跨设备项目与会话",exact:true}).click();const dialog=page.getByRole("dialog",{name:"跨设备项目与会话",exact:true});await dialog.getByRole("status").filter({hasText:"本次所有来源均已读取"}).waitFor();return dialog;};
    let dialog=await open();
    await dialog.getByRole("button",{name:/乙机器专属会话/}).waitFor();
    await dialog.getByRole("button",{name:"刷新",exact:true}).click();
    await dialog.getByRole("status").filter({hasText:"本次所有来源均已读取"}).waitFor();
    const events=await page.evaluate(()=>(window as unknown as {summaryEvidence:Array<{operation:string;phase:string;source:string}>}).summaryEvidence);
    t.assertions.assert(new Set(events.map(e=>e.source)).size===2&&!events.some(e=>["session.get","subscribe"].includes(e.operation)),"overview fetched bodies or omitted a real source");
    t.assertions.assert(events.filter(e=>e.operation==="session.list"&&e.phase==="finish").length===4&&events.filter(e=>e.operation==="workspace.list"&&e.phase==="finish").length===4,"refresh issued wrong summary query count");
    await dialog.getByRole("button",{name:"关闭跨设备总览"}).click();
    t.assertions.assert(await trigger.evaluate(e=>document.activeElement===e),"dialog did not restore focus to its persistent trigger");
    dialog=await open();
    await dialog.getByRole("button",{name:"项目",exact:true}).click();
    await dialog.getByRole("textbox",{name:"搜索跨设备项目与会话"}).fill("乙机器项目");
    await dialog.getByRole("button",{name:/乙机器项目/}).click();
    await dialog.getByRole("textbox",{name:"搜索跨设备项目与会话"}).fill("");
    await dialog.getByRole("button",{name:/乙机器专属会话/}).waitFor();
    t.assertions.assert(await dialog.getByRole("button",{name:/甲机器专属会话/}).count()===0,"project filter mixed source sessions");
    const geometry=await dialog.evaluate(e=>({width:e.getBoundingClientRect().width,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
    t.assertions.assert(!geometry.overflow&&geometry.width<=geometry.viewport,"summary dialog overflows the viewport");
    await dialog.getByRole("button",{name:/乙机器专属会话/}).click();
    await dialog.waitFor({state:"hidden"});
    await page.getByRole("heading",{name:"乙机器专属会话",exact:true}).waitFor();
    const legacy=`/d/${entries[1]!.id}/w/${b.workspaceId}/s/${second}`;
    const compact=`/m-${entries[1]!.id.slice(2,10)}/w-${b.workspaceId.slice(2,10)}/s-${second.slice(2,10)}`;
    await page.waitForURL(url=>url.pathname===legacy||url.pathname===compact);
    const snapshot=await b.client.call({type:"session.get",payload:{sessionId:second}});
    t.assertions.assert(snapshot?.type==="snapshot"&&snapshot.data.summary.title==="乙机器专属会话","selected source no longer owns the displayed session");
    t.note(JSON.stringify({width,sources:2,refreshes:2,summaryBodyReads:0,sourceSafeNavigation:true,geometry}));
  }finally{await browser?.close();for(const o of [a,b])if(o){o.client.close();o.daemon.stop();await o.mock.stop();}releaseLease(otherLease);}
});

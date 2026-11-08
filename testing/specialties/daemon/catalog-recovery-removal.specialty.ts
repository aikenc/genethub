import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {MachineSummaryDirectory,type WebSocketLike} from "@genehub/workbench/client";
import type {CatalogBatch,CatalogKnownSession} from "@genehub/proto";
import {WebSocket} from "ws";
import {defineSpecialty} from "../../framework/public.ts";
import {openFabricPool} from "../../framework/flows/branches/fabric-pool.ts";

const base={tags:["core","catalog-recovery-removal"],llm:{default:"none" as const},requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:0},surfaces:["daemon","filesystem","workbench-client"],productInterfaces:["catalog.sync","session.page","workspace.remove"]};

defineSpecialty({...base,id:"specialty.catalog.first-sync-recovers",title:"An interrupted first directory handoff recovers without a poisoned readiness result",
  oracle:"A real TCP cut interrupts the first catalog RPC; automatic reconnect repairs the same directory and two ordinary refreshes remain successful without extra body subscriptions",
  catches:["first rejected ready promise is reused forever","working automatic recovery becomes unavailable on the next refresh"],expectedDurationMs:15000,timeoutMs:90000,
},async t=>{
  const pool=await openFabricPool(t,2,1);pool.clients[0]!.close();const o=pool.opened;
  let injected=false;let reads=0;
  const directory=new MachineSummaryDirectory({targets:async()=>[{id:"source",deviceHandle:o.client.identity!.machineId,label:"Recovery source",kind:"remote",online:true}],openTarget:async()=>({url:pool.browserFaults[0]!.url,credential:pool.credential,via:"relay",label:"Recovery source"})},{socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike,onDiagnostic:e=>{
    if(e.detail.operation==="catalog.sync"&&e.detail.phase==="start"&&!injected){injected=true;pool.browserFaults[0]!.cutAfterClientBytes(1);}
    if(e.detail.operation==="session.page"&&e.detail.phase==="finish"&&e.detail.outcome==="ok")reads++;
  }});
  try{
    const id=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    await directory.refresh().catch(()=>{});
    await t.tools.waitUntil(()=>directory.value.sources.some(s=>s.sessions.some(x=>x.id===id)&&s.activityComplete&&!s.cached&&!s.refreshing),20000);
    for(let n=0;n<2;n++){const result=await directory.refresh();t.assertions.assert(result.complete&&result.sources[0]?.sessions.some(s=>s.id===id),"recovered source failed an ordinary refresh");}
    t.assertions.assert(injected&&pool.browserFaults[0]!.injectedCuts()===1,"first catalog RPC was not interrupted at the real TCP boundary");
    t.note(JSON.stringify({cuts:1,postRecoveryRefreshes:2,historyPageReads:reads}));
  }finally{directory.close();await pool.dispose();}
});

defineSpecialty({...base,id:"specialty.catalog.cold-scope-error-preserves-cache",title:"Cold unreadable metadata is unknown rather than a directory deletion",
  oracle:"After a real daemon restart, a corrupted scope reports an error and preserves cached references while a separately deleted healthy reference is removed; repairing disk clears the error",
  catches:["cold unknown scope deletes browser cache","bad scope prevents healthy pages","error protection hides real deletions"],expectedDurationMs:15000,timeoutMs:90000,
},async t=>{
  let o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});let stop=()=>{};
  try{
    const bad=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    const healthyRoot=join(t.env.root,"healthy");mkdirSync(healthyRoot);
    const w=await o.client.call({type:"workspace.open",payload:{root:healthyRoot}});if(w?.type!=="workspace")throw Error("healthy workspace missing");
    const healthy=await t.flows.main.createBuiltinSession(o.client,w.data.id),removed=await t.flows.main.createBuiltinSession(o.client,w.data.id);
    const page=await o.client.call({type:"session.page",payload:{includeArchived:true,requests:[{workspaceId:null,cursor:null,limit:100}]}});
    if(page?.type!=="sessionPages")throw Error("page missing");
    const known:CatalogKnownSession[]=page.data[0]!.sessions.filter(s=>[bad,healthy,removed].includes(s.id)).map(s=>({workspaceId:s.workspaceId,id:s.id,etag:page.data[0]!.catalogEtags![s.id]!,active:false}));
    const badPath=join(o.workspaceRoot,".genethub/sessions",bad,"meta.json"),original=readFileSync(badPath,"utf8");
    await o.client.call({type:"session.delete",payload:{sessionId:removed}});
    o.client.close();o.daemon.stop();await o.mock.stop();writeFileSync(badPath,"{broken metadata");
    o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
    const batches:CatalogBatch[]=[];const sub=o.client.followCatalog({known:()=>({sessions:known,workspaces:[]}),onUnavailable:()=>{},onBatch:b=>batches.push(b)});stop=sub.stop;await sub.ready;
    t.assertions.assert(batches.some(b=>b.scopeErrors?.some(e=>e.workspaceId===o.workspaceId)),"cold damaged scope was not reported unknown");
    t.assertions.assert(!batches.some(b=>b.removedSessions.some(r=>r.id===bad))&&batches.some(b=>b.removedSessions.some(r=>r.id===removed)),"unknown scope was deleted or genuine deletion hidden");
    const good=await o.client.call({type:"session.page",payload:{requests:[{workspaceId:w.data.id,cursor:null,limit:10}],includeArchived:true}});
    t.assertions.assert(good?.type==="sessionPages"&&!good.data[0]?.error&&good.data[0]?.sessions.some(s=>s.id===healthy),"healthy project became unreadable");
    writeFileSync(badPath,original);
    await t.tools.waitUntil(()=>batches.some(b=>b.scopeErrors!==null&&b.scopeErrors.length===0),15000);
    t.note("cold scope remained unknown; genuine removal and independent healthy history stayed correct; repaired scope recovered");
  }finally{stop();o.client.close();o.daemon.stop();await o.mock.stop();}
});

defineSpecialty({...base,id:"specialty.workspace-removal.unrelated-history-untouched",title:"Removing one project does not project or repair unrelated history",
  oracle:"Removing one empty project leaves 1000 unrelated durable conversation records byte-for-byte unchanged and preserves their files",
  catches:["remove creates all-machine summaries","registration change repairs unrelated conversation titles"],expectedDurationMs:15000,timeoutMs:90000,
},async t=>{
 const o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
 try{
   const seed=await t.flows.main.createBuiltinSession(o.client,o.workspaceId),home=join(o.workspaceRoot,".genethub/sessions");
   const model=JSON.parse(readFileSync(join(home,seed,"meta.json"),"utf8"));const records:Array<[string,string]>=[];
   for(let n=0;n<1000;n++){const id=`s_unrelated_${n}`,root=join(home,id);mkdirSync(root);const raw=JSON.stringify({...model,id,title:"Skill Selection Guidance",titleLocked:false});writeFileSync(join(root,"meta.json"),raw);writeFileSync(join(root,"chat.jsonl"),JSON.stringify({t:"item",item:{type:"userMessage",id:`u_${n}`,text:"Preserve my historical title during unrelated project removal",attachments:[]}})+"\n");records.push([join(root,"meta.json"),raw]);}
   const root=join(t.env.root,"remove-target");mkdirSync(root);writeFileSync(join(root,"keep.txt"),"preserved");
   const w=await o.client.call({type:"workspace.open",payload:{root}});if(w?.type!=="workspace")throw Error("target missing");
   const start=performance.now();const result=await o.client.call({type:"workspace.remove",payload:{workspaceId:w.data.id}});
   t.assertions.assert(result?.type==="workspaces"&&!result.data.some(x=>x.id===w.data.id),"target remained registered");
   t.assertions.assert(records.every(([p,raw])=>readFileSync(p,"utf8")===raw)&&readFileSync(join(root,"keep.txt"),"utf8")==="preserved","removal projected and rewrote unrelated history or changed user files");
   t.note(JSON.stringify({unrelatedRecords:1000,elapsedMs:Math.round(performance.now()-start)}));
 }finally{o.client.close();o.daemon.stop();await o.mock.stop();}
});

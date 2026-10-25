import { MachineSummaryDirectory, type Target, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty, daemonEndpoint } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.team-summary.budgets-and-cancellation",title:"Real source summary budgets, stale offline data, alias deduplication and late-dial cancellation",
  oracle:"501 actual native sessions produce explicit 500/501 partial data; an offline directory entry keeps labeled stale content without another dial; 33 sources retain an unchecked row; aborted late endpoint lookup creates no socket",
  catches:["truncated results are reported complete", "offline cache is relabeled fresh", "duplicate device aliases multiply owners", "closing summary allows a late dial"],
  tags:["team-summary","boundaries"],llm:{default:"none"},resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:0},
  surfaces:["daemon","workbench-client"],productInterfaces:["@genehub/workbench/client MachineSummaryDirectory"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],expectedDurationMs:30000,timeoutMs:120000,
},async t=>{
  const o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let directory:MachineSummaryDirectory|undefined,late:MachineSummaryDirectory|undefined;
  try{
    const ids=new Set<string>();for(let i=0;i<501;i++)ids.add(await t.flows.main.createBuiltinSession(o.client,o.workspaceId));
    const endpoint={...daemonEndpoint(o.daemon),via:"loopback" as const,label:"Budget source"};
    let targets:Target[]=[{id:"source",deviceHandle:o.client.identity!.machineId,label:"Budget source",kind:"local",online:true}];let sockets=0;
    directory=new MachineSummaryDirectory({targets:async()=>targets,openTarget:async()=>({...daemonEndpoint(o.daemon),via:"loopback",label:"Budget source"})},{socketFactory:u=>{sockets++;return new WebSocket(u) as unknown as WebSocketLike;}});
    const first=await directory.refresh(()=>{}),row=first.sources[0]!;
    t.assertions.assert(!first.complete&&row.state==="partial"&&row.sessions.length===500&&row.sessionTotal===501&&row.sessions.every(s=>ids.has(s.id)),"real native session truncation did not remain explicit");
    targets=[{...targets[0]!,online:false}];const offline=await directory.refresh(()=>{});
    t.assertions.assert(!offline.complete&&offline.sources[0]!.state==="offline"&&offline.sources[0]!.sessions.length===500&&offline.sources[0]!.updatedAt===row.updatedAt&&sockets===1,"offline refresh lost its stale label or opened another owner");
    targets=[{...targets[0]!,online:false},{...targets[0]!,id:"online-alias",online:true}];const dedup=await directory.refresh(()=>{});
    t.assertions.assert(dedup.sources.length===1&&dedup.sources[0]!.target.id==="online-alias"&&dedup.sources[0]!.state==="partial"&&sockets===2,"online device alias was not deduplicated");
    targets=[{id:"wrong-source",deviceHandle:"m_wrong_source",label:"Wrong source",kind:"remote",online:true}];
    const mismatch=await directory.refresh(()=>{});
    t.assertions.assert(!mismatch.complete&&mismatch.sources[0]!.state==="denied"&&mismatch.sources[0]!.sessions.length===0,"summary accepted a different authenticated source than its directory entry");
    targets=Array.from({length:33},(_,i)=>({id:`offline-${i}`,label:`Offline ${i}`,kind:"remote",online:false}));const budget=await directory.refresh(()=>{});
    t.assertions.assert(!budget.complete&&budget.checked===32&&budget.sources[32]?.state==="notChecked"&&sockets===3,"source read budget hid an unchecked source or dialed known-offline machines");
    let resolve!:(v:typeof endpoint)=>void,opened=false,lateSockets=0;
    late=new MachineSummaryDirectory({targets:async()=>[{id:"late",label:"Late source",kind:"local"}],openTarget:()=>{opened=true;return new Promise(r=>resolve=r);}},{socketFactory:u=>{lateSockets++;return new WebSocket(u) as unknown as WebSocketLike;}});
    const pending=late.refresh(()=>{});void pending.catch(()=>{});await t.tools.waitUntil(()=>opened,1000);late.close();resolve(endpoint);
    await pending.catch(()=>{});await new Promise(r=>setTimeout(r,50));
    t.assertions.assert(lateSockets===0,"cancelled endpoint lookup created a late source socket");
    t.note(JSON.stringify({nativeSessions:501,displayed:500,partial:true,offlineCacheLabeled:true,sourceBudget:32,unchecked:1,lateSockets}));
  }finally{late?.close();directory?.close();o.client.close();o.daemon.stop();await o.mock.stop();}
});

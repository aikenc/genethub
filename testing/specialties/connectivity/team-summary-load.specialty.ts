import { createHash } from "node:crypto";
import { MachineSummaryDirectory, type Target, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

defineSpecialty({
  id:"specialty.team-summary.ten-machines-two-hundred-members",title:"The real summary directory reads 200 members through ten reused control-only owners during full body traffic",
  oracle:"Ten actual native sources and 200 once-only SDK tasks retain exact member identities; three refreshes each issue one session.list and one workspace.list per source, reuse ten sockets, never subscribe to bodies, and keep two source reads active at most",
  catches:["one owner or query per member", "summary view accidentally loads bodies", "fresh connections on every refresh exhaust admission", "successful sources hide missing members"],
  tags:["team-summary","team-scale"],llm:{default:"none"},stages:["fleet","load","summary"],
  resources:{environments:1,cpu:12,memoryMb:16384,io:2,browser:0,pool:"exclusive"},expectedDurationMs:180000,timeoutMs:360000,
  surfaces:["daemon","relay","agent-sdk","workbench-client","tcp"],productInterfaces:["@genehub/workbench/client MachineSummaryDirectory"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],retention:true,
},async t=>{
  const fleet=await t.stage("fleet",()=>openScaleFleet(t,10,20,true,{nodeChannels:2,bothLegs:true}));
  let sockets=0,gets=0,lists=0,workspaces=0,subscribes=0,peak=0;
  const active=new Set<string>(),finished=new Map<string,number>();
  const targets:Target[]=fleet.nodes.map((n,i)=>({id:String(i),deviceHandle:n.opened.client.identity!.machineId,label:`Team ${i}`,kind:"remote",online:true}));
  const endpoints=await Promise.all(fleet.nodes.map(async n=>{const r=await n.opened.client.call({type:"device.list"});if(r?.type!=="devices"||!r.data.remote.channels?.[0])throw new Error("primary node missing");const u=new URL(r.data.remote.channels[0].url);u.host=new URL(fleet.relay.origin).host;return {url:fleet.link.urlFor(u.toString())};}));
  // Derive a fresh paired authority through the public invitation path for
  // the real product consumer, independently of the body's existing viewers.
  const credentials=await Promise.all(fleet.nodes.map(async n=>{const p=await t.flows.main.pairDevice(n.opened.client,n.opened.daemon,[],"summary-viewer");p.client.close();return p.credential;}));
  const directory=new MachineSummaryDirectory({targets:async()=>targets,openTarget:async id=>({url:endpoints[Number(id)]!.url,via:"relay",label:targets[Number(id)]!.label,credential:credentials[Number(id)]})},{
    socketFactory:u=>{sockets++;return new WebSocket(u) as unknown as WebSocketLike;},
    onDiagnostic(e){
      if(e.kind!=="operation")return;const op=e.detail.operation,phase=e.detail.phase,key=String(e.detail.connectionAttemptId);
      if(op==="session.get"&&phase==="finish")gets++;if(op==="subscribe"&&phase==="finish")subscribes++;
      if(op!=="session.list"&&op!=="workspace.list")return;
      if(phase==="start"){if(!active.has(key)){finished.set(key,0);active.add(key);peak=Math.max(peak,active.size);}}
      if(phase==="finish"){if(op==="session.list")lists++;else workspaces++;const count=(finished.get(key)??0)+1;finished.set(key,count);if(count===2)active.delete(key);}
    },
  });
  const expected=new Set(fleet.nodes.flatMap(n=>n.sessions));
  const verify=(r:Awaited<ReturnType<typeof directory.refresh>>)=>{const ids=r.sources.flatMap(s=>s.sessions.map(v=>v.id)).filter(id=>expected.has(id));t.assertions.assert(r.complete&&r.sources.length===10&&ids.length===200&&new Set(ids).size===200,"a summary source or member was omitted/duplicated");};
  const times:number[]=[];let bodyEvents=0,repairs=0;const completed=new Set<string>();
  try{
    let start=performance.now();verify(await directory.refresh(()=>{}));times.push(performance.now()-start);
    for(const n of fleet.nodes)for(const id of n.sessions)await n.client.subscribe(id,{onEvent(e){bodyEvents++;if(e.event.type==="turnCompleted")completed.add(id);},onResync(snapshot,replayed){repairs++;const value=snapshot as {summary?:{status?:string;latestReply?:unknown}};if(value.summary?.status==="idle"&&value.summary.latestReply||replayed.some(e=>e.event.type==="turnCompleted"))completed.add(id);}});
    fleet.link.setProfile({bandwidthMbps:5,rttMs:200});
    const sends=t.stage("load",()=>Promise.all(fleet.nodes.flatMap(n=>n.sessions.map(id=>t.flows.main.sendPrompt(n.control,id,"Emit the deterministic summary pressure trace.")))));
    void sends.catch(()=>{});
    await t.stage("summary",async()=>{for(let round=0;round<2;round++){start=performance.now();verify(await directory.refresh(()=>{}));times.push(performance.now()-start);}});
    fleet.link.setProfile({bandwidthMbps:1000,rttMs:0});await sends;
    await t.tools.waitUntil(()=>fleet.nodes.every(n=>readControlledAgentJournal(n.agent).filter(e=>e.event==="answered").length===20),30000);
    await t.tools.waitUntil(()=>completed.size===200,30000);
    let exactBodies=0;const expectedBody=Array.from({length:200},(_,i)=>`f${i} `).join("");
    await Promise.all(fleet.nodes.map(async n=>{for(const id of n.sessions){const r=await n.client.call({type:"session.get",payload:{sessionId:id,recentRounds:1}});if(r?.type==="snapshot"){const text=r.data.items.filter(v=>v.type==="assistantMessage").map(v=>v.type==="assistantMessage"?v.text:"").join("");if(createHash("sha256").update(text).digest("hex")===createHash("sha256").update(expectedBody).digest("hex"))exactBodies++;}}}));
    t.note(JSON.stringify({bodyEvents,repairs,bodyCompletions:completed.size,exactBodies,nativeSources:10,members:200,refreshes:3,sockets,sessionLists:lists,workspaceLists:workspaces,summaryBodyGets:gets,summarySubscriptions:subscribes,maxConcurrentSources:peak,refreshMs:times.map(Math.round),sourceCounts:fleet.nodes.map(n=>({prompt:readControlledAgentJournal(n.agent).filter(e=>e.event==="prompt").length,answered:readControlledAgentJournal(n.agent).filter(e=>e.event==="answered").length}))}));
    t.assertions.assert(exactBodies===200&&completed.size===200,"summary pressure lost a source body or completion");
    t.assertions.assert(sockets===10&&lists===30&&workspaces===30&&gets===0&&subscribes===0&&peak===2,"summary connection/query/subscription budget failed");
    t.assertions.assert(times.slice(1).every(ms=>ms<10000)&&fleet.nodes.every(n=>readControlledAgentJournal(n.agent).filter(e=>e.event==="prompt").length===20),"loaded summary refresh or exactly-once source workload failed");
  }finally{directory.close();await fleet.dispose();}
});

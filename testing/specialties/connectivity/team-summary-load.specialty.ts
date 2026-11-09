import { createHash } from "node:crypto";
import { MachineSummaryDirectory, type Target, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

defineSpecialty({
  id:"specialty.team-summary.ten-machines-two-hundred-members",title:"The real summary directory reads 200 members through at most four shared control-only owners during full body traffic",
  oracle:"Ten actual native sources and 200 once-only SDK tasks retain exact member identities; three refreshes use the directory topic plus at most one visible history page per newly connected source, reuse ready-source directories without rotating live subscriptions after the first refresh, keep at most four sockets, label evicted sources as cached rather than current, never subscribe to bodies, and keep two history reads active at most",
  catches:["one owner or query per member", "summary view accidentally loads bodies", "fresh connections on every refresh exhaust admission", "successful sources hide missing members"],
  tags:["team-summary","team-scale"],llm:{default:"none"},stages:["fleet","load","summary"],
  resources:{environments:1,cpu:12,memoryMb:16384,io:2,browser:0,pool:"exclusive"},expectedDurationMs:180000,timeoutMs:360000,
  surfaces:["daemon","relay","agent-sdk","workbench-client","tcp"],productInterfaces:["@genehub/workbench/client MachineSummaryDirectory"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],retention:true,
},async t=>{
  const fleet=await t.stage("fleet",()=>openScaleFleet(t,10,20,true,{nodeChannels:2,bothLegs:true}));
  let sockets=0,gets=0,lists=0,workspaces=0,subscribes=0,peak=0,liveSockets=0,peakSockets=0,peakClosingSockets=0;
  const sourceSockets = new Set<WebSocket>();
  const active=new Set<string>();
  const targets:Target[]=fleet.nodes.map((n,i)=>({id:String(i),deviceHandle:n.opened.client.identity!.machineId,label:`Team ${i}`,kind:"remote",online:true}));
  const endpoints=await Promise.all(fleet.nodes.map(async n=>{const r=await n.opened.client.call({type:"device.list"});if(r?.type!=="devices"||!r.data.remote.channels?.[0])throw new Error("primary node missing");const u=new URL(r.data.remote.channels[0].url);u.host=new URL(fleet.relay.origin).host;return {url:fleet.link.urlFor(u.toString())};}));
  // Derive a fresh paired authority through the public invitation path for
  // the real product consumer, independently of the body's existing viewers.
  const credentials=await Promise.all(fleet.nodes.map(async n=>{const p=await t.flows.main.pairDevice(n.opened.client,n.opened.daemon,"summary-viewer");p.client.close();return p.credential;}));
  const directory=new MachineSummaryDirectory({targets:async()=>targets,openTarget:async id=>({url:endpoints[Number(id)]!.url,via:"relay",label:targets[Number(id)]!.label,credential:credentials[Number(id)]})},{
    socketFactory:u=>{sockets++;const ws=new WebSocket(u);sourceSockets.add(ws);ws.on("open",()=>{liveSockets++;peakClosingSockets=Math.max(peakClosingSockets,liveSockets);peakSockets=Math.max(peakSockets,[...sourceSockets].filter(socket=>socket.readyState===WebSocket.OPEN).length);});ws.on("close",()=>{liveSockets--;sourceSockets.delete(ws);});return ws as unknown as WebSocketLike;},
    onDiagnostic(e){
      if(e.kind!=="operation")return;const op=e.detail.operation,phase=e.detail.phase,key=String(e.detail.connectionAttemptId);
      if(op==="session.get"&&phase==="finish")gets++;if(op==="subscribe"&&phase==="finish")subscribes++;
      if(op!=="session.page"&&op!=="workspace.list")return;
      if(phase==="start"){active.add(key);peak=Math.max(peak,active.size);}
      if(phase==="finish"){if(op==="session.page")lists++;else workspaces++;active.delete(key);}
    },
  });
  const expected=new Set(fleet.nodes.flatMap(n=>n.sessions));
  const verify=(r:Awaited<ReturnType<typeof directory.refresh>>)=>{const ids=r.sources.flatMap(s=>s.sessions.map(v=>v.id)).filter(id=>expected.has(id));
    t.note(JSON.stringify({refresh:times.length+1,complete:r.complete,matched:ids.length,unique:new Set(ids).size,sources:r.sources.map(s=>({id:s.target.id,state:s.state,cached:Boolean(s.cached),activityComplete:Boolean(s.activityComplete),sessions:s.sessions.length}))}));
    t.assertions.assert(!r.complete&&r.sources.length===10&&ids.length===200&&new Set(ids).size===200&&r.sources.every(s=>s.state==="ready"&&s.updatedAt!==null)&&r.sources.some(s=>s.cached)&&r.sources.some(s=>!s.cached&&s.activityComplete),"a source/member was omitted or bounded subscription eviction was presented as fully current data");};
  const times:number[]=[],firstReadyMs:number[]=[],socketsAfter:number[]=[];
  const measure = async () => { const began=performance.now(); let first=0; const result=await directory.refresh(value=>{ if(!first && value.sources.some(s=>s.state==="ready"||s.state==="partial"))first=performance.now()-began; }); firstReadyMs.push(first); verify(result); times.push(performance.now()-began); socketsAfter.push(sockets); };
  let bodyEvents=0,repairs=0;const completed=new Set<string>();
  try{
    await measure();
    for(const n of fleet.nodes)for(const id of n.sessions)await n.client.subscribe(id,{onEvent(e){bodyEvents++;if(e.event.type==="turnCompleted")completed.add(id);},onResync(snapshot,replayed){repairs++;const value=snapshot as {summary?:{status?:string;latestReply?:unknown}};if(value.summary?.status==="idle"&&value.summary.latestReply||replayed.some(e=>e.event.type==="turnCompleted"))completed.add(id);}});
    fleet.link.setProfile({bandwidthMbps:5,rttMs:200});
    const sends=t.stage("load",()=>Promise.all(fleet.nodes.flatMap(n=>n.sessions.map(id=>t.flows.main.sendPrompt(n.control,id,"Emit the deterministic summary pressure trace.")))));
    void sends.catch(error=>t.note(`Load acknowledgement failed: ${error instanceof Error?error.message:String(error)}`));
    await t.stage("summary",async()=>{for(let round=0;round<2;round++){await measure();}});
    fleet.link.setProfile({bandwidthMbps:1000,rttMs:0});await sends;
    await t.tools.waitUntil(()=>fleet.nodes.every(n=>readControlledAgentJournal(n.agent).filter(e=>e.event==="answered").length===20),30000);
    await t.tools.waitUntil(()=>completed.size===200,30000);
    let exactBodies=0;const expectedBody=Array.from({length:200},(_,i)=>`f${i} `).join("");
    await Promise.all(fleet.nodes.map(async n=>{for(const id of n.sessions){const r=await n.client.call({type:"session.get",payload:{sessionId:id,recentRounds:1}});if(r?.type==="snapshot"){const text=r.data.items.filter(v=>v.type==="assistantMessage").map(v=>v.type==="assistantMessage"?v.text:"").join("");if(createHash("sha256").update(text).digest("hex")===createHash("sha256").update(expectedBody).digest("hex"))exactBodies++;}}}));
    t.note(JSON.stringify({bodyEvents,repairs,bodyCompletions:completed.size,exactBodies,nativeSources:10,members:200,refreshes:3,sockets,socketsAfter,peakSockets,peakClosingSockets,sessionPages:lists,workspaceLists:workspaces,summaryBodyGets:gets,summarySubscriptions:subscribes,maxConcurrentSources:peak,refreshMs:times.map(Math.round),firstReadyMs:firstReadyMs.map(Math.round),sourceCounts:fleet.nodes.map(n=>({prompt:readControlledAgentJournal(n.agent).filter(e=>e.event==="prompt").length,answered:readControlledAgentJournal(n.agent).filter(e=>e.event==="answered").length}))}));
    t.assertions.assert(exactBodies===200&&completed.size===200,"summary pressure lost a source body or completion");
    // Once every source has been read, background refreshes keep the live
    // subscriptions instead of rotating sources through the budget.
    t.assertions.assert(socketsAfter[2]!-socketsAfter[0]!<=4,"background refreshes rotated live subscriptions through the connection budget");
    t.assertions.assert(sockets<=30&&peakSockets<=4&&peakClosingSockets<=8&&lists>=10&&lists<=30&&workspaces===0&&gets===0&&subscribes===0&&peak>0&&peak<=2,"summary connection/query/subscription budget failed");
    // Four retained owners intentionally trade cold handshake cost for a fixed
    // mobile/desktop budget. User access is gated by first source readiness,
    // not by the last of ten sources finishing. Both deadlines remain asserted.
    t.assertions.assert(firstReadyMs.every(ms=>ms>0&&ms<4000)&&times.slice(1).every(ms=>ms<20000)&&fleet.nodes.every(n=>readControlledAgentJournal(n.agent).filter(e=>e.event==="prompt").length===20),"progressive source/fleet deadline or exactly-once source workload failed");
  }finally{directory.close();await fleet.dispose();}
});

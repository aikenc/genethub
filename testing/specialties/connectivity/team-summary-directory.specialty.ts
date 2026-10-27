import { MachineSummaryDirectory, type SummaryDirectory, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { allocatePort, startHub, startRelay, defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

defineSpecialty({
  id:"specialty.team-summary.public-consumer",title:"The real workbench summary consumer reuses a control-only owner and distinguishes uncertain paired-link failure",
  oracle:"Two refreshes each read one session.list and one workspace.list from a real native daemon, keep one browser socket, subscribe to no bodies, and revoked paired access cannot refresh cached data or be presented as a successful read",
  catches:["one connection or query per member", "summary view subscribes to all bodies", "uncertain disconnect is presented as fresh authorized data", "public interface is only a type projection"],
  tags:["team-summary","contract"],llm:{default:"none"},resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:0},expectedDurationMs:20000,timeoutMs:60000,
  surfaces:["daemon","relay","workbench-client","tcp"],productInterfaces:["@genehub/workbench/client MachineSummaryDirectory"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
},async t=>{
  const pool=await openFabricPool(t,2,1);const o=pool.opened;
  let sockets=0,closed=0,body=0;const operations:string[]=[];
  const directory=new MachineSummaryDirectory({
    targets:async()=>[{id:"source",deviceHandle:o.client.identity!.machineId,label:"Summary source",kind:"remote",online:true}],
    openTarget:async()=>({url:pool.browserFaults[0]!.url,credential:pool.credential,via:"relay",label:"Summary source"}),
  },{socketFactory:u=>{sockets++;const ws=new WebSocket(u);ws.on("close",()=>closed++);return ws as unknown as WebSocketLike;},onDiagnostic(e){if(e.detail.lane==="body")body++;if(e.kind==="operation"&&e.detail.phase==="finish")operations.push(String(e.detail.operation));}});
  try{
    const id=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    let latest:SummaryDirectory|undefined;
    for(let i=0;i<2;i++){
      latest=await directory.refresh(value=>{latest=value;});
      t.assertions.assert(latest.complete&&latest.sources[0]?.sessions.some(s=>s.id===id)&&latest.sources[0].workspaces.some(w=>w.id===o.workspaceId),"summary did not read exact source sessions/projects");
    }
    t.assertions.assert(sockets===1&&body===0&&operations.filter(x=>x==="session.list").length===2&&operations.filter(x=>x==="workspace.list").length===2&&!operations.some(x=>x==="subscribe"||x==="session.get"),"summary path multiplied owners or fetched bodies");
    await o.client.call({type:"device.revoke",payload:{deviceId:pool.credential.deviceId}});
    await t.tools.waitUntil(()=>closed===1,5000);
    latest=await directory.refresh(()=>{});
    const state=latest.sources[0]?.state;
    t.note(JSON.stringify({refreshes:2,sessionLists:2,workspaceLists:2,initialSockets:1,bodySubscriptions:0,afterRevocation:state,complete:latest.complete}));
    t.assertions.assert(!latest.complete&&["timeout","unavailable","denied"].includes(state??""),"unconfirmed paired failure was treated as fresh successful data or confirmed offline");
    if(state==="denied")t.assertions.assert(latest.sources[0]!.sessions.length===0&&latest.sources[0]!.updatedAt===null,"confirmed denial retained cached content");
  }finally{directory.close();await pool.dispose();}
});


defineSpecialty({
  id:"specialty.team-summary.confirmed-denial",title:"Confirmed Hub session denial clears every cached source summary",
  oracle:"Actual Hosted owner session revocation returns HTTP401; summary refresh must erase source content, preserve explicit denied state and never leave a previous complete snapshot visible",
  catches:["directory lookup denial leaves authorized-looking cached rows", "transport failure and authentication rejection are conflated"],
  tags:["team-summary","authorization"],llm:{default:"none"},requiredRepos:["cloud"],resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:0},
  surfaces:["cloud-server","daemon","relay","workbench-client"],productInterfaces:["hub-http","@genehub/workbench/client MachineSummaryDirectory"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],expectedDurationMs:20000,timeoutMs:90000,
},async t=>{
  const port=await allocatePort(),token=randomBytes(32).toString("hex");
  const hub=await startHub({databasePath:join(t.env.root,"summary-auth.sqlite"),relayOrigin:`http://127.0.0.1:${port}`,relayToken:token});
  const relay=await startRelay({openRoot:t.openRoot,port,control:{origin:hub.origin,token}});
  t.env.env.GENEHUB_LOCAL_HUB_URL=hub.origin;const o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let directory:MachineSummaryDirectory|undefined;
  try{
    const owner=hub.browser();await hub.signInOwner(owner);
    const pair=await o.client.call({type:"hub.pair",payload:{hubUrl:hub.origin,displayName:"Summary authority"}});
    if(pair?.type!=="hubStatus"||pair.data.state!=="pairing")throw new Error("pairing failed");await hub.approvePairing(owner,pair.data.userCode);
    const json=async<T,>(path:string,method="GET"):Promise<T>=>{const r=await owner.fetch(path,{method});if(!r.ok){await r.body?.cancel();throw Object.assign(new Error("Hub request refused"),{status:r.status});}return await r.json() as T;};
    type Me={session:{id:string};machines:Array<{id:string;name:string;online:boolean}>};let machineId="";
    await t.tools.waitUntil(async()=>{const me=await json<Me>("/app/me");machineId=me.machines.find(m=>m.online)?.id??"";return !!machineId;},30000);
    const session=(await json<Me>("/app/me")).session.id;
    await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    directory=new MachineSummaryDirectory({targets:async()=>(await json<Me>("/app/me")).machines.filter(m=>m.id===machineId).map(m=>({id:m.id,label:m.name,kind:"remote",online:m.online})),openTarget:async id=>{
      const ticket=await json<{url:string;fingerprint:string;channelCapability:string;channelSecret:string;fabricRouteTicket:string;fabricAuthorizationExpiresAt?:string}>(`/app/machines/${id}/connect`,"POST");
      return {url:ticket.url,label:"Summary authority",via:"relay",fingerprint:ticket.fingerprint,channelCredential:{capabilityId:ticket.channelCapability,secret:ticket.channelSecret},fabricRouteTicket:ticket.fabricRouteTicket,fabricAuthorizationExpiresAt:ticket.fabricAuthorizationExpiresAt};
    }},{socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike});
    let latest:SummaryDirectory=await directory.refresh(()=>{});t.note(JSON.stringify({phase:"initial",complete:latest.complete,sources:latest.sources.map(s=>({state:s.state,sessions:s.sessions.length,projects:s.workspaces.length}))}));t.assertions.assert(latest.complete&&latest.sources.some(s=>s.sessions.length>0),"initial authorized summaries missing");
    const revoked=await owner.fetch(`/app/sessions/${session}/revoke`,{method:"POST"});await revoked.body?.cancel();t.assertions.assert(revoked.ok,"session revoke failed");
    await directory.refresh(v=>{latest=v;},undefined,new Set()).catch(()=>{});
    t.note(JSON.stringify({complete:latest.complete,states:latest.sources.map(s=>s.state),remainingSessions:latest.sources.reduce((n,s)=>n+s.sessions.length,0)}));
    t.assertions.assert(!latest.complete&&latest.sources.every(s=>s.state==="denied"&&s.sessions.length===0&&s.workspaces.length===0&&s.updatedAt===null),"confirmed Hub denial retained cached source content");
  }finally{directory?.close();o.client.close();o.daemon.stop();await o.mock.stop();relay.stop();await hub.stop();}
});

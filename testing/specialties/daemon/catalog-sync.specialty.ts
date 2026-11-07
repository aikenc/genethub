import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {CatalogBatch, CatalogKnownSession} from "@genehub/proto";
import {Client,type WebSocketLike} from "@genehub/workbench/client";
import {WebSocket} from "ws";
import {defineSpecialty} from "../../framework/public.ts";
import {openFabricPool} from "../../framework/flows/branches/fabric-pool.ts";

const base = {
  tags:["core","catalog-sync"],llm:{default:"none" as const},
  requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
  surfaces:["daemon","filesystem","workbench-client"],
  productInterfaces:["catalog.sync","session.page","session.rename","session.delete","@genehub/workbench/client"],
  resources:{environments:1,cpu:2,memoryMb:2048,io:2,browser:0},
};

defineSpecialty({...base,
  id:"specialty.daemon.catalog-sync.conditional-and-restart",
  title:"Directory handoff, online changes, conditional repair and a new daemon instance",
  oracle:"13 real old activities appear without body subscriptions; an online rename changes one row, unchanged cached summaries are not retransmitted, offline rename/delete repair exactly their references, and content validation remains correct after a daemon restart",
  catches:["subscribes every history body","online update reloads directory","cached row resurrects after deletion","new process reuses old directory sequence as proof"],
  expectedDurationMs:25000,timeoutMs:150000,
},async t => {
  let o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let stop=()=>{};
  try {
    const seed=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    const home=join(o.workspaceRoot,".genethub"), sessions=join(home,"sessions");
    const model=JSON.parse(readFileSync(join(sessions,seed,"meta.json"),"utf8"));
    const ids=[seed];
    for(let n=1;n<13;n++) {
      const id=`s_catalog_sync_${n}`;ids.push(id);mkdirSync(join(sessions,id));
      writeFileSync(join(sessions,id,"meta.json"),JSON.stringify({...model,id,title:`activity ${n}`,titleLocked:true}));
    }
    writeFileSync(join(home,"coordination-source.json"),JSON.stringify({version:1,source:"test"}));
    writeFileSync(join(home,"session-coordination.json"),JSON.stringify({version:1,source:"test",revision:1,updatedAtMs:Date.now(),receivedAtMs:Date.now(),
      sessions:Object.fromEntries(ids.map(id=>[id,{source:"test",active:true,pending:1,ready:0,unknown:0,updatedAtMs:Date.now()}]))}));
    t.assertions.assert(o.client.identity?.features?.includes("catalog.sync.v1") === true,"new directory artifact is not active");
    let frames:CatalogBatch[]=[];
    const follow=async(known:CatalogKnownSession[]) => {
      frames=[];
      const sub=o.client.followCatalog({known:()=>({sessions:known,workspaces:[]}),onBatch:b=>frames.push(b),onUnavailable:()=>{}});
      stop=sub.stop;await sub.ready;
      return frames.filter(b=>b.snapshot).flatMap(b=>b.sessions);
    };
    const first=await follow([]);
    t.assertions.assert(first.length===13&&new Set(first.map(r=>r.summary.id)).size===13&&first.every(r=>r.active&&ids.includes(r.summary.id)),"initial current work is incomplete");
    const known=(rows:typeof first):CatalogKnownSession[]=>rows.map(r=>({id:r.summary.id,workspaceId:r.summary.workspaceId,etag:r.etag,active:r.active}));
    const target=ids[0]!,deleted=ids[1]!;
    await o.client.call({type:"session.rename",payload:{sessionId:target,title:"one online change"}});
    await t.tools.waitUntil(()=>frames.some(b=>!b.snapshot&&b.sessions.some(r=>r.summary.id===target&&r.summary.title==="one online change")),10000);
    const online=frames.filter(b=>!b.snapshot).flatMap(b=>b.sessions);
    t.assertions.assert(online.length===1,"one rename retransmitted unrelated summary rows");
    const cache=first.map(r=>online.find(next=>next.summary.id===r.summary.id)??r);
    stop();
    const unchanged=await follow(known(cache));
    t.assertions.assert(unchanged.length===0,"quiet reconnect retransmitted cached summaries");
    stop();
    await o.client.call({type:"session.rename",payload:{sessionId:target,title:"changed while browser closed"}});
    await o.client.call({type:"session.delete",payload:{sessionId:deleted}});
    const changed=await follow(known(cache));
    const removed=frames.filter(b=>b.snapshot).flatMap(b=>b.removedSessions);
    t.assertions.assert(changed.length===1&&changed[0]?.summary.id===target&&changed[0].summary.title==="changed while browser closed"
      && removed.length===1&&removed[0]?.id===deleted,"conditional repair lost a rename or retained a deleted reference");
    const current=cache.filter(r=>r.summary.id!==deleted).map(r=>changed.find(next=>next.summary.id===r.summary.id)??r);
    stop();
    const oldInstance=o.client.identity?.daemonInstanceId;
    o.client.close();o.daemon.stop();await o.mock.stop();
    o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
    t.assertions.assert(o.client.identity?.daemonInstanceId!==oldInstance,"cold recovery did not create another daemon instance");
    const cold=await follow(known(current));
    t.assertions.assert(cold.length===0&&!frames.some(b=>b.sessions.some(r=>r.summary.id===deleted)),"new process retransmitted unchanged content or resurrected a deleted row");
    t.note(JSON.stringify({activities:13,onlineChangedRows:online.length,quietRepairRows:unchanged.length,closedChangedRows:changed.length,removed:removed.length,coldChangedRows:cold.length}));
  }finally{stop();o.client.close();o.daemon.stop();await o.mock.stop();}
});

defineSpecialty({...base,
  id:"specialty.daemon.catalog-sync.large-snapshot",
  title:"A directory larger than RPC, event and Writer capacity completes in bounded parts",
  oracle:"3500 real projected activities, with multibyte descriptions and previews, deliver more than 4 MiB through bounded catalog parts, remain unique and complete, and another control read succeeds while the snapshot is transferred",
  catches:["initial catalog exceeds one RPC","single event exceeds receiver capacity","queued catalog permits deadlock the Writer","large activity snapshot silently truncates"],
  expectedDurationMs:30000,timeoutMs:180000,
},async t => {
  const o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let stop=()=>{};
  try {
    const seed=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    const home=join(o.workspaceRoot,".genethub"),sessions=join(home,"sessions");
    const model=JSON.parse(readFileSync(join(sessions,seed,"meta.json"),"utf8"));
    const expected=new Set<string>(),projection:Record<string,unknown>={};
    for(let n=0;n<3500;n++) {
      const id=`s_capacity_${n}`;expected.add(id);mkdirSync(join(sessions,id));
      writeFileSync(join(sessions,id,"meta.json"),JSON.stringify({...model,id,title:`大目录 ${n}`,titleLocked:true,
        description:"容量验证文字".repeat(30),messagePreview:{itemId:"preview",text:"历史消息摘要".repeat(33),atMs:Date.now()},updatedAtMs:Date.now()}));
      projection[id]={source:"q",active:true,pending:1,ready:0,unknown:0,updatedAtMs:Date.now()};
    }
    writeFileSync(join(home,"coordination-source.json"),JSON.stringify({version:1,source:"q"}));
    const document=JSON.stringify({version:1,source:"q",revision:1,updatedAtMs:Date.now(),receivedAtMs:Date.now(),sessions:projection});
    t.assertions.assert(Buffer.byteLength(document)<=524288,"legitimate coordination fixture exceeds its public file budget");
    writeFileSync(join(home,"session-coordination.json"),document);
    t.assertions.assert(o.client.identity?.features?.includes("catalog.sync.v1")===true,"directory topic artifact missing");
    // File enumeration may overlap fixture creation. Observe the complete
    // read set through bounded public pages before measuring the snapshot.
    await t.tools.waitUntil(async()=>{
      const indexed=new Set<string>();let cursor:string|null=null;
      do {
        const r=await o.client.call({type:"session.page",payload:{includeArchived:true,requests:[{workspaceId:o.workspaceId,cursor,limit:100}]}});
        if(r?.type!=="sessionPages"||r.data[0]?.error)return false;
        for(const row of r.data[0]!.sessions)if(expected.has(row.id))indexed.add(row.id);
        cursor=r.data[0]!.nextCursor;
      }while(cursor);
      return indexed.size===3500;
    },12000);
    const received=new Set<string>();let rows=0,bytes=0,maxPart=0,parts=0;
    const began=performance.now();
    const sub=o.client.followCatalog({known:()=>({sessions:[],workspaces:[]}),onUnavailable:()=>{},onBatch:batch=>{
      if(!batch.snapshot)return;const size=Buffer.byteLength(JSON.stringify(batch));bytes+=size;maxPart=Math.max(maxPart,size);parts++;
      for(const row of batch.sessions){rows++;received.add(row.summary.id);}
    }});stop=sub.stop;
    const process=o.client.call({type:"process.workspaceList",payload:{workspaceId:o.workspaceId}},{timeoutMs:30000});
    void process.catch(()=>{});
    await sub.ready;
    const control=await process;
    t.assertions.assert(control?.type==="processes","catalog blocked control traffic");
    t.note(JSON.stringify({activities:rows,parts,bytes,maxPart,elapsedMs:Math.round(performance.now()-began)}));
    t.assertions.assert(bytes>4*1024*1024&&maxPart<140000&&parts>32,"fixture did not cross the Writer/event/RPC capacity boundary");
    t.assertions.assert(rows===3500&&received.size===3500&&[...received].every(id=>expected.has(id)),"large initial activity set is incomplete or duplicated");
  }finally{stop();o.client.close();o.daemon.stop();await o.mock.stop();}
});


defineSpecialty({...base,
  id:"specialty.daemon.catalog-sync.quiet-last-update",
  title:"An oversized live directory change repairs its final state without a later update",
  oracle:"A real 1300-row change exceeds the online part budget and invalidates the paused Fabric reader; after the producer stops, resuming repairs all current rows on the same logical connection without waiting for another update",
  catches:["last missed directory update waits forever for another event","directory lag recovery polls history bodies","slow reader blocks foreground source"],
  surfaces:[...base.surfaces,"relay","tcp"],
  expectedDurationMs:25000,timeoutMs:180000,
},async t=>{
  const pool=await openFabricPool(t,1,1);const o=pool.opened;pool.clients[0]!.close();
  let peer:Client|undefined,socket:WebSocket|undefined,stop=()=>{},keepAlive:ReturnType<typeof setInterval>|undefined;
  try{
    const seed=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);
    const home=join(o.workspaceRoot,".genethub"),sessions=join(home,"sessions");
    const model=JSON.parse(readFileSync(join(sessions,seed,"meta.json"),"utf8"));
    const ids=Array.from({length:1300},(_,n)=>`s_lag_${n}`),state=new Map<string,{pending:number;etag:string;workspaceId:string;active:boolean}>();
    for(const id of ids){mkdirSync(join(sessions,id));writeFileSync(join(sessions,id,"meta.json"),JSON.stringify({...model,id,title:id,titleLocked:true,description:"背压验证".repeat(45),messagePreview:{itemId:"p",text:"真实事件".repeat(49),atMs:Date.now()}}));}
    writeFileSync(join(home,"coordination-source.json"),JSON.stringify({version:1,source:"q"}));
    const project=(revision:number)=>writeFileSync(join(home,"session-coordination.json"),JSON.stringify({version:1,source:"q",revision,updatedAtMs:Date.now(),receivedAtMs:Date.now(),sessions:Object.fromEntries(ids.map(id=>[id,{source:"q",active:true,pending:revision,ready:0,unknown:0,updatedAtMs:Date.now()}]))}));
    project(1);
    await t.tools.waitUntil(async()=>{
      const indexed=new Set<string>();let cursor:string|null=null;
      do{const r=await o.client.call({type:"session.page",payload:{requests:[{workspaceId:o.workspaceId,cursor,limit:100}],includeArchived:true}});
        if(r?.type!=="sessionPages"||r.data[0]?.error)return false;
        for(const row of r.data[0]!.sessions)if(ids.includes(row.id))indexed.add(row.id);cursor=r.data[0]!.nextCursor;
      }while(cursor);return indexed.size===1300;
    },12000);
    let resets=0,snapshots=0,initialParts=0,gaps=0,lastRevision=0;const connections:Array<Record<string,unknown>>=[];
    const endpoint=()=>({url:pool.browserFaults[0]!.url,credential:pool.credential});
    // Exercise the explicit live-batch (>16 parts) invalidation path. This
    // is not a claim that this fixture forced Tokio broadcast::Lagged.
    // This is a one-way slow consumer: keep sending real public identity
    // reads while downlink consumption is paused. This uses the workbench's real
    // Fabric route, rather than a paused local development peer's 15s idle
    // expiry. Production heartbeat and queue capacities remain unchanged.
    peer=new Client({...endpoint(),rtcEnabled:false,separateDataChannel:false,redial:async()=>endpoint(),socketFactory:url=>{socket=new WebSocket(url);return socket as unknown as WebSocketLike;},onDiagnostic:event=>{if(event.kind==="connection"){connections.push({state:event.detail.state,closeReason:event.detail.closeReason,errorName:event.detail.errorName});if(connections.length>15)connections.shift();}if(event.detail.operation==="catalog.receive"){
      if(event.detail.resetRequired)resets++;
      const revision=Number(event.detail.revision),previous=Number(event.detail.previousRevision);
      if(event.detail.snapshot)lastRevision=revision;
      else if(!event.detail.resetRequired&&revision>lastRevision){if(previous!==lastRevision)gaps++;lastRevision=revision;}
    }}});
    peer.connect();await t.tools.waitUntil(()=>peer!.connectionState==="ready",10000);
    const sub=peer.followCatalog({known:()=>({sessions:[...state].map(([id,r])=>({id,workspaceId:r.workspaceId,etag:r.etag,active:r.active})),workspaces:[]}),onUnavailable:()=>{},onBatch:b=>{if(b.snapshot&&snapshots===0)initialParts++;if(b.snapshot&&b.complete)snapshots++;for(const ref of b.removedSessions)state.delete(ref.id);for(const row of b.sessions)state.set(row.summary.id,{pending:row.summary.coordination?.pending??0,etag:row.etag,workspaceId:row.summary.workspaceId,active:row.active});}});stop=sub.stop;await sub.ready;
    t.assertions.assert(state.size===1300&&initialParts>16,"fixture must exceed the live batch part budget");
    const logicalOwner=peer.logicalConnectionId;
    const keepAliveReads:Array<Promise<unknown>>=[];
    keepAlive=setInterval(()=>{const read=peer!.call({type:"connection.identity"},{timeoutMs:60000});void read.catch(()=>{});keepAliveReads.push(read);},4000);
    socket!.pause();const start=performance.now();let foregroundMax=0;
    for(let revision=2;revision<=5;revision++){
      project(revision);
      await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:ids[0]!}});return r?.type==="snapshot"&&r.data.summary.coordination?.pending===revision;},6000);
      const at=performance.now();const r=await o.client.call({type:"workspace.list"});foregroundMax=Math.max(foregroundMax,performance.now()-at);
      t.assertions.assert(r?.type==="workspaces","paused directory blocked an independent foreground reader");
    }
    // No writes after this point. Recovery cannot rely on another event.
    socket!.resume();clearInterval(keepAlive);keepAlive=undefined;
    await Promise.all(keepAliveReads);
    await t.tools.waitUntil(()=>state.size===1300&&[...state.values()].every(r=>r.pending===5),45000);
    t.note(JSON.stringify({currentRows:state.size,finalPending:5,resets,gaps,snapshots,initialParts,connections,ownerRetained:peer.logicalConnectionId===logicalOwner,pausedMs:Math.round(performance.now()-start),foregroundMaxMs:Math.round(foregroundMax)}));
    t.assertions.assert(resets>0&&snapshots>1&&peer.logicalConnectionId===logicalOwner,"oversized live-batch invalidation did not repair on the retained connection");
    t.assertions.assert(foregroundMax<2000,"paused directory violated foreground hot-read budget");
  }finally{if(keepAlive)clearInterval(keepAlive);socket?.resume();stop();peer?.close();await pool.dispose();}
});

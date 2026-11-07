import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActivitySessions } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.activity-pages.complete-and-recovery",
  title: "Activity is complete beyond recent history and survives cold recovery without source-clock freshness",
  oracle: "130 older real sessions remain discoverable behind 10,000 metadata records; active cursors reject concurrent reordering; archive/delete update the complete set; stale or unavailable projections stay unknown and a cold daemon recovers current work",
  catches: ["activity filtered after history limit", "only first activity page read", "changed active cursor silently omits work", "source clock masks disconnection", "cold activity reads only opened sessions"],
  tags: ["core","session-pages","activity-pages"], llm: {default:"none"},
  requiredArtifacts: ["genet","genehub-host-local","genehub_guest.wasm"],
  productInterfaces: ["session.page","session.archive","session.delete","session.get","session-coordination.json","@genehub/workbench/client"],
  surfaces: ["daemon","filesystem","workbench-client"], expectedDurationMs:30000,timeoutMs:180000,
  resources:{environments:1,cpu:2,memoryMb:2048,io:2,browser:0},
},async t => {
  let o = await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  try {
    const ids:string[]=[];
    for(let i=0;i<130;i++) ids.push(await t.flows.main.createBuiltinSession(o.client,o.workspaceId));
    const home=join(t.env.workspace,".genethub"), projection=join(home,"session-coordination.json");
    const source="fixture.single-source";
    const sessions=Object.fromEntries(ids.map(id=>[id,{source,taskId:null,active:true,pending:1,ready:0,unknown:0,updatedAtMs:Date.now()+86400000,stale:false}]));
    const publish=(revision:number,receivedAtMs=Date.now())=>writeFileSync(projection,JSON.stringify({version:1,source,revision,receivedAtMs,updatedAtMs:Date.now()+86400000,sessions}));
    writeFileSync(join(home,"coordination-source.json"),JSON.stringify({version:1,source}));publish(1);
    const example=JSON.parse(readFileSync(join(home,"sessions",ids[0]!,"meta.json"),"utf8"));
    // Compatible metadata writer: old business histories are real on-disk
    // records, not mocked RPC responses or injected runtime state.
    const grow=(from:number,to:number)=>{for(let i=from;i<to;i++){
      const id="s_history"+String(i).padStart(8,"0"),dir=join(home,"sessions",id);mkdirSync(dir,{recursive:true});
      writeFileSync(join(dir,"meta.json"),JSON.stringify({...example,id,title:"inactive history "+i,titleLocked:true,updatedAtMs:Date.now()-1000}));
    }};
    const measure=async(label:string)=>{const began=performance.now(),rows=await readActivitySessions(o.client);t.assertions.assert(rows.length===130&&new Set(rows.map(s=>s.id)).size===130&&ids.every(id=>rows.some(s=>s.id===id)),label+" lost older activity or duplicated a page");t.note(JSON.stringify({label,activity:rows.length,elapsedMs:Math.round(performance.now()-began)}));};
    grow(0,870);await new Promise(resolve=>setTimeout(resolve,5100));await measure("1000 metadata refresh");
    grow(870,9870);await new Promise(resolve=>setTimeout(resolve,5100));await measure("10000 metadata refresh");await measure("10000 metadata hot");
    const first=await o.client.call({type:"session.page",payload:{requests:[{workspaceId:null,limit:100,cursor:null,activeOnly:true}],includeArchived:true}});
    if(first?.type!=="sessionPages"||!first.data[0]?.nextCursor)throw Error("activity did not expose a second page");
    await o.client.call({type:"session.rename",payload:{sessionId:ids[0]!,title:"moved during active pagination"}});
    const drift=await o.client.call({type:"session.page",payload:{requests:[{workspaceId:null,limit:100,cursor:first.data[0].nextCursor,activeOnly:true}],includeArchived:true}});
    t.assertions.assert(drift?.type==="sessionPages"&&Boolean(drift.data[0]?.error?.includes("activity changed")),"changed active cursor masqueraded as a complete page");
    await o.client.call({type:"session.archive",payload:{sessionId:ids[0]!,archived:true}});await measure("archived obligations retained");
    o.client.close();o.daemon.stop();await o.mock.stop();o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
    await measure("10000 metadata cold recovery");
    publish(2,Date.now()-130000);
    await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:ids[0]!}});return r?.type==="snapshot"&&r.data.summary.coordination?.stale===true;},10000);
    // Re-reading does not extend receiving-side freshness despite future source time.
    const stale=await readActivitySessions(o.client);t.assertions.assert(stale.find(s=>s.id===ids[0])?.coordination?.stale,"cache read renewed a stale projection");
    publish(3);await t.tools.waitUntil(async()=>{const r=await o.client.call({type:"session.get",payload:{sessionId:ids[0]!}});return r?.type==="snapshot"&&r.data.summary.coordination?.stale===false;},10000);
    await o.client.call({type:"session.delete",payload:{sessionId:ids[1]!}});
    const after=await readActivitySessions(o.client);t.assertions.assert(after.length===129&&!after.some(s=>s.id===ids[1]),"deleted activity remained in a warm result");
    t.note("130 older sessions, complete multi-page activity, 1k/10k warm and 10k cold metadata, concurrent cursor rejection, archived obligations, deletion and clock-independent staleness");
  } finally{
    const log=join(t.env.data,"logs/daemon.log");
    if(existsSync(log))for(const line of readFileSync(log,"utf8").split("\n").filter(line=>line.includes("session_catalog_slow")).slice(-5)){
      try{const row=JSON.parse(line),f=row.fields??row;t.note(JSON.stringify(Object.fromEntries(["event","sessions","metadata_bytes","entries_read","inline_ms","yield_wait_ms","max_yield_ms","elapsed_ms"].map(key=>[key,f[key]]))));}catch{/* non-JSON log does not alter the oracle */}
    }
    o.client.close();o.daemon.stop();await o.mock.stop();
  }
});

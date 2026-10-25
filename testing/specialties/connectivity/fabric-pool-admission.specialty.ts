import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

for(const lanes of [1,4])defineSpecialty({
  id: `specialty.fabric-pool.global-admission${lanes===1?"-single":""}`, title: `${lanes} node uplinks retain one global logical-owner capacity and release closed slots`,
  oracle: "Real saturation across four node lanes retains all old peers, does not exceed 32 logical owners including the local owner, and one closed slot admits a replacement",
  catches: ["each new physical lane independently multiplies the global owner budget", "one saturated lane evicts healthy peers", "closing a peer retains its global reservation"],
  tags: ["fabric-pool", "authorization", "capacity"], llm: { default: "none" }, expectedDurationMs: 30000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 }, surfaces: ["daemon", "relay", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
},async t=>{
  const pool=await openFabricPool(t,lanes,lanes);
  let refused:Client|undefined;
  try {
    const connect=async(lane:number)=>{
      let exhausted=false;
      const peer=new Client({separateDataChannel:false,url:pool.browserFaults[lane%lanes]!.url,credential:pool.credential,rtcEnabled:false,
        socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike,onError(error){if(String(error).includes("ResourceExhausted")||String(error).includes("exhausted"))exhausted=true;}});
      peer.connect();
      await t.tools.waitUntil(()=>peer.connectionState==="ready"||exhausted,8000).catch(()=>undefined);
      return {peer,exhausted};
    };
    let exhausted=false;
    for(let i=lanes;i<40;i++) {
      const result=await connect(i);
      if(result.peer.connectionState!=="ready"){refused=result.peer;exhausted=result.exhausted;break;}
      pool.clients.push(result.peer);
    }
    t.note(JSON.stringify({phase:"saturated",lanes,remoteOwners:pool.clients.length,totalOwners:pool.clients.length+1,exhausted}));
    t.assertions.assert(exhausted&&pool.clients.length+1===32,"four lanes did not preserve the global owner ceiling");
    for(const peer of pool.clients)t.assertions.assert((await peer.call({type:"workspace.list"}))?.type==="workspaces","saturation evicted a previously admitted owner");
    refused?.close();
    pool.clients.pop()!.close();
    const start=performance.now();const replacement=await connect(0);pool.clients.push(replacement.peer);
    // A first refusal can race the closing peer; observe the original 8-second eventual-admission budget.
    await t.tools.waitUntil(()=>replacement.peer.connectionState==="ready",Math.max(1,8000-(performance.now()-start))).catch(()=>undefined);
    t.note(JSON.stringify({phase:"replacement",lanes,state:replacement.peer.connectionState,exhausted:replacement.exhausted,elapsedMs:Math.round(performance.now()-start),allExistingUsable:true}));
    t.assertions.assert(replacement.peer.connectionState==="ready","a closed owner did not release global capacity");
    t.note(JSON.stringify({nodeUplinks:lanes,totalOwners:pool.clients.length+1,globalCeilingPreserved:true,allExistingUsable:true,replacementMs:Math.round(performance.now()-start)}));
  }finally{refused?.close();await pool.dispose();}
});


defineSpecialty({
  id: "specialty.fabric-pool.automatic-capacity-fallback",
  title: "Automatic body admission falls back without evicting the last control owner",
  oracle: "At 32 global logical owners, secondary admission ends within 4.5 seconds; control remains usable and repeated data preparation respects the cooldown without extra dials",
  catches: ["automatic lanes multiply or evict global owners", "body admission prevents control readiness", "full capacity produces a ticket storm"],
  tags: ["fabric-pool", "fabric-automatic", "capacity"], llm: { default: "none" },
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], expectedDurationMs: 20000, timeoutMs: 90000,
}, async t => {
  const pool = await openFabricPool(t, 2, 1);
  let automatic: Client | undefined;
  try {
    for(let i=0;i<29;i++) {
      const peer=new Client({url:pool.browserFaults[0]!.url,credential:pool.credential,separateDataChannel:false,rtcEnabled:false,socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike});
      pool.clients.push(peer);peer.connect();await t.tools.waitUntil(()=>peer.connectionState==="ready",8000);
    }
    automatic=new Client({url:pool.browserFaults[0]!.url,credential:pool.credential,rtcEnabled:false,socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike});
    automatic.connect();await t.tools.waitUntil(()=>automatic!.connectionState==="ready",8000);
    const owner=automatic.logicalConnectionId, began=performance.now();
    t.assertions.assert(await automatic.prepareDataChannel()===automatic,"a body owner was admitted beyond the global budget");
    const elapsed=performance.now()-began;
    t.assertions.assert(elapsed<4500 && (await automatic.call({type:"workspace.list"}))?.type==="workspaces","body refusal blocked control");
    await new Promise(r=>setTimeout(r,250));const before=pool.link.stats().accepted;
    for(let i=0;i<10;i++)t.assertions.assert(await automatic.prepareDataChannel()===automatic,"cooldown unexpectedly admitted a body owner");
    await new Promise(r=>setTimeout(r,1000));
    t.assertions.assert(pool.link.stats().accepted===before && automatic.logicalConnectionId===owner,"capacity cooldown leaked dials or replaced control");
    for(const peer of pool.clients)t.assertions.assert((await peer.call({type:"workspace.list"}))?.type==="workspaces","body refusal evicted another owner");
    t.note(JSON.stringify({totalOwners:32,fallbackMs:Math.round(elapsed),retainedControl:true,cooldownDials:0}));
  } finally {automatic?.close();await pool.dispose();}
});

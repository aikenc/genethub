import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, daemonEndpoint } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const resources={environments:1,cpu:2,memoryMb:2048,io:1,browser:0};
for(const nodes of [1,2])for(const direction of ["forward","reverse","both"] as const)defineSpecialty({
  id:`specialty.fabric-pool.half-open-${direction}-n${nodes}`,title:`Actual production-timeout recovery of a silently held ${direction} node carrier, ${nodes} uplinks`,
  oracle:"The old TCP is not cut by the test; the real Relay/daemon detects its missing liveness, independently dials a new node carrier within 145 seconds, and the affected public Client recovers the same workspace without daemon restart or repeated source command",
  catches:["120-second timeout was replaced with a shortened test clock", "half-open was tested only by cutting a socket", "online boolean confused with recovered business RPC", "new lane loss stops unrelated lanes"],
  tags:["fabric-pool","half-open","connection-recovery"],llm:{default:"none"},expectedDurationMs:150000,timeoutMs:190000,
  resources,surfaces:["daemon","relay","workbench-client","tcp"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],retention:true,
},async t=>{
  const pool=await openFabricPool(t,nodes,nodes),o=pool.opened,affected=pool.clients.at(-1)!;
  try{
    const pid=daemonEndpoint(o.daemon).localServerProof.pid;
    const marked=t.flows.main.startShell(affected,{workspaceId:o.workspaceId,cwd:o.workspaceRoot,timeoutMs:5000,argv:["python3","-c","import pathlib;pathlib.Path('half-open-once').open('a').write('once\\n');print('stored')"]});
    const done=await marked.result;t.assertions.assert(t.flows.main.shellExit(done.frames)?.code===0,"initial source command failed");
    const target=pool.nodeFlowIds.at(-1)!,before=pool.link.stats().accepted,heldBefore=pool.link.connections().find(c=>c.id===target)!.bytes;
    pool.link.holdConnection(target,direction);const start=performance.now();let offlineObserved=false,newCarrierMs:number|null=null;
    while(performance.now()-start<145000){
      const state=await o.client.call({type:"device.list"});if(state?.type==="devices"&&state.data.remote.channels?.at(-1)?.online===false)offlineObserved=true;
      if(pool.link.stats().accepted>before){newCarrierMs=Math.round(performance.now()-start);break;}await pause(500);
    }
    await t.tools.waitUntil(()=>affected.connectionState==="ready",15000).catch(()=>undefined);
    let recovered=false;try{const r=await affected.call({type:"workspace.list"});recovered=r?.type==="workspaces"&&r.data.some(w=>w.id===o.workspaceId);}catch{/* Retain measured failure. */}
    const heldAfter=pool.link.connections().find(c=>c.id===target)!.bytes;
    const log=readFileSync(join(t.env.data,"logs","daemon.log"),"utf8");
    const silentTimeout=(log.match(/the Fabric relay sent nothing for 120s/g)??[]).length;
    const marker=readFileSync(join(o.workspaceRoot,"half-open-once"),"utf8"),sameDaemon=daemonEndpoint(o.daemon).localServerProof.pid===pid;
    t.note(JSON.stringify({nodes,direction,newCarrierMs,offlineObserved,silentTimeout,recovered,sameDaemon,sourceExactlyOnce:marker==="once\n",heldBytesBefore:heldBefore,heldBytesAfter:heldAfter,diagnostics:pool.diagnostics.slice(-10)}));
    t.assertions.assert(newCarrierMs!==null&&newCarrierMs<145000&&recovered&&sameDaemon&&marker==="once\n","silent carrier did not automatically recover business access without restart/re-execution");
    t.assertions.assert((direction==="reverse"||direction==="both")?heldAfter[1]===heldBefore[1]:heldAfter[0]===heldBefore[0],"the selected old carrier direction was not actually silent");
  }finally{pool.link.releaseConnections();await pool.dispose();}
});

defineSpecialty({
  id:"specialty.fabric-pool.healthy-idle",title:"Two healthy node carriers remain stable over two production 120-second silence windows without business traffic",
  oracle:"Only ordinary heartbeat/probe traffic runs for 250 seconds; both original node carriers and logical owners remain, and subsequent real RPC reads the original workspace",
  catches:["healthy idle connection is mistaken for half-open", "new recovery destroys an unexpired idle owner"],
  tags:["fabric-pool","half-open","connection-recovery"],llm:{default:"none"},expectedDurationMs:260000,timeoutMs:310000,
  resources,surfaces:["daemon","relay","workbench-client","tcp"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],retention:true,
},async t=>{
  const pool=await openFabricPool(t,2,2);try{
    const owners=pool.clients.map(c=>c.logicalConnectionId),before=pool.link.stats().accepted,start=performance.now();await pause(250000);
    const replies=await Promise.all(pool.clients.map(c=>c.call({type:"workspace.list"}))),sameOwners=pool.clients.every((c,i)=>c.logicalConnectionId===owners[i]);
    t.note(JSON.stringify({idleMs:Math.round(performance.now()-start),nodeSocketsBefore:before,nodeSocketsAfter:pool.link.stats().accepted,sameOwners,repliesOk:replies.every(r=>r?.type==="workspaces")}));
    t.assertions.assert(pool.link.stats().accepted===before&&sameOwners&&replies.every(r=>r?.type==="workspaces"),"healthy idle carriers or owners were replaced");
  }finally{await pool.dispose();}
});

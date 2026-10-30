import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, collectShellResult } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";
import { startKernelNetem } from "../../framework/drivers/kernel-netem.ts";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
for(const nodes of [1,2])for(const outage of [false,true])defineSpecialty({
  id:`specialty.fabric-pool.kernel-${outage?"outage":"loss"}-n${nodes}`,title:`Actual kernel jitter/loss and TCP retransmission, ${nodes} node channels${outage?", temporary 100% outage":""}`,
  oracle:"One unchanged source per producer, exact full bytes and successful exit after restoration; actual kernel packet drops and TCP retransmits prove the injected condition; management recovers after loss/outage",
  catches:["TCP cuts were mislabeled as packet loss", "synthetic proxy misses kernel TCP recovery", "extra channels silently add bandwidth", "resuming the link repeats source processes"],
  tags:["fabric-pool","kernel-netem"],llm:{default:"none"},expectedDurationMs:50000,timeoutMs:150000,
  resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:0,pool:"exclusive"},
  isolation:{networkNamespace:true},requirements:[
    {kind:"command",env:"GENEHUB_TEST_UNSHARE",args:["--user","--map-root-user","--net","--","true"]},
    {kind:"command",env:"GENEHUB_TEST_IP",args:["-V"],contains:"iproute2"},
    {kind:"command",env:"GENEHUB_TEST_TC",args:["-V"],contains:"iproute2"},
  ],surfaces:["daemon","relay","workbench-client","kernel-tcp"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],retention:true,
},async t=>{
  const observedAt=performance.now();
  const closes:Array<{atMs:number;peer:number;phase:unknown;state:unknown;reason:unknown}>=[];
  const pool=await openFabricPool(t,nodes,nodes,false,true,(event,peer)=>{
    if(event.detail.phase!=="carrier-lost"&&event.kind!=="error"&&event.kind!=="connection")return;
    closes.push({atMs:Math.round(performance.now()-observedAt),peer,phase:event.detail.phase,state:event.detail.state,reason:event.detail.reason??event.detail.closeReason??event.detail.errorName});
    if(closes.length>24)closes.shift();
  }),o=pool.opened,control=pool.clients[0]!;
  const owners=pool.clients.map(c=>c.logicalConnectionId);
  const relayCapacity=()=>pool.relay.logTail().split("\n").flatMap(line=>{
    try{const row=JSON.parse(line) as Record<string,unknown>;return row.msg==="fabric: transport-flow capacity refused"?[{reason:row.reason,pendingBytes:row.pendingBytes}]:[];}catch{return [];}
  }).slice(-8);
  const streams:ReturnType<typeof control.openShellStream>[]=[],outputs:Array<Promise<Awaited<ReturnType<typeof collectShellResult>>|null>>=[];
  const outputErrors:Array<{name:string;message:string;code?:string}>=[];
  let netem:ReturnType<typeof startKernelNetem>|undefined,dropTimer:NodeJS.Timeout|undefined,restoreTimer:NodeJS.Timeout|undefined,drainTimer:NodeJS.Timeout|undefined;
  let blackoutApplied=false,blackoutRestored=false;
  try{
    for(let i=0;i<3;i++){
      const body=pool.clients[nodes===1?0:1]!;
      const stream=body.openShellStream({workspaceId:o.workspaceId,cwd:o.workspaceRoot,timeoutMs:120000,argv:["python3","-c",`import pathlib,sys,time\npathlib.Path('kernel-starts').open('a').write('${i}\\n')\nwhile not pathlib.Path('kernel-go').exists():time.sleep(.01)\nfor n in range(512):\n sys.stdout.write('${String.fromCharCode(65+i)}'*16384);sys.stdout.flush();time.sleep(.005)`]});
      streams.push(stream);await stream.finish();await stream.responseHead;outputs.push(collectShellResult(stream).catch((error:unknown)=>{
        outputErrors[i]={name:error instanceof Error?error.name:typeof error,message:error instanceof Error?error.message.slice(0,200):"non-Error rejection",...(error instanceof Error&&"code" in error?{code:String(error.code)}:{})};
        return null;
      }));
    }
    netem=startKernelNetem(Number(new URL(pool.relay.origin).port));
    const start=performance.now();writeFileSync(join(o.workspaceRoot,"kernel-go"),"go");
    if(outage){dropTimer=setTimeout(()=>{blackoutApplied=true;netem!.setLoss(100);},5000);restoreTimer=setTimeout(()=>{netem!.setLoss(1);blackoutRestored=true;},10000);}
    const samples:Array<{atMs:number;ms:number;ok:boolean}>=[];
    while(performance.now()-start<26000){
      const atMs=Math.round(performance.now()-start),began=performance.now();let ok=false;
      try{ok=(await control.call({type:"workspace.list"}))?.type==="workspaces";}catch{/* A full outage may exceed a single bounded RPC. */}
      samples.push({atMs,ms:Math.round(performance.now()-began),ok});await pause(250);
    }
    const kernel=netem.stats();netem.restore();
    t.note(JSON.stringify({phase:"restored-without-queue-destruction",before:kernel,after:netem.stats()}));
    t.note(JSON.stringify({phase:"loaded",nodes,outage,blackoutApplied,blackoutRestored,kernel,samples,outputErrors,closes}));
    const results=await Promise.race([Promise.all(outputs),new Promise<null>(resolve=>{drainTimer=setTimeout(()=>resolve(null),40000);})]);if(drainTimer)clearTimeout(drainTimer);
    const exactBody=(r:NonNullable<Awaited<ReturnType<typeof collectShellResult>>>,i:number)=>{
      const text=t.flows.main.shellText(r.frames,"stdout");
      return Buffer.byteLength(text)===8*1024*1024&&createHash("sha256").update(text).digest("hex")===createHash("sha256").update(Buffer.alloc(8*1024*1024,65+i)).digest("hex")&&t.flows.main.shellExit(r.frames)?.code===0;
    };
    const exact=results?.length===3&&results.every((r,i)=>r!==null&&exactBody(r,i));
    const body=pool.clients[nodes===1?0:1]!;
    const freshBody=(await body.call({type:"workspace.list"}))?.type==="workspaces";
    const starts=readFileSync(join(o.workspaceRoot,"kernel-starts"),"utf8").trim().split("\n").sort();
    let recoveryError:string|undefined;
    const recovered=await control.call({type:"workspace.list"}).then(r=>r?.type==="workspaces",(error:unknown)=>{
      recoveryError=error instanceof Error?`${error.name}: ${error.message.slice(0,200)}`:"non-Error rejection";return false;
    });
    const after=samples.filter(s=>s.atMs>12000),sorted=samples.filter(s=>s.ok).map(s=>s.ms).sort((a,b)=>a-b);
    t.note(JSON.stringify({phase:"result",nodes,outage,exact24MiB:exact,freshBody,starts,kernel,recovered,recoveryError,outputErrors,closes,retained:pool.clients.map((c,i)=>c.logicalConnectionId===owners[i]),errors:samples.filter(s=>!s.ok).length,p95Ms:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]??null,successfulAfterRecovery:after.filter(s=>s.ok).length,diagnostics:pool.diagnostics.slice(-10)}));
    t.assertions.assert(kernel.dropped>0&&kernel.retransmits>0,"kernel loss/retransmission was not actually observed");
    t.assertions.assert(exact&&starts.join(",")==="0,1,2","real TCP recovery lost bytes or repeated source processes");
    t.assertions.assert(freshBody,"the body endpoint did not accept a fresh request after restoration");
    t.assertions.assert(pool.clients.every((c,i)=>c.logicalConnectionId===owners[i]),"kernel loss reset an original endpoint despite restored TCP");
    t.assertions.assert(recovered,"management did not recover after restoration");
    t.assertions.assert(!outage||(blackoutApplied&&blackoutRestored),"the complete temporary outage did not occur");
  }finally{t.note(JSON.stringify({phase:"kernel-final",nodes,outage,outputErrors,closes,relayCapacity:relayCapacity(),states:pool.clients.map(c=>c.connectionState)}));if(dropTimer)clearTimeout(dropTimer);if(restoreTimer)clearTimeout(restoreTimer);if(drainTimer)clearTimeout(drainTimer);netem?.stop();streams.forEach(s=>s.reset(1));await pool.dispose();}
});

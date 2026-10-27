import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve,ms));
const q = (a: number[]) => { const s=[...a].sort((x,y)=>x-y); return { n:s.length, p50: Math.round(s[Math.ceil(s.length*.5)-1]??0),p95: Math.round(s[Math.ceil(s.length*.95)-1]??0),p99: Math.round(s[Math.ceil(s.length*.99)-1]??0),max:Math.round(s.at(-1)??0) }; };
for (const [browsers,nodes,automatic,members] of [[1,1,false,20],[2,1,false,20],[2,2,false,20],[4,4,false,20],[2,2,true,20],[2,2,true,10]] as const) defineSpecialty({
  id: automatic ? members === 10 ? "specialty.fabric-pool.team-automatic-100" : "specialty.fabric-pool.team-automatic" : `specialty.fabric-pool.team-b${browsers}-n${nodes}`,
  title: `${automatic ? "Automatic product routing:" : browsers === 1 ? "Legacy single-channel negative control:" : "Fixed comparison:"} 10 machines, ${10*members} full transcript subscriptions, ${browsers} browser / ${nodes} node channels`,
  oracle: `All ${10*members} fixed-output Agent tasks are started in one burst and source completions remain unique; real remote consumers repair snapshots/replay and recover every exact final reply; production and separated topologies require management p95 below 1500ms; the legacy 1/1 negative control measures degradation without claiming the production latency SLO`,
  catches: ["full subscriptions were replaced with a lighter workload", "node uplink remains shared", "resync callback ignored a valid snapshot", "body completion mistaken for source task loss"],
  tags: ["fabric-pool", "team-scale", "all-subscriptions", ...(members === 10 ? ["team-scale-100"] : [])], llm: { default: "none" }, expectedDurationMs: 160000, timeoutMs: 360000,
  stages: ["fleet", "burst", "recover"], resources: { environments: 1, cpu: 12, memoryMb: 16384, io: 2, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "agent-sdk", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const started = new Map<string, { machine: number; at: number; operation: string }>();
  const measured: Array<{ machine: number; requestId: string; operation: string; outcome: unknown; start: number; finish: number; duration: number }> = [];
  const fleet=await t.stage("fleet",()=>openScaleFleet(t,10,members,!automatic && browsers > 1,{ nodeChannels:nodes,dataChannels:browsers === 4 ? 3 : 1,automatic,bothLegs:automatic,
    ...(automatic ? { nativeLog: "warn,diagnostic=debug", onDiagnostic(machine, event) {
      if (event.kind !== "operation" || !["workspace.list", "session.get"].includes(String(event.detail.operation)) || typeof event.detail.requestId !== "string") return;
      const id=event.detail.requestId;
      if (event.detail.phase === "start") started.set(id,{ machine, at: Date.parse(event.at), operation: String(event.detail.operation) });
      else if (event.detail.phase === "finish") { const first=started.get(id); started.delete(id); if(first && measured.length<512) measured.push({ machine,requestId:id,operation:first.operation,outcome:event.detail.outcome,start:first.at,finish:Date.parse(event.at),duration:Number(event.detail.durationMs??0) }); }
    } } : {}),
  }));
  let liveCompletions=0,repairCompletions=0,repairs=0; const seen=new Set<string>();
  const before=fleet.link.stats();
  try {
    for (const node of fleet.nodes) for (let i=0;i<node.sessions.length;i++) {
      const id=node.sessions[i]!,client=node.dataClients[i%node.dataClients.length]!;
      await client.subscribe(id,{ onEvent(event) { if (event.event.type==="turnCompleted" && !seen.has(id)) { seen.add(id);liveCompletions++; } },
        onResync(snapshot,replayed) { repairs++; const s=snapshot as { summary?:{status?:string;latestReply?:unknown} }; if (!seen.has(id) && (s.summary?.status==="idle" && s.summary.latestReply || replayed.some(e=>e.event.type==="turnCompleted"))) {seen.add(id);repairCompletions++;} } });
    }
    fleet.link.setProfile({bandwidthMbps:5,rttMs:200});
    const rpc:number[]=[],replyBytes:number[]=[];let errors=0;
    const start=performance.now();
    const sends=Promise.allSettled(Array.from({length:members},(_,i)=>fleet.nodes.map(node=>t.flows.main.sendPrompt(node.control,node.sessions[i]!,"Emit the deterministic 200-chunk reply."))).flat());
    await t.stage("burst",async()=>{
      while (performance.now()-start<30000) {
        await Promise.all(fleet.nodes.map(async node=>{const began=performance.now();let bytes=0,elapsed:number;try{const r=await node.control.call({type:"workspace.list"});elapsed=performance.now()-began;if(r?.type!=="workspaces")errors++;bytes=Buffer.byteLength(JSON.stringify(r)??"");}catch{elapsed=performance.now()-began;errors++;}rpc.push(elapsed);replyBytes.push(bytes);}));
        await pause(500);
      }
    });
    const busy=fleet.link.stats();
    t.note(JSON.stringify({phase:"loaded",browsers,nodes,fullSubscriptions:10*members,rpc:q(rpc),replyBytes:q(replyBytes),errors,liveCompletions,repairCompletions,repairs,
      sourceAnswered:fleet.nodes.map(n=>readControlledAgentJournal(n.agent).filter(e=>e.event==="answered").length),nodeTcpAccepted:busy.accepted,
      bytes:busy.forwardedBytes.map((v,i)=>v-before.forwardedBytes[i]!),peakQueuedBytes:busy.peakQueuedBytes}));
    fleet.link.setProfile({bandwidthMbps:1000,rttMs:0});
    if (automatic) {
      const logs=fleet.nodes.map(node=>stripVTControlCharacters(readFileSync(join(node.lease.data,"logs","daemon.log"),"utf8")).split("\n"));
      const timings=measured.filter(call=>call.operation==="workspace.list").sort((a,b)=>b.duration-a.duration).slice(0,2).map(call=>{
        const lines=logs[call.machine]!.filter(line=>line.includes(call.requestId));
        const chunk=lines.find(line=>line.includes("RPC request chunk received"));
        const credited=lines.find(line=>line.includes("RPC request credit returned"));
        const dispatched=lines.find(line=>line.includes("RPC request FIN dispatched"));
        const decoded=lines.find(line=>line.includes("RPC request decoded"));
        const prepared=lines.find(line=>line.includes("RPC response prepared"));
        const completed=lines.find(line=>line.includes("RPC exchange completed"));
        const timestamp=(line:string|undefined)=>line ? Date.parse(line.split(" ")[0]!) : NaN;
        const end=timestamp(completed),duration=Number(/duration_ms=(\d+)/.exec(completed??"")?.[1]??NaN);
        return { machine:call.machine,clientMs:call.duration,ingressMs:Math.round(end-duration-call.start),
          prepareMs:Math.round(timestamp(prepared)-(end-duration)),bodyMs:Math.round(timestamp(decoded)-(end-duration)),
          chunkMs:Math.round(timestamp(chunk)-(end-duration)),creditMs:Math.round(timestamp(credited)-timestamp(chunk)),
          finDispatchMs:Math.round(timestamp(dispatched)-timestamp(credited)),finWakeMs:Math.round(timestamp(decoded)-timestamp(dispatched)),
          finWaitMs:Math.round(timestamp(decoded)-timestamp(credited)),routerMs:Math.round(timestamp(prepared)-timestamp(decoded)),egressMs:Math.round(call.finish-timestamp(prepared)),
          serverMs:duration,completionLagMs:Math.round(end-call.finish),dispatched:!!dispatched,chunk:!!chunk,credited:!!credited,decoded:!!decoded,prepared:!!prepared,completed:!!completed };
      });
      t.note(JSON.stringify({phase:"causal-rpc-timings",timings}));
    }
    const sent=await sends; const expected=Array.from({length:200},(_,i)=>`f${i} `).join("");
    let exactReplies=0,remoteCompleted=0,verificationError="";
    await t.stage("recover",async()=>{
      await Promise.all(fleet.nodes.map(async node=>{
        const r=await node.control.call({type:"session.list",payload:{workspaceId:null,includeArchived:false}});
        if(r?.type==="sessions") remoteCompleted+=r.data.filter(s=>s.status==="idle"&&!!s.latestReply).length;
        for(let i=0;i<node.sessions.length;i++) {
          const reply=await node.dataClients[i%node.dataClients.length]!.call({type:"session.get",payload:{sessionId:node.sessions[i]!,recentRounds:1}});
          if(reply?.type==="snapshot") { const text=reply.data.items.filter(item=>item.type==="assistantMessage").map(item=>item.type==="assistantMessage"?item.text:"").join(""); if(createHash("sha256").update(text).digest("hex")===createHash("sha256").update(expected).digest("hex"))exactReplies++; }
        }
      }));
    }).catch(error=>{verificationError=error instanceof Error?error.message:String(error);});
    const sourceCounts=fleet.nodes.map(node=>{const journal=readControlledAgentJournal(node.agent);return {prompt:journal.filter(e=>e.event==="prompt").length,answered:journal.filter(e=>e.event==="answered").length};});
    t.note(JSON.stringify({phase:"result",browsers,nodes,rpc:q(rpc),errors,sends:sent.filter(s=>s.status==="fulfilled").length,remoteCompleted,exactReplies,sourceCounts,liveCompletions,repairCompletions,repairs,verificationError}));
    if (automatic) {
      // Read existing public-operation/Native RPC timing before fixture disposal.
      // Bound evidence to four slow reads and two old catalog samples; keep
      // the original workload, failure and all protection assertions intact.
      const recentLogs=fleet.nodes.map(node=>{
        try {return stripVTControlCharacters(readFileSync(join(node.lease.data,"logs","daemon.log"),"utf8")).split("\n");}
        catch {return [] as string[];}
      });
      const bodyTimings=measured.filter(call=>call.operation==="session.get").sort((a,b)=>b.duration-a.duration).slice(0,4).map(call=>{
        const lines=recentLogs[call.machine]!.filter(line=>line.includes(call.requestId));
        const at=(label:string)=>{const line=lines.find(row=>row.includes(label));const value=line?Date.parse(line.split(" ")[0]!):NaN;return Number.isFinite(value)?Math.round(value-call.start):null;};
        const prepared=lines.find(line=>line.includes("RPC response prepared"));
        return {machine:call.machine,clientMs:call.duration,outcome:typeof call.outcome==="string"?call.outcome:null,
          chunkMs:at("RPC request chunk received"),finMs:at("RPC request FIN dispatched"),decodedMs:at("RPC request decoded"),preparedMs:at("RPC response prepared"),doneMs:at("RPC exchange completed"),
          responseBytes:prepared?Number(/response_bytes=(\d+)/.exec(prepared)?.[1]??0):null};
      });
      const recovery=fleet.nodes.map((_,machine)=>({machine,
        settled:measured.filter(call=>call.machine===machine&&call.operation==="session.get").length,
        pending:[...started.values()].filter(call=>call.machine===machine&&call.operation==="session.get").length}));
      t.note(JSON.stringify({phase:"snapshot-recovery-causal",bodyTimings,recovery}));
    }
    t.assertions.assert(sourceCounts.every(s=>s.prompt===members&&s.answered===members)&&exactReplies===10*members&&remoteCompleted===10*members&&!verificationError,"source uniqueness or remote final body recovery failed");
    if (browsers === 1) t.note(JSON.stringify({classification:"legacy single-channel negative control",productionLatencyQualified:false,errors,rpc:q(rpc)}));
    else t.assertions.assert(errors===0&&q(rpc).p95<1500,`${10*members} full subscriptions exceeded management p95/availability target`);
  } finally {await fleet.dispose();}
});

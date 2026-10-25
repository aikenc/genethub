import { createHash } from "node:crypto";
import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve,ms));
const q = (a: number[]) => { const s=[...a].sort((x,y)=>x-y); return { n:s.length, p50: Math.round(s[Math.ceil(s.length*.5)-1]??0),p95: Math.round(s[Math.ceil(s.length*.95)-1]??0),p99: Math.round(s[Math.ceil(s.length*.99)-1]??0),max:Math.round(s.at(-1)??0) }; };
for (const [browsers,nodes,automatic] of [[1,1,false],[2,1,false],[2,2,false],[4,4,false],[2,2,true]] as const) defineSpecialty({
  id: automatic ? "specialty.fabric-pool.team-automatic" : `specialty.fabric-pool.team-b${browsers}-n${nodes}`,
  title: `${automatic ? "Automatic product routing:" : browsers === 1 ? "Legacy single-channel negative control:" : "Fixed comparison:"} 10 machines, 200 full transcript subscriptions, ${browsers} browser / ${nodes} node channels`,
  oracle: "All 200 fixed-output Agent tasks are started in one burst and source completions remain unique; real remote consumers repair snapshots/replay and recover every exact final reply; production and separated topologies require management p95 below 1500ms; the legacy 1/1 negative control measures degradation without claiming the production latency SLO",
  catches: ["full subscriptions were replaced with a lighter workload", "node uplink remains shared", "resync callback ignored a valid snapshot", "body completion mistaken for source task loss"],
  tags: ["fabric-pool", "team-scale", "all-subscriptions"], llm: { default: "none" }, expectedDurationMs: 160000, timeoutMs: 360000,
  stages: ["fleet", "burst", "recover"], resources: { environments: 1, cpu: 12, memoryMb: 16384, io: 2, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "agent-sdk", "workbench-client", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const fleet=await t.stage("fleet",()=>openScaleFleet(t,10,20,!automatic && browsers > 1,{ nodeChannels:nodes,dataChannels:browsers === 4 ? 3 : 1,automatic,bothLegs:automatic }));
  let liveCompletions=0,repairCompletions=0,repairs=0; const seen=new Set<string>();
  const before=fleet.link.stats();
  try {
    for (const node of fleet.nodes) for (let i=0;i<node.sessions.length;i++) {
      const id=node.sessions[i]!,client=node.dataClients[i%node.dataClients.length]!;
      await client.subscribe(id,{ onEvent(event) { if (event.event.type==="turnCompleted" && !seen.has(id)) { seen.add(id);liveCompletions++; } },
        onResync(snapshot,replayed) { repairs++; const s=snapshot as { summary?:{status?:string;latestReply?:unknown} }; if (!seen.has(id) && (s.summary?.status==="idle" && s.summary.latestReply || replayed.some(e=>e.event.type==="turnCompleted"))) {seen.add(id);repairCompletions++;} } });
    }
    fleet.link.setProfile({bandwidthMbps:5,rttMs:200});
    const rpc:number[]=[];let errors=0;
    const start=performance.now();
    const sends=Promise.allSettled(Array.from({length:20},(_,i)=>fleet.nodes.map(node=>t.flows.main.sendPrompt(node.control,node.sessions[i]!,"Emit the deterministic 200-chunk reply."))).flat());
    await t.stage("burst",async()=>{
      while (performance.now()-start<30000) {
        await Promise.all(fleet.nodes.map(async node=>{const began=performance.now();try{const r=await node.control.call({type:"workspace.list"});if(r?.type!=="workspaces")errors++;}catch{errors++;}rpc.push(performance.now()-began);}));
        await pause(500);
      }
    });
    const busy=fleet.link.stats();
    t.note(JSON.stringify({phase:"loaded",browsers,nodes,fullSubscriptions:200,rpc:q(rpc),errors,liveCompletions,repairCompletions,repairs,
      sourceAnswered:fleet.nodes.map(n=>readControlledAgentJournal(n.agent).filter(e=>e.event==="answered").length),nodeTcpAccepted:busy.accepted,
      bytes:busy.forwardedBytes.map((v,i)=>v-before.forwardedBytes[i]!),peakQueuedBytes:busy.peakQueuedBytes}));
    fleet.link.setProfile({bandwidthMbps:1000,rttMs:0});
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
    t.assertions.assert(sourceCounts.every(s=>s.prompt===20&&s.answered===20)&&exactReplies===200&&remoteCompleted===200&&!verificationError,"source uniqueness or remote final body recovery failed");
    if (browsers === 1) t.note(JSON.stringify({classification:"legacy single-channel negative control",productionLatencyQualified:false,errors,rpc:q(rpc)}));
    else t.assertions.assert(errors===0&&q(rpc).p95<1500,"200 full subscriptions exceeded management p95/availability target");
  } finally {await fleet.dispose();}
});

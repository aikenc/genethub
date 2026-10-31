import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request } from "@genehub/proto";
import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Client = Awaited<ReturnType<CaseContext["flows"]["main"]["openSecondClient"]>>;
type Entry = { id:string; session:string; root:string; handle:string; events:Array<{type?:string;raw:unknown}> };
const profiles = [
  {name:"moderate", workspaces:10, sessions:2, observers:4, pause:20},
  {name:"heavy", workspaces:20, sessions:3, observers:8, pause:10},
  {name:"max", workspaces:20, sessions:4, observers:8, pause:10},
];
// The old "browser" fleet used protocol clients, not browser processes. The
// native resource counter was always None. Preserve its real user observations.
for(const profile of profiles)defineSpecialty({
  id:profile.name==="moderate"?"specialty.concurrency.parallel-workspaces":`specialty.concurrency.parallel-workspaces-${profile.name}`,
  title:"20/60/80 sessions preserve tools and history through active, passive and owner-only load",
  oracle:"each old load profile completes cold/warm/passive-reader/owner-only phases with four model/tool rounds, six tool calls and exact model request counts; 4/8 clients actively rotate subscriptions and inspect previews/trunks/blobs at the old polling cadence, without cross-session events or failed reads",
  catches:["load scale silently reduced to one session per workspace","tool/model loops or history missing under fanout","active polling starves turns or mixes subscriptions"],
  tags:["core","concurrency","parity"],llm:{default:"mock"},
  expectedDurationMs:240_000,timeoutMs:900_000,
  resources:{environments:1,cpu:4,memoryMb:4096,io:4,browser:0,pool:"standard"},
  surfaces:["daemon","workbench-client"],productInterfaces:["@genehub/workbench/client"],
},async t=>{
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  const allObservers:Client[]=[];
  const collectors:Client[]=[opened.client];
  try {
    await t.flows.main.configureMockProvider(opened.client,opened.mock);
      const entries:Entry[]=[];
      const operations=new Map<string,number>();
      const sampled=async(client:Client,request:Request)=>{
        const reply=await client.call(request);
        operations.set(request.type,(operations.get(request.type)??0)+1);
        return reply;
      };
      for(let i=0;i<profile.workspaces;i++){
        const root=path.join(t.env.workspace,`${profile.name}-${i}`);
        mkdirSync(path.join(root,"src"),{recursive:true});mkdirSync(path.join(root,"tests"),{recursive:true});
        writeFileSync(path.join(root,"README.md"),"fixture readme\n");
        writeFileSync(path.join(root,"src/lib.rs"),"// GENEHUB_LOAD_MARKER\n");
        writeFileSync(path.join(root,"src/main.rs"),"fn main() {}\n");
        writeFileSync(path.join(root,"tests/workflow.rs"),"// fixture test\n");
        writeFileSync(path.join(root,"notes.md"),"preview fixture\n".repeat(4096));
        const reply=await opened.client.call({type:"workspace.open",payload:{root}});
        if(reply?.type!=="workspace"||!reply.data.folders[0])throw new Error("workspace not opened");
        for(let j=0;j<profile.sessions;j++){
          const session=await t.flows.main.createBuiltinSession(opened.client,reply.data.id);
          const collectorIndex=Math.floor(entries.length/32);
          if(!collectors[collectorIndex])collectors.push(await t.flows.main.openSecondClient(opened,`turn-collector-${collectorIndex}`));
          entries.push({id:reply.data.id,session,root,handle:reply.data.folders[0].rootHandle,events:await t.flows.main.attachEventLog(collectors[collectorIndex]!,session)});
        }
      }
      const observers=await Promise.all(Array.from({length:profile.observers},(_,i)=>t.flows.main.openSecondClient(opened,`${profile.name}-${i}`)));
      allObservers.push(...observers);
      // Each observer retains one active conversation; rotations exercise the
      // same subscribe/unsubscribe path as opening another conversation card.
      let polling=true;
      const observerSessions=observers.map(()=>"");
      const pollers=observers.map(async(client,observer)=>{
        let previous="";let iteration=0;
        while(polling){
          const entry=entries[(observer+iteration++)%entries.length]!;
          const sessions=await sampled(client,{type:"session.list",payload:{workspaceId:null,includeArchived:false,lean:false}});
          t.assertions.assert(sessions?.type==="sessions","session.list under load failed");
          const snapshot=await sampled(client,{type:"subscribe",payload:{sessionId:entry.session,sinceSeq:0,expandLastRound:true}});
          if(snapshot?.type!=="subscribed")throw new Error("conversation open failed");
          if(previous&&previous!==entry.session)await sampled(client,{type:"unsubscribe",payload:{sessionId:previous}});
          previous=entry.session;observerSessions[observer]=entry.session;
          const rounds=await sampled(client,{type:"session.rounds",payload:{sessionId:entry.session,limit:20,cursor:null,throughRoundId:null}});
          if(rounds?.type!=="sessionRounds")throw new Error("rounds failed");
          const round=rounds.data.rounds.find(r=>r.trunkCount>0);
          if(round){
            const layer=await sampled(client,{type:"round.trunk.list",payload:{sessionId:entry.session,roundId:round.roundId,cursor:null,limit:20}});
            if(layer?.type!=="roundLayer")throw new Error("trunk list failed");
            const summary=layer.data.trunks.find(s=>s.blobCount>0);
            if(summary){
              const trunk=await sampled(client,{type:"round.trunk.get",payload:{sessionId:entry.session,roundId:round.roundId,trunkIndex:summary.index}});
              if(trunk?.type!=="roundTrunk")throw new Error("trunk get failed");
              const blob=trunk.data.batches.flatMap(b=>b.blobs).find(b=>b.kind==="toolCall"&&b.blob)?.blob;
              if(blob)t.assertions.assert((await sampled(client,{type:"blob.get",payload:{sessionId:entry.session,blob}}))?.type==="blob","tool detail failed");
            }
          }
          t.assertions.assert((await sampled(client,{type:"file.tree",payload:{workspaceId:entry.id,path:null,depth:2}}))?.type==="fileTree","file tree failed");
          const preview=await client.preview(entry.id,`${entry.handle}/notes.md`);
          t.assertions.assert(Buffer.from(preview.bytes).equals(Buffer.from("preview fixture\n".repeat(4096))),"preview bytes lost");
          operations.set("asset.preview",(operations.get("asset.preview")??0)+1);
          await new Promise(resolve=>setTimeout(resolve,profile.pause));
        }
      });
      // Observe rejection immediately, retain the original error for final join.
      const pollsDone=Promise.all(pollers).then(()=>null,error=>error as Error);
      let passiveLogs:Array<Array<{type?:string;raw:unknown}>>=[];
      try {
        for(const phase of ["cold","warm","passive-reader","owner-only"]){
          if(phase==="passive-reader"){
            polling=false;const error=await pollsDone;if(error)throw error;
            for(const [i,observer] of observers.entries()){
              if(observerSessions[i])await observer.call({type:"unsubscribe",payload:{sessionId:observerSessions[i]!}});
              passiveLogs.push(await t.flows.main.attachEventLog(observer,entries[i]!.session));
            }
          }
          if(phase==="owner-only")for(const observer of observers)observer.close();
          const token=`LOAD_${profile.name}_${phase}`;
          const count=entries.length;
          const requestStart=opened.mock.requests.length;
          let firstRequests=0;let release!:()=>void;
          const barrier=new Promise<void>(resolve=>{release=resolve;});
          let arrivals!:()=>void;const allArrived=new Promise<void>(resolve=>{arrivals=resolve;});
          const script={respond:async(request:unknown)=>{
            const messages=(request as {messages?:Array<{role:string;content?:unknown;tool_calls?:unknown[]}>}).messages??[];
            let lastUser=-1;for(let i=0;i<messages.length;i++)if(messages[i]!.role==="user")lastUser=i;
            const round=messages.slice(lastUser+1).filter(m=>m.role==="assistant"&&m.tool_calls?.length).length;
            if(round===0){firstRequests++;if(firstRequests===count)arrivals();await barrier;}
            const tools=[
              [{name:"ls",arguments:{path:""}},{name:"find",arguments:{pattern:".rs",path:"",limit:40}}],
              [{name:"grep",arguments:{pattern:"GENEHUB_LOAD_MARKER",path:"src",limit:40}}],
              [{name:"read",arguments:{path:"README.md"}},{name:"read",arguments:{path:"src/lib.rs"}}],
              [{name:"bash",arguments:{command:`printf '${token}\\n' >> load-phases.txt; wc -l README.md src/lib.rs src/main.rs tests/workflow.rs`}}],
            ];
            return round<4?{tools:tools[round],delayMs:15}:{text:`${token} complete`};
          }};
          opened.mock.script(...Array.from({length:count*5},()=>script));
          const before=entries.map(entry=>entry.events.length);
          try {
            await Promise.all(entries.map(entry=>t.flows.main.sendPrompt(opened.client,entry.session,token)));
            await Promise.race([allArrived,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error(`model overlap barrier ${firstRequests}/${count}`)),60_000).unref())]);
            const started=Date.now();
            t.assertions.assert((await opened.client.call({type:"workspace.list"}))?.type==="workspaces","in-flight list failed");
            t.assertions.assert(Date.now()-started<3000,"in-flight list blocked");
            t.assertions.assert(firstRequests===count,`only ${firstRequests}/${count} concurrent models started`);
          } finally {release();}
          t.note(`${profile.name}/${phase}: all ${firstRequests} models overlapped before release`);
          try {
            await t.tools.waitUntil(()=>entries.every((entry,i)=>{
              const current=entry.events.slice(before[i]);
              const failed=current.find(e=>e.type==="turnFailed");
              if(failed)throw new Error(`turn failed: ${JSON.stringify(failed.raw)}`);
              return current.some(e=>e.type==="turnCompleted");
            }),180_000);
          } catch(error) {
            t.note(`phase failure: modelRequests=${opened.mock.requests.length-requestStart}, sessions=${JSON.stringify(entries.map((entry,i)=>({id:entry.session,events:entry.events.slice(before[i]).map(e=>e.type)})))}`);
            throw error;
          }
          for(const [i,entry] of entries.entries()){
            const events=entry.events.slice(before[i]);
            t.assertions.assert(events.every(e=>(e.raw as {sessionId?:string}).sessionId===entry.session),`crossed publication for ${entry.session}`);
            t.assertions.assert(events.filter(e=>e.type==="turnStarted").length===1,`crossed turn ${entry.session}`);
            const narrative=await opened.client.call({type:"session.narrative",payload:{sessionId:entry.session,itemId:null,limit:100,throughRoundId:null,cursor:null}});
            if(narrative?.type!=="sessionNarrative")throw new Error("missing narrative");
            const completed=narrative.data.items.filter(item=>item.type==="turnSummary").at(-1);
            t.assertions.assert(completed?.type==="turnSummary"&&completed.stats.toolCalls===6&&completed.stats.usage.llmRounds===5,`missing tool/model loop: ${JSON.stringify(completed)}`);
            t.assertions.assert(readFileSync(path.join(entry.root,"load-phases.txt"),"utf8").split("\n").filter(line=>line===token).length===profile.sessions,"tool side effects lost or duplicated");
          }
          if(phase==="passive-reader")for(const log of passiveLogs)t.assertions.assert(log.filter(e=>e.type==="turnStarted").length===1,"passive observer mixed or lost a turn");
          const requests=opened.mock.requests.slice(requestStart);
          t.assertions.assert(requests.length===count*5,`model loop count ${requests.length}/${count*5}`);
          t.assertions.assert(requests.every(r=>Buffer.byteLength(JSON.stringify(r))>0),"unmeasured request body");
          t.note(`${profile.name}/${phase}: sessions=${count}, modelRequests=${requests.length}, toolCalls=${count*6}, concurrentFirstRequests=${firstRequests}`);
        }
      }finally{polling=false;const error=await pollsDone;if(error)throw error;for(const observer of observers)observer.close();}
      for(const operation of ["session.list","subscribe","unsubscribe","file.tree","asset.preview","round.trunk.list","round.trunk.get","blob.get"]){
        t.assertions.assert((operations.get(operation)??0)>0,`missing active interaction ${operation}`);
      }
      for(const entry of entries)await opened.client.call({type:"session.close",payload:{sessionId:entry.session}});
      t.note(`${profile.name} polling pause=${profile.pause}ms, observers=${profile.observers}, operations=${JSON.stringify(Object.fromEntries(operations))}`);
  }finally{for(const observer of allObservers)observer.close();for(const collector of collectors)collector.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});

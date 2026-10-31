import {writeFileSync} from "node:fs";
import path from "node:path";
import type {TimelineItem} from "@genehub/proto";
import {BlockedError,defineJourney,seedScriptAgentRuntime} from "../../framework/public.ts";

defineJourney({
  id:"journey.session.claude-subagent-isolation",title:"Claude sub-agent steps remain on the dispatching tool card",
  oracle:"real Claude dispatches an Explore sub-agent to read hello.txt; its stored SubAgent detail has nested items and no top-level Read leaks into the conversation",
  catches:["sub-agent events leak into parent timeline","sub-agent card drops child tool details"],
  tags:["third-party","session","claude"],llm:{default:"real"},resources:{pool:"real-llm"},
  expectedDurationMs:90000,timeoutMs:240000,surfaces:["daemon","agent","workbench-client"],productInterfaces:["@genehub/workbench/client"],
},async t=>{
  t.flows.main.pointClaudeAtBuiltinLlm(t.env);seedScriptAgentRuntime(t.env);
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  try{
    const claude=await t.flows.main.requireAgentReady(opened.client,"claude",60000);
    writeFileSync(path.join(opened.workspaceRoot,"hello.txt"),"the answer is 42\n");
    const session=await t.flows.main.createAgentSession(opened.client,{workspaceId:opened.workspaceId,agentId:"claude",modelId:claude.catalog.models[0]?.id??null});
    await opened.client.call({type:"session.setMode",payload:{sessionId:session,modeId:"bypassPermissions"}});
    const events=await t.flows.main.attachEventLog(opened.client,session);
    await t.flows.main.sendPrompt(opened.client,session,"Use your Task tool (Agent tool on newer versions) with the Explore agent to report what hello.txt says. Do not read the file yourself.");
    await t.tools.waitUntil(()=>events.some(e=>e.type==="turnCompleted"||e.type==="turnFailed"),180000);
    const failed=events.find(e=>e.type==="turnFailed");
    if(failed){const text=JSON.stringify(failed.raw);if(/not logged|unauthor|auth|api key|login|credit|balance|root\/sudo|dangerously-skip-permissions/i.test(text))throw new BlockedError(`Claude provider unavailable: ${text.slice(0,500)}`);throw new Error(`Claude failed: ${text.slice(0,1000)}`);}
    const rounds=await opened.client.call({type:"session.rounds",payload:{sessionId:session,cursor:null,throughRoundId:null,limit:20}});
    if(rounds?.type!=="sessionRounds"||rounds.data.nextCursor)throw new Error("missing or truncated source rounds");
    const items:TimelineItem[]=[];
    for(const round of rounds.data.rounds){
      let cursor:string|null=null;
      do{
        const layer=await opened.client.call({type:"round.trunk.list",payload:{sessionId:session,roundId:round.roundId,cursor,limit:100}});
        if(layer?.type!=="roundLayer")throw new Error("missing trunk layer");
        for(const summary of layer.data.trunks){
          const detail=await opened.client.call({type:"round.trunk.get",payload:{sessionId:session,roundId:round.roundId,trunkIndex:summary.index}});
          if(detail?.type!=="roundTrunk")throw new Error("missing trunk detail");
          for(const row of detail.data.batches.flatMap(b=>b.blobs)){
            if(row.kind!=="toolCall"||!row.blob)continue;
            const blob=await opened.client.call({type:"blob.get",payload:{sessionId:session,blob:row.blob}});
            if(blob?.type!=="blob")throw new Error("missing tool source");items.push(blob.data.value as TimelineItem);
          }
        }
        cursor=layer.data.nextCursor??null;
      }while(cursor);
    }
    const dispatched=items.filter((item):item is Extract<TimelineItem,{type:"toolCall"}>=>item.type==="toolCall").filter(item=>item.detail.kind==="subAgent");
    if(!dispatched.length)throw new BlockedError("Claude answered without dispatching a sub-agent; containment was not exercised");
    t.assertions.assert(dispatched.some(item=>item.detail.kind==="subAgent"&&item.detail.items.length>0),"sub-agent card lost nested steps");
    t.assertions.assert(!items.some(item=>item.type==="toolCall"&&item.detail.kind==="read"),"sub-agent read leaked to top level");
  }finally{opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});

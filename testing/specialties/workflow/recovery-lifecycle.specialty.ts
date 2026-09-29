import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, openWorkbenchPage, runGenetAsync } from "../../framework/public.ts";

// Keep the existing case identities while moving their actions to the report
// contract. Report completion never authorizes or rewrites business results.
for (const mode of ["normal", "consult", "handoff-timeout", "handoff-cancel", "resume", "bypass", "corrupt", "proactive", "human-b", "human-f", "cancel", "queue"] as const) {
  const consult = mode === "consult", timeout = mode === "handoff-timeout", corrupt = mode === "corrupt", queue = mode === "queue";
  const suffix = ({ normal: "lifecycle", consult: "consult", "handoff-timeout": "handoff-timeout", "handoff-cancel": "handoff-cancel", resume: "resume", bypass: "pm-gate", corrupt: "corrupt-fallback", proactive: "proactive", "human-b": "human-b", "human-f": "human-f", cancel: "cancel", queue: "package-queue" } as const)[mode];
  defineSpecialty({
    id: `specialty.workflow.recovery-${suffix}`,
    title: `Recovery report and PM responsibility: ${mode}`,
    oracle: "A real recovery report retains the failed program and open goal; PM controls follow-up, Human scope and acceptance have separate effects, restart and repeated notices cannot repeat diagnosis, and the package serializes active reviews",
    catches: ["report completion rewrites failure or delivers the goal", "WR executes PM authority", "generic Human advice creates a scope card", "restart repeats diagnosis", "late PM handoff forges failure", "a second active review bypasses the package lock"],
    tags: ["core", "workflow", "workflow-recovery"], runner: consult ? "playwright" : undefined,
    llm: { default: "mock" }, expectedDurationMs: 65_000, timeoutMs: 180_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: consult ? 1 : 0, pool: consult ? "browser" : "standard" },
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
    productInterfaces: ["workflow.activate", "workflow.dispatch", "workflow.journal", "workflow.complete", "workflow.history", "workflow.human", "session.respondPermission"],
  }, async t => {
    t.data.git.init(t.env.workspace);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
    let stage = "setup", originalId = "", pmId = "";
    let recovery: WorkflowRunStatus | undefined;
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
      const prompt = path.join(source, "prompts/worker.md");
      writeFileSync(prompt, "RECOVERY_REPORT_BUSINESS: submit only your bound result.\n");
      writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({schema:"genehub.workflow.role.v1", id:"worker", agentId:"genet", modelId:"deepseek/deepseek-v4-flash", userInteraction:"readOnly", prompt:"prompts/worker.md"}));
      const flow = {schema:"genehub.workflow.definition.v2", id:"direct-change", version:2,
        nodes:[{id:"work",uses:"agent.session",with:{role:"worker"},completion:{all:[{key:"result",verify:"value.nonEmpty"}]}},{id:"publish",uses:"result.publish"}],
        structure:{body:{id:"business",type:"sequence",steps:[{id:"work-step",type:"task",activity:"work"},{id:"publish-step",type:"task",activity:"publish"}]}}};
      writeFileSync(path.join(source,"flows/direct-change.yaml"),JSON.stringify(flow));
      if(corrupt){
        writeFileSync(path.join(source,"workflow.md"),"---\ndescription: corrupt custom recovery\nrecovery: flows/recovery.yaml\n---\n");
        writeFileSync(path.join(source,"flows/recovery.yaml"),JSON.stringify({...flow,id:"recovery"}));
        const result=await runGenetAsync(opened.daemon.genet,["workflow","activate","--revision","0"],opened.daemon.env,{cwd:opened.workspaceRoot});
        t.assertions.assert(result.code===0,`custom activation failed: ${result.stderr||result.stdout}`);
      }
      const bash=(command:string)=>({tool:{name:"bash",arguments:{command}}});
      let started=false, failed=false, secondFailed=false, successorDone=false, reportDone=false, followup=false, proactiveStarted=false;
      opened.mock.script(...Array.from({length:100},()=>({respond:(request:unknown)=>{
        const body=JSON.stringify(request);
        const instructions=JSON.stringify((request as {messages?:Array<{role:string}>}).messages?.filter(message=>["system","developer"].includes(message.role))??[]);
        if(instructions.includes("角色标签为 `recovery-reviewer`")){
          if(queue)return {hang:true as const};
          if(reportDone)return {text:"Report submitted."};reportDone=true;
          const handled=body.match(/被处理 Run：(wr_[a-f0-9]+)/)?.[1];
          if(!handled)throw new Error("report omitted original Run identity");
          const denied=mode==="bypass"?`if "$GENEHUB_CLI" workflow cancel --run ${handled} --revision 1 > denied.txt 2>&1; then exit 41; fi; `:"";
          return bash(`${denied}printf 'diagnostic report: PM should decide the next action' > report.txt; "$GENEHUB_CLI" workflow complete --evidence report=report.txt`);
        }
        if(instructions.includes("RECOVERY_REPORT_BUSINESS")){
          if(body.includes("candidate-successor")){
            if(successorDone)return {text:"Successor submitted."};successorDone=true;
            return bash('printf delivered > artifact.txt; "$GENEHUB_CLI" workflow complete --evidence result=artifact.txt');
          }
          if(mode==="proactive")return {hang:true as const};
          if(body.includes("candidate-second")){
            if(secondFailed)return {text:"Second failure submitted."};secondFailed=true;
          }else{if(failed)return {text:"Failure submitted."};failed=true;}
          return bash(`${corrupt?"sleep 8; ":""}printf failed > original-effect.txt; "$GENEHUB_CLI" workflow complete --outcome failed --reason "business acceptance failed" --evidence result=original-effect.txt`);
        }
        if(!proactiveStarted&&body.includes("START_PROACTIVE_RECOVERY")){proactiveStarted=true;return bash(`"$GENEHUB_CLI" workflow recovery start --run ${originalId} --reason "PM saw unhealthy execution"`);}
        if(body.includes("START_SECOND_REQUEST"))return bash('"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-second --message "second failed request" --no-wait');
        if(!started&&body.includes("START_RECOVERY")){started=true;return bash(`${corrupt?"":'"$GENEHUB_CLI" workflow activate --revision 0 && '}"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-original --message "repair this request" --no-wait`);}
        if(body.includes("PROPOSE_HUMAN"))return bash(`"$GENEHUB_CLI" workflow human --run ${recovery!.id} --revision ${recovery!.revision} --kind ${mode==="human-b"?"b":"f"} --reason "PM has reviewed a concrete alternative" ${mode==="human-b"?'--goal "Deliver the playable prototype" --scope-changes "Defer polish, retain movement and shooting acceptance"':""}`);
        if(!followup&&body.includes("CONTINUE_RECOVERY")){
          followup=true;
          const repair=mode==="normal"?`printf '\nUpdated delivery method\n' >> '${prompt}'; "$GENEHUB_CLI" workflow activate --revision 1 && `:"";
          return bash(`${repair}"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-successor --retry-of ${originalId} --message "deliver repaired goal" --no-wait`);
        }
        return {text:"PM retains responsibility for the original goal."};
      }})));
      pmId=await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);
      const history=async():Promise<WorkflowRunStatus[]>=>{
        const reply=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:20}});
        if(reply?.type!=="workflowRuns")throw new Error("missing Run history");return reply.data;
      };
      const snapshot=async(id=pmId):Promise<SessionSnapshot>=>{
        const reply=await opened.client.call({type:"session.get",payload:{sessionId:id}});
        if(reply?.type!=="snapshot")throw new Error("missing Session");return reply.data;
      };
      let inputs=0;
      const send=(text:string,id=pmId)=>opened.client.call({type:"session.send",payload:{sessionId:id,messageId:`u_report_${mode}_${++inputs}`,text,attachments:[],continuesRound:null,artifactPreviewBaseUrl:null}});
      const journal=async(id:string)=>{
        const reply=await runGenetAsync(opened.daemon.genet,["workflow","journal","--run",id,"--since","0","--limit","100"],opened.daemon.env,{cwd:opened.workspaceRoot});
        t.assertions.assert(reply.code===0,reply.stderr||reply.stdout);
        return (JSON.parse(reply.stdout) as {data:{events:Array<{eventType:string;actor?:string}>}}).data.events;
      };
      const restart=async(age=false)=>{
        opened.client.close();
        for(const verb of ["stop","start"]){
          const result=await runGenetAsync(opened.daemon.genet,["daemon",verb],opened.daemon.env,{cwd:opened.workspaceRoot});
          t.assertions.assert(result.code===0,`${verb}: ${result.stderr||result.stdout}`);
          if(age&&verb==="stop"){
            const file=path.join(opened.workspaceRoot,".genethub/components/pm/requests",originalId,"runs",recovery!.id,"run.json");
            const record=JSON.parse(readFileSync(file,"utf8"));record.run.updatedAtMs=Date.now()-1_805_000;writeFileSync(file,JSON.stringify(record));
          }
        }
        opened.client=await connectProductClient(daemonEndpoint(opened.daemon));
      };
      stage="dispatch original";await send("START_RECOVERY");
      await t.tools.waitUntil(async()=>{
        const original=(await history()).find(run=>run.taskId==="candidate-original");if(original)originalId=original.id;
        return original?.status==="running"&&original.nodes.some(node=>!!node.sessionId);
      },30_000);
      if(corrupt){const original=(await history()).find(run=>run.id===originalId)!;const file=path.join(opened.workspaceRoot,".genethub/components/executor/candidates",`${original.dcgDigest.slice(7)}.json`);t.assertions.assert(existsSync(file),"missing active Candidate");writeFileSync(file,"damaged Candidate\n");}
      if(mode==="proactive")await send("START_PROACTIVE_RECOVERY");
      stage="wait for real diagnostic";
      await t.tools.waitUntil(async()=>{recovery=(await history()).find(run=>run.handles.some(handle=>handle.runId===originalId));return recovery?.nodes.some(node=>node.uses==="agent.session"&&!!node.sessionId)===true;},45_000);
      if(queue){
        const broken=path.join(opened.workspaceRoot,".genethub/components/pm/requests/wr_damaged_fixture");mkdirSync(broken,{recursive:true});writeFileSync(path.join(broken,"request.json"),"not a snapshot\n");
        const pm2=await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);await send("START_SECOND_REQUEST",pm2);
        let second:WorkflowRunStatus|undefined;
        await t.tools.waitUntil(async()=>{second=(await history()).find(run=>run.taskId==="candidate-second");return second?.phase==="closed";},35_000);
        await new Promise(resolve=>setTimeout(resolve,6_000));
        t.assertions.assert(!(await history()).some(run=>run.handles.some(handle=>handle.runId===second!.id)),"second active review bypassed package lock");
        const original=(await history()).find(run=>run.id===originalId)!;await opened.client.call({type:"workflow.cancel",payload:{workspaceId:opened.workspaceId,runId:original.id,expectedRevision:original.revision}});
        await t.tools.waitUntil(async()=>(await history()).some(run=>run.handles.some(handle=>handle.runId===second!.id)&&run.nodes.some(node=>!!node.sessionId)),40_000);
        t.assertions.assert((await history()).filter(run=>run.handles.some(handle=>handle.runId===second!.id)).length===1,"queued review repeated");return;
      }
      await t.tools.waitUntil(async()=>{recovery=(await history()).find(run=>run.id===recovery!.id);return recovery?.phase==="closed"&&recovery.status==="completed";},35_000);
      const original=(await history()).find(run=>run.id===originalId)!;
      t.assertions.assert(original.status==="blocked"&&original.programResult!=="completed"&&original.requirement?.state!=="completed"&&!recovery!.humanExit,"report invented delivery or Human scope");
      t.assertions.assert(!(await snapshot(recovery!.nodes.find(node=>node.sessionId)!.sessionId!)).pendingPermissions.length,"report waited on a fixed PM choice");
      if(mode==="bypass"){t.assertions.assert(readFileSync(path.join(opened.workspaceRoot,"denied.txt"),"utf8").includes("forbidden"),"WR gained cancellation authority");return;}
      if(corrupt){t.assertions.assert((await journal(recovery!.id)).filter(event=>event.eventType==="recovery.fallback").length===1&&recovery!.workflowId==="builtin-recovery","fallback missing or duplicated");return;}
      if(mode==="proactive"){t.assertions.assert(original.reason?.includes("PM recovery:")&&(await journal(recovery!.id)).some(event=>event.eventType==="recovery.started"&&event.actor==="pm"),"proactive reason or actor lost");return;}
      if(mode==="human-b"||mode==="human-f"){
        await send("PROPOSE_HUMAN");
        await t.tools.waitUntil(async()=>{recovery=(await history()).find(run=>run.id===recovery!.id);return !!recovery?.humanExit&&(await snapshot()).pendingPermissions.some(card=>card.id===recovery!.humanExit!.requestId);},20_000);
        const card=(await snapshot()).pendingPermissions.find(card=>card.id===recovery!.humanExit!.requestId)!;
        const answer=mode==="human-b"?"acceptScope":"pass";
        t.assertions.assert(card.options?.map(option=>option.id).join(",")===(mode==="human-b"?"acceptScope,keepScope,cancel":"pass,fail"),"wrong Human action options");
        await opened.client.call({type:"session.respondPermission",payload:{sessionId:pmId,requestId:card.id,outcome:{outcome:"selected",optionId:answer}}});
        await t.tools.waitUntil(async()=>{recovery=(await history()).find(run=>run.id===recovery!.id);return recovery?.humanExit?.answer===answer;},25_000);
        const business=(await history()).find(run=>run.id===originalId)!;
        t.assertions.assert(business.status==="blocked"&&business.requirement?.state!=="completed"&&(mode!=="human-b"||business.requirement?.scope?.goal==="Deliver the playable prototype"),"Human response rewrote the program or scope was lost");return;
      }
      if(mode==="handoff-cancel"||mode==="cancel"){
        await opened.client.call({type:"workflow.cancel",payload:{workspaceId:opened.workspaceId,runId:original.id,expectedRevision:original.revision}});
        await t.tools.waitUntil(async()=>(await history()).find(run=>run.id===originalId)?.requirement?.state==="cancelled",25_000);
        t.assertions.assert((await history()).find(run=>run.id===recovery!.id)?.status==="completed","cancellation rewrote completed report");return;
      }
      if(consult){browser=await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(opened.daemon),opened.workspaceId,pmId);await browser.page.getByRole("region",{name:"任务进度"}).getByRole("button",{name:/小队任务/}).click();await browser.page.getByRole("dialog",{name:"小队任务",exact:true}).getByText("恢复流程 · 执行已结束，需求仍需核对交付").waitFor();await browser.close();browser=undefined;}
      if(mode==="resume"||consult||timeout){await restart(timeout);await t.tools.waitUntil(async()=>(await history()).find(run=>run.id===recovery!.id)?.status==="completed",20_000);t.assertions.assert((await history()).length===2,"restart repeated diagnosis");}
      if(timeout){await t.tools.waitUntil(async()=>{recovery=(await history()).find(run=>run.id===recovery!.id);return recovery?.humanExit?.kind==="d"&&(await snapshot()).pendingPermissions.filter(card=>card.id===recovery!.humanExit!.requestId).length===1;},25_000);t.assertions.assert(recovery!.status==="completed"&&original.programResult!=="completed","overdue handoff forged failure or success");return;}
      stage="PM-controlled successor";await send("CONTINUE_RECOVERY");
      await t.tools.waitUntil(async()=>(await history()).some(run=>run.taskId==="candidate-successor"&&run.status==="completed"&&run.phase==="closed"),60_000);
      const runs=await history(),successor=runs.find(run=>run.taskId==="candidate-successor")!;
      t.assertions.assert(successor.requestRunId===originalId&&(mode==="normal"?successor.dcgDigest!==original.dcgDigest:successor.dcgDigest===original.dcgDigest)&&runs.find(run=>run.id===originalId)?.status==="blocked","successor changed lineage or past result");
      const archive=path.join(opened.workspaceRoot,".genethub/components/executor/recoveries.jsonl");
      await t.tools.waitUntil(()=>existsSync(archive),10_000);
      const summaries=readFileSync(archive,"utf8").trim().split("\n").map(line=>JSON.parse(line) as {runId:string;handledRunId:string;result:string});
      t.assertions.assert(summaries.filter(row=>row.runId===recovery!.id&&row.handledRunId===originalId&&row.result==="completed").length===1,"report archive duplicated or lost linkage");
    }catch(error){throw new Error(`${stage}: ${error}; original=${originalId}; recovery=${JSON.stringify(recovery)}; mock=${JSON.stringify(opened.mock.requests.filter((r:any)=>JSON.stringify(r.messages?.filter((m:any)=>["system","developer"].includes(m.role))).includes("recovery-reviewer")).map((r:any)=>r.messages?.filter((m:any)=>!["system","developer"].includes(m.role)))).slice(-12000)}`);}
    finally{await browser?.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();}
  });
}

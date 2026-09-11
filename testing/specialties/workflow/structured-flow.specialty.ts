import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";
import type { WorkflowRunStatus } from "@genehub/proto";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Initial vertical slice: real PM -> daemon -> structured engine -> Worker -> disk.
// Expressions are project-authored inputs, not imports of engine implementation.
for (const scenario of ["zero", "repair", "limit", "zero-limit", "if-true", "if-false", "if-omitted", "condition-error", "choice-first", "choice-default", "nested", "parallel", "foreach", "foreach-empty", "call", "budget", "collect", "fail-fast", "restart", "cancel", "nested-loop", "item-keys", "duplicate-keys", "deadline", "activity-deadline", "stale-result", "deadline-restart", "parallel-loop", "nested-loop-restart"] as const) defineSpecialty({
  id: `specialty.workflow.structured.${scenario}`,
  title: `Structured workflow ${scenario} preserves real activity outcomes`,
  oracle: "A project-authored while loop executes zero or bounded rounds in one Run; real Worker artifacts agree with its public terminal state and no PM redispatch is needed",
  catches: ["while executes once when initially false", "loop limit rejects final successful round", "node identity reuses a previous Worker", "negative evidence bypasses workflow conditions", "structured source is silently executed as a DAG"],
  tags: ["core", "workflow", "structured-workflow", ...(["parallel-loop","nested-loop-restart","nested-loop","parallel","foreach"].includes(scenario) ? ["structured-composition"] : [])],
  llm: { default: "mock" }, expectedDurationMs: 35_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["genet workflow", "session.send", "workflow.get", "workflow.history", "workflow.check"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot:t.openRoot, lease:t.env });
  try {
    const cli = async (args: string[]) => {
      const result = await runGenetAsync(opened.daemon.genet,args,opened.daemon.env,{cwd:opened.workspaceRoot});
      t.assertions.assert(result.code === 0, `CLI failed: ${result.stderr || result.stdout}`);
      return result.stdout;
    };
    await t.flows.main.configureMockProvider(opened.client,opened.mock);
    await cli(["workflow","init","--agent","genet","--model","deepseek/deepseek-v4-flash"]);
    const source = path.join(opened.workspaceRoot,".genethub/workflow");
    const definitionPath = path.join(source,"workflows/direct-change.yaml");
    const workerPrompt = path.join(source,"prompts/direct-worker.md");
    writeFileSync(workerPrompt,"STRUCTURED_WORKER: execute the assigned activity, preserve the current operation identity, report actual file evidence.\n");
    const literal = (value: unknown) => ({op:"literal",value});
    const task = (id: string) => ({id,type:"task",activity:"work",accept:["completed","changesRequested"]});
    const loop = {id:"repair",type:"loop",maxRounds:scenario === "zero-limit" ? 0 : 2,
      initial:literal({done:scenario === "zero"}),condition:{op:"not",value:{op:"ref",path:"/vars/done"}},
      body:task("attempt"),update:{op:"object",fields:{done:{op:"eq",left:{op:"ref",path:"/results/evidence/done"},right:literal("yes")}}}};
    const structure: Record<string,unknown> = {};
    let body: unknown = loop;
    let expectedWorkers = scenario === "zero" || scenario === "zero-limit" ? 0 : 2;
    let blocked = scenario === "limit" || scenario === "zero-limit";
    if (scenario.startsWith("if-") || scenario === "condition-error") {
      body = {id:"decision",type:"if",condition:scenario === "condition-error" ? {op:"ref",path:"/input/missing"} : literal(scenario === "if-true"),
        then:task("yes"),...(scenario === "if-omitted" ? {} : {else:{id:"no",type:"sequence",steps:[task("no-one"),task("no-two")]}})};
      expectedWorkers = scenario === "if-omitted" || scenario === "condition-error" ? 0 : scenario === "if-true" ? 1 : 2;
      blocked = scenario === "condition-error";
    } else if (scenario.startsWith("choice-")) {
      body = {id:"select",type:"choice",branches:[{condition:literal(scenario === "choice-first"),body:task("first")},{condition:literal(scenario === "choice-first"),body:{id:"second",type:"sequence",steps:[task("second-one"),task("second-two")]}}],default:{id:"fallback",type:"sequence",steps:[task("fallback-one"),task("fallback-two"),task("fallback-three")]}};
      expectedWorkers = scenario === "choice-first" ? 1 : 3;
    } else if (scenario === "nested-loop" || scenario === "nested-loop-restart") {
      body = {id:"outer",type:"loop",maxRounds:2,initial:literal({done:false}),condition:{op:"not",value:{op:"ref",path:"/vars/done"}},
        body:{...loop,update:{op:"object",fields:{done:{op:"eq",left:{op:"ref",path:"/results/evidence/done"},right:literal("yes")},outerDone:{op:"eq",left:{op:"ref",path:"/results/evidence/checks"},right:literal("last")}}}},
        update:{op:"object",fields:{done:{op:"ref",path:"/results/outerDone"}}}};
      expectedWorkers = 4;
    } else if (scenario === "item-keys" || scenario === "duplicate-keys") {
      body = {id:"batch",type:"forEach",items:literal([{id:"front"},{id:scenario === "item-keys" ? "back" : "front"}]),key:{op:"ref",path:"/item/id"},maxConcurrency:2,body:task("item")};
      expectedWorkers = scenario === "item-keys" ? 2 : 0; blocked = scenario === "duplicate-keys";
    } else if (scenario === "nested") {
      body = {id:"batch",type:"forEach",items:literal(["front","back"]),maxConcurrency:1,body:loop};
      expectedWorkers = 4;
    } else if (scenario === "parallel-loop") {
      body = {id:"team",type:"parallel",branches:[{...loop,body:{...task("front-iteration"),input:literal("LOOP_FRONT")}}, {...task("back-once"),input:literal("ONCE_BACK")}]};
      expectedWorkers = 3;
    } else if (["parallel","collect","fail-fast"].includes(scenario)) {
      body = {id:"team",type:"parallel",failure:scenario === "fail-fast" ? "failFast" : "collect",branches:[{...task("front"),accept:scenario === "parallel" ? ["completed","changesRequested"] : ["completed"]},task("back")]};
      blocked = scenario !== "parallel";
    } else if (scenario === "foreach" || scenario === "foreach-empty") {
      body = {id:"batch",type:"forEach",items:literal(scenario === "foreach" ? ["a","b","c","d","e"] : []),maxConcurrency:2,body:task("item")};
      expectedWorkers = scenario === "foreach" ? 5 : 0;
    } else if (scenario === "call") {
      body = {id:"invoke",type:"call",procedure:"build"};
      structure.procedures = {build:task("build-body")}; expectedWorkers = 1;
    } else if (scenario === "budget") {
      body = {id:"batch",type:"forEach",items:literal([1,2,3]),maxConcurrency:1,body:task("item")};
      structure.limits = {maxOperations:1,maxConcurrency:2,maxFrames:64}; expectedWorkers = 1; blocked = true;
    }
    if (scenario === "activity-deadline") { body = {...task("slow"),timeoutMs:1000}; expectedWorkers = 1; blocked = true; }
    if (["deadline","deadline-restart"].includes(scenario)) { structure.timeoutMs = scenario === "deadline-restart" ? 10000 : 5000; expectedWorkers = 1; blocked = true; }
    writeFileSync(definitionPath,JSON.stringify({
      schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,
      nodes:[{id:"work",uses:"agent.session",with:{role:"worker"},completion:{all:[{key:"done",verify:"value.nonEmpty"},{key:"checks",verify:"value.nonEmpty"}]}},{id:"publish",uses:"result.publish"}],
      structure:{...structure,body:{id:"delivery",type:"sequence",steps:[body,{id:"delivery-result",type:"task",activity:"publish"}]}},
    }));
    let pmCalls = 0;
    let dispatched = false;
    const assigned = new Set<string>();
    let frontAttempts = 0;
    const concurrencyTrace = path.join(opened.workspaceRoot,"concurrency.txt");
    const artifact = path.join(opened.workspaceRoot,"attempts.txt");
    const respond = (request: unknown) => {
      const text = JSON.stringify(request);
      if (text.includes("STRUCTURED_WORKER")) {
        const operation = text.match(/当前节点：(operation-\d+)/)?.[1];
        if (!operation) throw new Error("Worker request omitted current operation identity");
        if (!assigned.has(operation)) {
          assigned.add(operation);
          if (text.includes("LOOP_FRONT")) frontAttempts += 1;
          const success = (["repair","restart","stale-result"].includes(scenario) && assigned.size === 2) || (["nested","nested-loop","nested-loop-restart"].includes(scenario) && assigned.size % 2 === 0) || (scenario === "parallel-loop" && (text.includes("ONCE_BACK") || frontAttempts === 2));
          const concurrent = scenario === "parallel" || scenario === "parallel-loop" || scenario === "foreach";
          const overlap = concurrent ? `printf 'S %s\\n' ${quote(operation)} >> ${quote(concurrencyTrace)}; while [ "$(grep -c '^S ' ${quote(concurrencyTrace)})" -lt 2 ]; do sleep 0.02; done; printf 'D %s\\n' ${quote(operation)} >> ${quote(concurrencyTrace)}; ` : "";
          const stale = scenario === "stale-result" && assigned.size === 2 ? `rejected=$("$GENEHUB_CLI" workflow complete --node ${quote([...assigned][0]!)} --evidence done=yes --evidence checks=artifact-written 2>&1); code=$?; test "$code" -ne 0 && printf '%s' "$rejected" | grep -E 'forbidden|只能|不是节点' || exit 1; ` : "";
          const command = `${stale}${overlap}printf '%s\\n' ${quote(operation)} >> ${quote(artifact)} && test -s ${quote(artifact)} ${["deadline","activity-deadline", "stale-result", "deadline-restart"].includes(scenario) ? "&& sleep 10" : ""} && "$GENEHUB_CLI" workflow complete --outcome ${success ? "completed" : "changesRequested"} ${success ? "" : '--reason "需要下一轮修复"'} --evidence done=${success ? "yes" : "no"} --evidence checks=${["nested-loop","nested-loop-restart"].includes(scenario) && assigned.size === 4 ? "last" : "artifact-written"}${["restart","cancel","nested-loop-restart"].includes(scenario) && assigned.size === 1 ? " && sleep 4" : ""}`;
          return {tool:{name:"bash",arguments:{command}}};
        }
        return {text:"本次结果已提交。"};
      }
      pmCalls += 1;
      if (!dispatched) {
        dispatched = true;
        return {tool:{name:"bash",arguments:{command:'"$GENEHUB_CLI" workflow activate --revision 1 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task structured-task --message "按流程执行并核对真实产物" --no-wait'}}};
      }
      return {text:"已查看工作流结果。"};
    };
    opened.mock.script(...Array.from({length:60},()=>({respond})));
    const pm = await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);
    await opened.client.call({type:"session.send",payload:{sessionId:pm,messageId:"u_structured",text:"执行项目工作流。",attachments:[],continuesRound:null,artifactPreviewBaseUrl:null}});
    let callsBeforeCancel = 0;
    if (scenario === "deadline-restart") {
      await t.tools.waitUntil(()=>existsSync(artifact),20_000);
      opened.client.close();await cli(["daemon","stop"]);
      await new Promise(resolve=>setTimeout(resolve,11000));
      await cli(["daemon","start"]);opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    }
    if (scenario === "restart" || scenario === "cancel" || scenario === "nested-loop-restart") {
      let accepted: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async()=>{
        const reply = await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
        accepted = reply?.type === "workflowRuns" ? reply.data[0] : undefined;
        return accepted?.nodes.some(n=>n.status === "finishing") === true;
      },35_000);
      t.note(`Observed accepted activity ${accepted!.nodes.find(n=>n.status === "finishing")!.id} before host retirement.`);
      if (scenario === "cancel") {
        callsBeforeCancel = pmCalls;
        await opened.client.call({type:"workflow.cancel",payload:{workspaceId:opened.workspaceId,runId:accepted!.id,expectedRevision:accepted!.revision}});
        expectedWorkers = 1; blocked = true;
      } else {
        opened.client.close();
        await cli(["daemon","stop"]);
        await cli(["daemon","start"]);
        opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
      }
    }
    let run: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async()=>{
      const reply = await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
      if (reply?.type !== "workflowRuns") return false;
      t.assertions.assert(reply.data.length <= 1,"loop created another Run");
      run = reply.data[0];
      return !!run && ["completed","blocked","failed","cancelled"].includes(run.status);
    },90_000);
    t.assertions.assert(run?.status === (scenario === "cancel" ? "cancelled" : blocked ? "blocked" : "completed"),`unexpected terminal state: ${JSON.stringify(run)}`);
    const workerNodes = run!.nodes.filter(node=>node.uses === "agent.session");
    t.assertions.assert((scenario === "fail-fast" ? workerNodes.length >= 1 && workerNodes.length <= 2 : workerNodes.length === expectedWorkers),"wrong business iteration count");
    t.assertions.assert(new Set(workerNodes.map(n=>n.sessionId)).size === workerNodes.length,"iterations reused a Worker Session");
    if (expectedWorkers > 0) {
      const entries = readFileSync(artifact,"utf8").trim().split("\n");
      t.assertions.assert((scenario === "fail-fast" ? entries.length >= 1 && entries.length <= 2 : entries.length === expectedWorkers) && new Set(entries).size === entries.length,"actual disk operations duplicated or missing");
    }
    if (scenario === "parallel" || scenario === "parallel-loop" || scenario === "foreach") {
      let live = 0, peak = 0;
      for (const line of readFileSync(concurrencyTrace,"utf8").trim().split("\n")) {
        live += line.startsWith("S ") ? 1 : -1; peak = Math.max(peak,live);
        t.assertions.assert(live >= 0 && live <= 2,"real activity concurrency exceeded scope bound");
      }
      t.assertions.assert(peak === 2 && live === 0,"independent branches did not overlap or failed to finish");
    }
    const published = run!.nodes.some(node=>node.uses === "result.publish" && node.status === "completed");
    t.assertions.assert(published === !blocked,"publication did not follow loop outcome");
    for (const node of workerNodes) {
      const reply = await opened.client.call({type:"session.get",payload:{sessionId:node.sessionId!}});
      t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.status === "closed","settled Worker was not retired");
    }
    if (scenario === "cancel") {
      t.assertions.assert(pmCalls === callsBeforeCancel && !run!.reportPending,"direct cancellation woke PM");
    }
    const structureView = run!.structure as {schema?:string;instances?:Array<{nodeId:string;scope:Array<{blockId:string;round:number|null;itemId?:string}>}>} | undefined;
    t.assertions.assert(structureView?.schema === "genehub.workflow.structure.v1","missing product structure projection");
    t.assertions.assert(workerNodes.every(n=>structureView!.instances?.some(i=>i.nodeId === n.id && i.scope.length > 0)),"completed activity lost its structural address");
    if (scenario === "stale-result") t.assertions.assert(workerNodes[0]?.outcome === "changesRequested","old iteration result was overwritten");
    if (scenario === "item-keys") {
      const keys = new Set(structureView!.instances?.flatMap(i=>i.scope.flatMap(s=>s.itemId ? [s.itemId] : [])));
      t.assertions.assert(keys.has("front") && keys.has("back") && keys.size === 2,"batch outcomes lost stable business item keys");
    }
    if (scenario === "nested-loop" || scenario === "nested-loop-restart") {
      const rounds = structureView!.instances!.filter(i=>workerNodes.some(n=>n.id === i.nodeId)).map(i=>i.scope.filter(s=>s.round !== null).map(s=>s.round).join("/"));
      t.assertions.assert([...rounds].sort().join(",") === "1/1,1/2,2/1,2/2","nested loop instances did not reset their local rounds");
    }
    const report = await opened.client.call({type:"workflow.check",payload:{workspaceId:opened.workspaceId,runId:run!.id}});
    t.assertions.assert(report?.type === "workflowCheck" && !report.data.findings.some(f=>f.code === "missingNodeRecord"),"checker treated activity definitions as missing execution instances");
  } finally { opened.client.close(); await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env); await opened.mock.stop(); }
});

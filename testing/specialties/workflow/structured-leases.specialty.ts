import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {defineSpecialty,runGenetAsync} from "../../framework/public.ts";
const q=(s:string)=>`'${s.replaceAll("'",`'\\''`)}'`;
for(const independent of [false,true])defineSpecialty({
 id:`specialty.workflow.structured-leases.${independent?"independent":"shared"}`,
 title:independent?"Independent repositories overlap under structured parallel":"Sibling writers hand over the shared branch after retirement",
 oracle:"Real Git commits and process-written entry/exit records prove resource exclusivity and actual allowed overlap",
 catches:["all parallel writers serialized globally","same branch written concurrently","later node cannot acquire the previous writer lease","commit evidence points to another repository"],
 tags:["core","workflow","structured-workflow"],llm:{default:"mock"},expectedDurationMs:20_000,timeoutMs:120_000,
 resources:{environments:1,cpu:2,memoryMb:768,io:1,browser:0,pool:"standard"},surfaces:["daemon","agent","git","genet-cli"],productInterfaces:["workflow.dispatch","workflow.get","workflow.complete"],
},async t=>{
 t.data.git.init(t.env.workspace);
 const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
 const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,encoding:"utf8"});t.assertions.assert(r.status===0,r.stderr);return r.stdout.trim();};
 try{
  const init=await runGenetAsync(opened.daemon.genet,["workflow","init","--agent","genet","--model","deepseek/deepseek-v4-flash"],opened.daemon.env,{cwd:opened.workspaceRoot});
  t.assertions.assert(init.code===0,init.stderr);
  const roots=independent?["front","back"].map(name=>path.join(opened.workspaceRoot,name)):[opened.workspaceRoot,opened.workspaceRoot];
  for(const root of new Set(roots)){
    mkdirSync(root,{recursive:true});t.data.git.init(root);
    writeFileSync(path.join(root,"seed.txt"),"initial");
    git(root,"add",".");git(root,"commit","-m","lease fixture");
  }
  const source=path.join(opened.workspaceRoot,".genethub/workflow");
  writeFileSync(path.join(source,"prompts/direct-worker.md"),"STRUCTURED_LEASE_WORKER: write only in the assigned task directory and report its commit.");
  writeFileSync(path.join(source,"workflows/direct-change.yaml"),JSON.stringify({schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,
    nodes:["front","back"].map(id=>({id,uses:"agent.session",with:{role:"worker",workspace:independent?id:".",writeLease:{targetRef:"current",ttlSeconds:900}},completion:{all:[{key:"commit",verify:"git.commitOnTarget"}]}})),
    structure:{body:{id:"team",type:"parallel",branches:["front","back"].map(id=>({id:`${id}-step`,type:"task",activity:id,input:{op:"literal",value:id==="front"?"FRONT_ACTIVITY":"BACK_ACTIVITY"}}))}},
  }));
  // Source edits are intentional fixture inputs; workers start from clean repos.
  git(opened.workspaceRoot,"add",".");git(opened.workspaceRoot,"commit","-m","structured lease definition");
  const trace=path.join(opened.workspaceRoot,".git","concurrency.txt");
  const seen=new Set<string>();let dispatched=false;
  await t.flows.main.configureMockProvider(opened.client,opened.mock);
  opened.mock.script(...Array.from({length:30},()=>({respond:(request:unknown)=>{
    const body=JSON.stringify(request);
    if(body.includes("STRUCTURED_LEASE_WORKER")){
      const operation=body.match(/当前节点：(operation-\d+)/)?.[1];if(!operation)throw Error("missing operation");
      if(!seen.has(operation)){
        seen.add(operation);const index=body.includes("FRONT_ACTIVITY")?0:1;
        const barrier=independent?`while [ "$(grep -c '^S ' ${q(trace)})" -lt 2 ]; do sleep 0.02; done;`:"sleep 0.2;";
        return {tool:{name:"bash",arguments:{command:`cd ${q(roots[index]!)} && printf 'S %s\\n' ${q(operation)} >> ${q(trace)}; ${barrier} printf '%s' ${q(operation)} > ${q(`${operation}.txt`)} && git add . && git commit -m ${q(operation)} && printf 'D %s\\n' ${q(operation)} >> ${q(trace)} && "$GENEHUB_CLI" workflow complete --evidence commit="$(git rev-parse HEAD)"`}}};
      }
      return {text:"已提交代码及证据。"};
    }
    if(!dispatched){dispatched=true;return {tool:{name:"bash",arguments:{command:'"$GENEHUB_CLI" workflow activate --revision 1 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task lease-team --message "两个实现各自提交" --no-wait'}}};}
    return {text:"小队已完成。"};
  }})));
  const pm=await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);
  await t.flows.main.sendPrompt(opened.client,pm,"执行两路实现。");
  let run:import("@genehub/proto").WorkflowRunStatus|undefined;
  await t.tools.waitUntil(async()=>{const r=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});run=r?.type==="workflowRuns"?r.data[0]:undefined;return !!run && ["completed","blocked","failed"].includes(run.status);},75_000);
  t.assertions.assert(run?.status==="completed",`lease workflow failed: ${JSON.stringify(run)}`);
  let live=0,peak=0;
  for(const line of readFileSync(trace,"utf8").trim().split("\n")){live+=line.startsWith("S ")?1:-1;peak=Math.max(peak,live);t.assertions.assert(live>=0 && live<=(independent?2:1),"writer overlap violated resource scope");}
  t.assertions.assert(live===0 && peak===(independent?2:1) && seen.size===2,"writers did not follow declared concurrency");
  for(const node of run!.nodes){const commit=node.evidence.commit;t.assertions.assert(!!commit && roots.some(root=>spawnSync("git",["cat-file","-e",`${commit}^{commit}`],{cwd:root}).status===0),"reported commit does not exist");}
  for(const root of new Set(roots))t.assertions.assert(git(root,"status","--porcelain")==="","writer left uncommitted effects");
 }finally{opened.client.close();await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env);await opened.mock.stop();}
});

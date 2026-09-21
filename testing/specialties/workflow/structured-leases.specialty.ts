import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {defineSpecialty,runGenetAsync} from "../../framework/public.ts";
const q=(s:string)=>`'${s.replaceAll("'",`'\\''`)}'`;
// `derived` is the parallel-branch shape: the directories do not exist when the
// Run is dispatched, an ordinary node creates them, and each sibling resolves
// its own from `with.workspace`.
for(const scenario of ["shared","independent","derived"] as const)defineSpecialty({
 id:`specialty.workflow.structured-leases.${scenario}`,
 title:scenario==="shared"?"Sibling writers hand over the shared branch after retirement"
  :scenario==="independent"?"Independent repositories overlap under structured parallel"
  :"Directories produced during the Run carry genuinely concurrent branch writers",
 oracle:"Real Git commits and process-written entry/exit records prove resource exclusivity and actual allowed overlap",
 catches:["all parallel writers serialized globally","same branch written concurrently","later node cannot acquire the previous writer lease","commit evidence points to another repository","expression-resolved directories collapse onto one lease","public node timestamps cannot distinguish overlap from serialization"],
 tags:["core","workflow","structured-workflow"],llm:{default:"mock"},expectedDurationMs:20_000,timeoutMs:120_000,
 resources:{environments:1,cpu:2,memoryMb:768,io:1,browser:0,pool:"standard"},surfaces:["daemon","agent","git","genet-cli"],productInterfaces:["workflow.dispatch","workflow.get","workflow.complete"],
},async t=>{
 t.data.git.init(t.env.workspace);
 const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
 const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,encoding:"utf8"});t.assertions.assert(r.status===0,r.stderr);return r.stdout.trim();};
 try{
  // Worktrees live under the ignored `.genethub/`, so branch writers never make
  // the mainline directory dirty and never block its own lease.
  const derived=["front","back"].map(name=>({id:name,workspace:`.genethub/temp/${name}`}));
  const roots=scenario==="independent"?["front","back"].map(name=>path.join(opened.workspaceRoot,name))
   :scenario==="derived"?derived.map(item=>path.join(opened.workspaceRoot,item.workspace))
   :[opened.workspaceRoot,opened.workspaceRoot];
  for(const root of new Set(scenario==="independent"?roots:[opened.workspaceRoot])){
    mkdirSync(root,{recursive:true});t.data.git.init(root);
    writeFileSync(path.join(root,"seed.txt"),"initial");
    git(root,"add",".");git(root,"commit","-m","lease fixture");
  }
  const source=t.flows.main.seedDirectChangePackage({projectRoot:opened.workspaceRoot});
  writeFileSync(path.join(source,"prompts/direct-worker.md"),"STRUCTURED_LEASE_WORKER: write only in the assigned task directory and report its commit.");
  const writer=(id:string,workspace:unknown)=>({id,uses:"agent.session",with:{role:"worker",workspace,writeLease:{ttlSeconds:900}},completion:{all:[{key:"commit",verify:"value.nonEmpty"}]}});
  const definition=scenario==="derived"?{
    nodes:[
      {id:"prepare",uses:"agent.session",with:{role:"worker"},completion:{output:{type:"array",minItems:2,maxItems:2,items:{type:"object",properties:{id:{type:"string",minLength:1},workspace:{type:"string",minLength:1}}}}}},
      writer("write",{op:"ref",path:"/input/workspace"}),
    ],
    structure:{body:{id:"team",type:"sequence",steps:[
      {id:"prepare-branches",type:"task",activity:"prepare",input:{op:"literal",value:"PREPARE_ACTIVITY"}},
      {id:"branches",type:"forEach",items:{op:"ref",path:"/results/prepare-branches/output"},key:{op:"ref",path:"/item/id"},maxConcurrency:2,
       body:{id:"branch-write",type:"task",activity:"write",input:{op:"ref",path:"/item"}}},
    ]}},
  }:{
    nodes:["front","back"].map(id=>writer(id,scenario==="independent"?id:".")),
    structure:{body:{id:"team",type:"parallel",branches:["front","back"].map(id=>({id:`${id}-step`,type:"task",activity:id,input:{op:"literal",value:id==="front"?"FRONT_ACTIVITY":"BACK_ACTIVITY"}}))}},
  };
  writeFileSync(path.join(source,"flows/direct-change.yaml"),JSON.stringify({schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,...definition}));
  // Source edits are intentional fixture inputs; workers start from clean
  // repos, and a write lease requires that. The `independent` scenario
  // deliberately leaves the project root outside Git.
  if(existsSync(path.join(opened.workspaceRoot,".git"))){
    const activated=await runGenetAsync(opened.daemon.genet,["workflow","activate","--revision","0"],opened.daemon.env,{cwd:opened.workspaceRoot});
    t.assertions.assert(activated.code===0,activated.stderr||activated.stdout);
    git(opened.workspaceRoot,"add",".");git(opened.workspaceRoot,"commit","-m","structured lease definition");
  }
  const mainline=git(opened.workspaceRoot,"rev-parse","HEAD");
  t.assertions.assert(
    git(opened.workspaceRoot,"status","--porcelain")==="",
    `fixture left the mainline dirty: ${git(opened.workspaceRoot,"status","--porcelain")}`,
  );
  const trace=path.join(opened.workspaceRoot,".git","concurrency.txt");
  const seen=new Set<string>();let dispatched=false;
  await t.flows.main.configureMockProvider(opened.client,opened.mock);
  opened.mock.script(...Array.from({length:30},()=>({respond:(request:unknown)=>{
    const body=JSON.stringify(request);
    if(body.includes("STRUCTURED_LEASE_WORKER")){
      const operation=body.match(/当前节点：(operation-\d+)/)?.[1];if(!operation)throw Error("missing operation");
      if(!seen.has(operation)){
        seen.add(operation);
        if(body.includes("PREPARE_ACTIVITY")){
          const add=derived.map(item=>`git worktree add -b ${q(`branch-${item.id}`)} ${q(item.workspace)} HEAD`).join(" && ");
          return {tool:{name:"bash",arguments:{command:`cd ${q(opened.workspaceRoot)} && ${add} && "$GENEHUB_CLI" workflow complete --output ${q(JSON.stringify(derived))}`}}};
        }
        const index=body.includes("FRONT_ACTIVITY")||body.includes(derived[0]!.workspace)?0:1;
        const barrier=scenario==="shared"?"sleep 0.2;":`while [ "$(grep -c '^S ' ${q(trace)})" -lt 2 ]; do sleep 0.02; done;`;
        return {tool:{name:"bash",arguments:{command:`cd ${q(roots[index]!)} && printf 'S %s\\n' ${q(operation)} >> ${q(trace)}; ${barrier} printf '%s' ${q(operation)} > ${q(`${operation}.txt`)} && git add . && git commit -m ${q(operation)} && printf 'D %s\\n' ${q(operation)} >> ${q(trace)} && "$GENEHUB_CLI" workflow complete --evidence commit="$(git rev-parse HEAD)"`}}};
      }
      return {text:"已提交代码及证据。"};
    }
    if(!dispatched){dispatched=true;return {tool:{name:"bash",arguments:{command:'"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task lease-team --message "两个实现各自提交" --no-wait'}}};}
    return {text:"小队已完成。"};
  }})));
  const pm=await t.flows.main.createBuiltinSession(opened.client,opened.workspaceId);
  await t.flows.main.sendPrompt(opened.client,pm,"执行两路实现。");
  let run:import("@genehub/proto").WorkflowRunStatus|undefined;
  await t.tools.waitUntil(async()=>{const r=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});run=r?.type==="workflowRuns"?r.data[0]:undefined;return !!run && ["completed","blocked","failed"].includes(run.status);},75_000);
  t.assertions.assert(run?.status==="completed",`lease workflow failed: ${JSON.stringify(run)}`);
  const overlapping=scenario!=="shared";
  let live=0,peak=0;
  for(const line of readFileSync(trace,"utf8").trim().split("\n")){live+=line.startsWith("S ")?1:-1;peak=Math.max(peak,live);t.assertions.assert(live>=0 && live<=(overlapping?2:1),"writer overlap violated resource scope");}
  t.assertions.assert(live===0 && peak===(overlapping?2:1) && seen.size===(scenario==="derived"?3:2),"writers did not follow declared concurrency");
  const writers=run!.nodes.filter(node=>!!node.evidence.commit);
  t.assertions.assert(writers.length===2,"expected exactly two committing writers");
  for(const node of writers){const commit=node.evidence.commit;t.assertions.assert(!!commit && roots.some(root=>spawnSync("git",["cat-file","-e",`${commit}^{commit}`],{cwd:root}).status===0),"reported commit does not exist");}
  for(const root of new Set(roots))t.assertions.assert(git(root,"status","--porcelain")==="","writer left uncommitted effects");
  // The public transition clock must agree with what actually happened: a
  // reader decides parallel width from these facts alone.
  for(const node of run!.nodes){
    const {pendingSinceMs:pending,assignedAtMs:assigned,settledAtMs:settled}=node;
    t.assertions.assert(!!pending && !!assigned && !!settled && pending<=assigned && assigned<=settled,`node ${node.id} lost its transition clock: ${JSON.stringify(node)}`);
    t.assertions.assert(node.attempt===0,`node ${node.id} reported an unexpected retry`);
  }
  const [first,second]=writers.map(node=>[node.assignedAtMs!,node.settledAtMs!] as const);
  t.assertions.assert((first![0]<second![1] && second![0]<first![1])===overlapping,"node timestamps disagree with the observed overlap");
  if(scenario==="derived"){
    const committed=writers.map(node=>node.evidence.commit);
    for(const [index,item] of derived.entries()){
      const worktree=roots[index]!;
      t.assertions.assert(git(worktree,"rev-parse","--abbrev-ref","HEAD")===`branch-${item.id}`,"a branch writer left its own branch");
      t.assertions.assert(committed.includes(git(worktree,"rev-parse","HEAD")),"a branch tip is not the commit its writer reported");
    }
    t.assertions.assert(git(opened.workspaceRoot,"rev-parse","HEAD")===mainline && git(opened.workspaceRoot,"status","--porcelain")==="","branch work reached or dirtied the mainline directory");
  }
 }finally{opened.client.close();await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env);await opened.mock.stop();}
});

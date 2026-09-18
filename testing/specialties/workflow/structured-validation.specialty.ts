import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {defineSpecialty,runGenetAsync} from "../../framework/public.ts";

const task={id:"work-step",type:"task",activity:"work"};
const library={schema:"genehub.workflow.procedures.v1",id:"shared",version:1,procedures:{build:{id:"build-body",type:"task",activity:"work"}}};
const callShared={body:{id:"entry",type:"call",procedure:"build"}};
const invalid: Array<{name:string;structure?:Record<string,unknown>;definition?:Record<string,unknown>;library?:Record<string,unknown>;reason:string}>=[
  {name:"recursion",structure:{body:{id:"entry",type:"call",procedure:"again"},procedures:{again:{id:"recursive",type:"call",procedure:"again"}}},reason:"recursive"},
  {name:"mutual-recursion",structure:{body:{id:"entry",type:"call",procedure:"one"},procedures:{one:{id:"call-two",type:"call",procedure:"two"},two:{id:"call-one",type:"call",procedure:"one"}}},reason:"recursive"},
  {name:"pointer",structure:{body:{...task,input:{op:"ref",path:"/bad~escape"}}},reason:"Pointer"},
  {name:"duplicate-block",structure:{body:{id:"sequence",type:"sequence",steps:[task,task]}},reason:"duplicate block"},
  {name:"missing-procedure",structure:{body:{id:"entry",type:"call",procedure:"missing"}},reason:"unknown procedure"},
  {name:"unbounded-concurrency",structure:{body:{id:"batch",type:"forEach",items:{op:"literal",value:[]},maxConcurrency:0,body:task}},reason:"concurrency"},
  {name:"break-outside-loop",structure:{body:{id:"exit",type:"break",value:{op:"literal",value:null}}},reason:"lexical loop"},
  {name:"break-through-call",structure:{body:{id:"loop",type:"loop",maxRounds:1,condition:{op:"literal",value:true},body:{id:"call",type:"call",procedure:"exit"}},procedures:{exit:{id:"exit",type:"break",value:{op:"literal",value:null}}}},reason:"lexical loop"},
  {name:"parallel-break",structure:{body:{id:"batch",type:"forEach",items:{op:"literal",value:[1,2]},maxConcurrency:2,body:{id:"exit",type:"break",value:{op:"literal",value:null}}}},reason:"lexical loop"},
  {name:"parallel-fold",structure:{body:{id:"batch",type:"forEach",items:{op:"literal",value:[]},maxConcurrency:2,initial:{op:"literal",value:[]},update:{op:"ref",path:"/vars"},body:task}},reason:"paired and serial"},
  {name:"unpaired-fold",structure:{body:{id:"batch",type:"forEach",items:{op:"literal",value:[]},maxConcurrency:1,initial:{op:"literal",value:[]},body:task}},reason:"paired and serial"},
  // A shared procedure library is resolved into this one program, so every
  // collision and every missing part must be refused instead of guessed.
  {name:"missing-library",definition:{include:["shared"]},structure:callShared,reason:"子过程库"},
  {name:"library-schema",definition:{include:["shared"]},structure:callShared,library:{...library,schema:"genehub.workflow.definition.v2"},reason:"子过程库 schema"},
  {name:"library-id",definition:{include:["shared"]},structure:callShared,library:{...library,id:"other"},reason:"与 include 不一致"},
  {name:"library-empty",definition:{include:["shared"]},structure:callShared,library:{...library,procedures:{}},reason:"至少一个子过程"},
  {name:"library-procedure-collision",definition:{include:["shared"]},structure:{...callShared,procedures:{build:{id:"inline-build",type:"task",activity:"work"}}},library,reason:"与已有子过程重名"},
  {name:"library-node-collision",definition:{include:["shared"]},structure:callShared,library:{...library,nodes:[{id:"work",uses:"agent.session",with:{role:"worker"}}]},reason:"与已有节点重名"},
  {name:"library-block-collision",definition:{include:["shared"]},structure:{body:{id:"sequence",type:"sequence",steps:[{id:"entry",type:"call",procedure:"build"},{id:"build-body",type:"task",activity:"work"}]}},library,reason:"duplicate block"},
  {name:"duplicate-include",definition:{include:["shared","shared"]},structure:callShared,library,reason:"重复 include"},
  {name:"too-many-includes",definition:{include:Array.from({length:9},(_,index)=>`shared-${index}`)},structure:callShared,library,reason:"include 数量"},
  {name:"include-without-structure",definition:{schema:"genehub.workflow.definition.v1",include:["shared"],entry:"work",structure:null},library,reason:"include 需要结构化"},
];
for(const fixture of invalid)defineSpecialty({
 id:`specialty.workflow.structured-validation.${fixture.name}`,title:`Invalid structured ${fixture.name} cannot replace the active workflow`,
 oracle:"Public project inspection reports the source error without changing active revision or starting a Worker",
 catches:["recursive calls accepted","malformed structure silently falls back to DAG","invalid candidate changes activation"],
 tags:["core","workflow","structured-workflow","structured-data"],llm:{default:"mock"},expectedDurationMs:5_000,timeoutMs:60_000,
 resources:{environments:1,cpu:1,memoryMb:768,io:1,browser:0,pool:"standard"},surfaces:["daemon","genet-cli","workbench-client"],productInterfaces:["workflow.inspect","workflow.init","workflow.history"],
},async t=>{
 t.data.git.init(t.env.workspace);
 const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
 try{
  const init=await runGenetAsync(opened.daemon.genet,["workflow","init","--agent","genet"],opened.daemon.env,{cwd:opened.workspaceRoot});
  t.assertions.assert(init.code===0,init.stderr);
  const before=await opened.client.call({type:"workflow.inspect",payload:{workspaceId:opened.workspaceId}});
  const source=path.join(opened.workspaceRoot,".genethub/workflow");
  if(fixture.library){
   mkdirSync(path.join(source,"procedures"),{recursive:true});
   writeFileSync(path.join(source,"procedures/shared.yaml"),JSON.stringify(fixture.library));
  }
  writeFileSync(path.join(source,"workflows/direct-change.yaml"),JSON.stringify({schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,nodes:[{id:"work",uses:"agent.session",with:{role:"worker"}}],structure:fixture.structure,...fixture.definition}));
  const after=await opened.client.call({type:"workflow.inspect",payload:{workspaceId:opened.workspaceId}});
  t.assertions.assert(before?.type==="workflowProject" && after?.type==="workflowProject" && after.data.activationRevision===before.data.activationRevision && !!after.data.candidateError?.includes(fixture.reason),`invalid source did not produce expected error: ${JSON.stringify(after)}`);
  const history=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
  t.assertions.assert(history?.type==="workflowRuns" && history.data.length===0,"invalid source launched a Run");
 }finally{opened.client.close();await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env);await opened.mock.stop();}
});

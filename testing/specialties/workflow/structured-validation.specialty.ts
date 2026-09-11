import {writeFileSync} from "node:fs";
import path from "node:path";
import {defineSpecialty,runGenetAsync} from "../../framework/public.ts";

const task={id:"work-step",type:"task",activity:"work"};
const invalid=[
  {name:"recursion",structure:{body:{id:"entry",type:"call",procedure:"again"},procedures:{again:{id:"recursive",type:"call",procedure:"again"}}},reason:"recursive"},
  {name:"mutual-recursion",structure:{body:{id:"entry",type:"call",procedure:"one"},procedures:{one:{id:"call-two",type:"call",procedure:"two"},two:{id:"call-one",type:"call",procedure:"one"}}},reason:"recursive"},
  {name:"pointer",structure:{body:{...task,input:{op:"ref",path:"/bad~escape"}}},reason:"Pointer"},
  {name:"duplicate-block",structure:{body:{id:"sequence",type:"sequence",steps:[task,task]}},reason:"duplicate block"},
  {name:"missing-procedure",structure:{body:{id:"entry",type:"call",procedure:"missing"}},reason:"unknown procedure"},
  {name:"unbounded-concurrency",structure:{body:{id:"batch",type:"forEach",items:{op:"literal",value:[]},maxConcurrency:0,body:task}},reason:"concurrency"},
];
for(const fixture of invalid)defineSpecialty({
 id:`specialty.workflow.structured-validation.${fixture.name}`,title:`Invalid structured ${fixture.name} cannot replace the active workflow`,
 oracle:"Public project inspection reports the source error without changing active revision or starting a Worker",
 catches:["recursive calls accepted","malformed structure silently falls back to DAG","invalid candidate changes activation"],
 tags:["core","workflow","structured-workflow"],llm:{default:"mock"},expectedDurationMs:5_000,timeoutMs:60_000,
 resources:{environments:1,cpu:1,memoryMb:768,io:1,browser:0,pool:"standard"},surfaces:["daemon","genet-cli","workbench-client"],productInterfaces:["workflow.inspect","workflow.init","workflow.history"],
},async t=>{
 t.data.git.init(t.env.workspace);
 const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
 try{
  const init=await runGenetAsync(opened.daemon.genet,["workflow","init","--agent","genet"],opened.daemon.env,{cwd:opened.workspaceRoot});
  t.assertions.assert(init.code===0,init.stderr);
  const before=await opened.client.call({type:"workflow.inspect",payload:{workspaceId:opened.workspaceId}});
  writeFileSync(path.join(opened.workspaceRoot,".genethub/workflow/workflows/direct-change.yaml"),JSON.stringify({schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,nodes:[{id:"work",uses:"agent.session",with:{role:"worker"}}],structure:fixture.structure}));
  const after=await opened.client.call({type:"workflow.inspect",payload:{workspaceId:opened.workspaceId}});
  t.assertions.assert(before?.type==="workflowProject" && after?.type==="workflowProject" && after.data.activationRevision===before.data.activationRevision && !!after.data.candidateError?.includes(fixture.reason),`invalid source did not produce expected error: ${JSON.stringify(after)}`);
  const history=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
  t.assertions.assert(history?.type==="workflowRuns" && history.data.length===0,"invalid source launched a Run");
 }finally{opened.client.close();await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env);await opened.mock.stop();}
});

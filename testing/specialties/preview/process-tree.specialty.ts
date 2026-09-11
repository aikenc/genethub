import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.processes.stop-subtree-keeps-agent",
  title:"Ending one agent-owned subtree preserves its sibling and the agent itself",
  oracle:"Real ACP agent spawns child/grandchild/sibling; process.kill removes only child/grandchild, then the same agent answers another prompt",
  catches:["WASM process census always empty","killing whole agent group","orphan grandchild","process snapshot loses workspace"],
  tags:["core","processes"],llm:{default:"none"},expectedDurationMs:15000,timeoutMs:90000,
  resources:{environments:1,cpu:2,memoryMb:768,io:1,browser:0,pool:"standard"},
  surfaces:["daemon","agent","workbench"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genehub-host-local","genehub_guest.wasm"],
},async t=>{
  const opened=await t.flows.branches.openControlledAgentSession({openRoot:t.openRoot,lease:t.env,agent:{profile:"normal",processTree:true}});
  try{
    await t.flows.main.sendPrompt(opened.client,opened.sessionId,'Start a background tree.');
    await opened.waitForTerminal();
    const created=opened.journal().find(e=>e.event==='tree-created');
    t.assertions.assert(created!==undefined,'external agent did not create tree');
    if(!created)throw new Error('no tree');
    const root=Number(created.rootPid),leaf=Number(created.leafPid),sibling=Number(created.siblingPid);
    const snapshot=await opened.client.call({type:'process.workspaceList',payload:{workspaceId:opened.workspaceId}});
    t.assertions.assert(snapshot?.type==='processes','no process inventory');
    if(snapshot?.type!=='processes')throw new Error('wrong snapshot');
    t.assertions.assert(snapshot.data.some(p=>p.pid===leaf&&p.parentPid===root&&p.workspaceId===opened.workspaceId),'missing child ancestry');
    await opened.client.call({type:'process.kill',payload:{sessionId:opened.sessionId,pid:root}});
    await t.tools.waitUntil(()=>!t.flows.branches.processAlive(root)&&!t.flows.branches.processAlive(leaf),10000);
    t.assertions.assert(t.flows.branches.processAlive(sibling),'sibling was killed');
    const before=opened.events.filter(e=>e.type==='turnCompleted').length;
    await t.flows.main.sendPrompt(opened.client,opened.sessionId,'Continue after ending the child.');
    await t.tools.waitUntil(()=>opened.events.filter(e=>e.type==='turnCompleted').length>before,15000);
    await opened.client.call({type:'process.killAll',payload:{sessionId:opened.sessionId}});
    await t.tools.waitUntil(()=>!t.flows.branches.processAlive(sibling),10000);
  }finally{await opened.dispose()}
});

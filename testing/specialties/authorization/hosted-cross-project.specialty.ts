import type { Request } from "@genehub/proto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openWorkspacePeer } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.authorization.hosted-cross-project",
  title:"A workspace-routed complete connection keeps its locator and can work in another project",
  oracle:"real Cloud workspace admission previews its selected project by opaque handle, then creates/configures another Space and completes a file-writing Agent task there; a paired device also configures that Space without project ACLs",
  catches:["workspace locator is still an authorization scope","full Channel or Device cannot configure Space","resource route loses its selected workspace mapping"],
  tags:["core","authorization-depth","cloud-server"],llm:{default:"mock"},requiredRepos:["cloud"],
  expectedDurationMs:30000,timeoutMs:150000,resources:{environments:1,cpu:2,memoryMb:1536,io:1,browser:0},
  surfaces:["cloud-server","daemon","relay","workbench-client"],productInterfaces:["hub-http","@genehub/workbench/client"],
},async t=>{
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let routed:Awaited<ReturnType<typeof openWorkspacePeer>>|undefined;
  try{
    await t.flows.main.configureMockProvider(opened.client,opened.mock);
    writeFileSync(path.join(opened.workspaceRoot,"selected.txt"),"selected workspace");
    routed=await openWorkspacePeer({openRoot:t.openRoot,lease:t.env,client:opened.client,workspaceId:opened.workspaceId});
    const selected=await routed.client.preview(routed.workspaceId,`${opened.rootHandle}/selected.txt`);
    t.assertions.assert(Buffer.from(selected.bytes).toString()==="selected workspace","opaque placement lost its local workspace");
    const root=path.join(t.env.workspace,"another-project");mkdirSync(root,{recursive:true});
    const other=await routed.client.call({type:"workspace.open",payload:{root}});if(other?.type!=="workspace")throw new Error("full channel could not open another project");
    const configured=await routed.client.call({type:"agentSpace.configure",payload:{workspaceId:other.data.id,expectedRevision:0,operation:{kind:"setComponent",componentId:"worker",enabled:true,role:"coder"}}});
    t.assertions.assert(configured?.type==="workspace","full Channel could not configure another Space");
    const paired=await t.flows.main.pairDevice(opened.client,opened.daemon,"cross-project-device");
    try{
      const next=await paired.client.call({type:"agentSpace.configure",payload:{workspaceId:other.data.id,expectedRevision:1,operation:{kind:"setLifecycle",lifecycle:"pooled"}}});
      t.assertions.assert(next?.type==="workspace","full Device could not configure another Space");
    }finally{paired.client.close();}
    opened.mock.script({tool:{name:"write",arguments:{path:"channel-result.txt",content:"written in second project"}}},{text:"Done"});
    const session=await t.flows.main.createBuiltinSession(routed.client,other.data.id);
    const events=await t.flows.main.attachEventLog(routed.client,session);
    await t.flows.main.sendPrompt(routed.client,session,"Write the file in this project");
    await t.tools.waitUntil(()=>events.some(event=>event.type==="turnCompleted"),30000);
    t.assertions.assert(readFileSync(path.join(root,"channel-result.txt"),"utf8")==="written in second project","Channel Agent did not act in target project");
    const handle=other.data.folders[0]!.rootHandle;
    const result=await routed.client.preview(other.data.id,`${handle}/channel-result.txt`);
    t.assertions.assert(Buffer.from(result.bytes).toString()==="written in second project","workspace locator still confines full file reads");
    const completed = (events.find(event => event.type === "turnCompleted")?.raw as {event?:{turnId?:string}})?.event;
    if (!completed?.turnId) throw new Error("source turn identity absent");
    const exported = await routed.client.call({type:"session.forkExport",payload:{sessionId:session,turnId:completed.turnId}});
    if (exported?.type !== "forkTransfer") throw new Error("portable fork transfer absent");
    // Replace the deleted request_workspace ACL projection with actual public
    // create/fork/import behavior. The connection arrived through the first
    // workspace; every explicit destination below must remain the second one.
    const target = {agentId:"genet",workspaceId:other.data.id,runtimeValues:{}};
    const operations: Request[] = [
      {type:"session.createRouted",payload:{workspaceId:other.data.id,tags:["Flash"],mediaTags:[],title:null,cwd:null}},
      {type:"session.fork",payload:{sessionId:session,turnId:completed.turnId,target}},
      {type:"session.forkImport",payload:{transfer:exported.data,target}},
      {type:"session.forkRouted",payload:{sessionId:session,turnId:completed.turnId,workspaceId:other.data.id,tags:["Flash"]}},
      {type:"session.forkImportRouted",payload:{transfer:exported.data,workspaceId:other.data.id,tags:["Flash"]}},
    ];
    const ids = new Set<string>();
    for (const operation of operations) {
      const reply = await routed.client.call(operation);
      t.assertions.assert(reply?.type === "session" && reply.data.workspaceId === other.data.id, `${operation.type} lost its destination to the connection locator`);
      if (reply?.type !== "session") throw new Error(`${operation.type} returned no Session`);
      ids.add(reply.data.id);
      const snapshot = await opened.client.call({type:"session.get",payload:{sessionId:reply.data.id}});
      t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.workspaceId === other.data.id && snapshot.data.summary.cwd === root, `${operation.type} persisted in the wrong workspace`);
    }
    t.assertions.assert(ids.size === operations.length, "independent create/fork/import operations reused a Session identity");
    t.note("Full Cloud connection: cross-project Space, actual Agent file effect, preview and all five routed/concrete create/fork/import destination paths. Share identity restrictions are covered separately.");
  }finally{await routed?.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});

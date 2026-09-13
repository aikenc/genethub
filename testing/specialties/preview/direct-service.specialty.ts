import { spawn } from "node:child_process";
import { cp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.preview.python-direct-service",
  title:"Installed Skill Python application registers without Node and appears in workspace processes",
  oracle:"Copied installed application carries binary HTTP and WS, appears with a scoped preview entry, rejects unauthorized and stale shutdown, and removes its registration on stop",
  catches:["source-tree-only Skill assets", "Node-only service protocol", "service credentials leaked in process list", "stale run stops a new application", "service shutdown leaves registration"],
  tags: ["network-risk-v2", "core","service-preview","builtin-skills"], llm:{default:"none"},
  expectedDurationMs:12000,timeoutMs:90000,
  resources:{environments:1,cpu:2,memoryMb:768,io:1,browser:0,pool:"standard"},
  surfaces:["daemon","workbench","service-preview"],productInterfaces:["@genehub/workbench/client"],
    requirements: [{ kind: "python", env: "GENEHUB_PREVIEW_MEDIA_PYTHON", minVersion: [3, 11], modules: ["aiohttp"] }],
requiredArtifacts:["genehub-host-local","genehub_guest.wasm"],
},async t=>{
  const python=process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
  if(!python)throw new BlockedError("GENEHUB_PREVIEW_MEDIA_PYTHON must point to Python 3.11+ with aiohttp");
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  const copied=join(t.env.workspace,"adapter");
  await cp(join(t.env.data,"builtin-skills/genehub-service-preview/assets/python-adapter"),copied,{recursive:true});
  const entry=join(t.env.workspace,"index.html");
  await writeFile(entry,"<!doctype html><title>内容预览</title>");
  const entryPath=`${opened.rootHandle}/index.html`;
  let output="";
  const launch=()=>{
    const process=spawn(python,[join(copied,"app.py"),"--entry",entry,"--daemon-root",t.env.data],{cwd:copied,stdio:["ignore","pipe","pipe"]});
    process.stdout.on("data",b=>{output=(output+b).slice(-2048)});
    process.stderr.on("data",b=>{output=(output+b).slice(-2048)});
    return process;
  };
  let app=launch();
  let active:ServicePreviewClient|null=null;
  const discover=async()=>{
    let found:ServicePreviewClient|null=null;
    await t.tools.waitUntil(async()=>{
      if(app.exitCode!==null)throw new Error(`application exited: ${output}`);
      found=await ServicePreviewClient.discover(opened.client,opened.workspaceId,entryPath);
      return found!==null;
    },15000);
    return found as unknown as ServicePreviewClient;
  };
  const list=()=>opened.client.call({type:"process.workspaceList",payload:{workspaceId:opened.workspaceId}});
  const stop=(runId:string)=>opened.client.call({type:"process.serviceStop",payload:{workspaceId:opened.workspaceId,entryPath,runId}});
  try {
    active=await discover();
    const firstRun=active.descriptor.runId;
    const snapshot=await list();
    t.assertions.assert(snapshot?.type==="processes","missing process snapshot");
    if(snapshot?.type!=="processes")throw new Error("wrong response");
    const service=snapshot.data.find(p=>p.service?.runId===firstRun);
    t.assertions.assert(service !== undefined && service.pid===app.pid && service.workspaceId===opened.workspaceId && service.service?.entryPath===entryPath && service.service.reachable && service.service.canStop,"application not associated with workspace preview");
    t.assertions.assert(!JSON.stringify(snapshot).includes('"secret"')&&!JSON.stringify(snapshot).includes('"port"'),"private registration leaked");
    const otherRoot=join(t.env.workspace,"other");await mkdir(otherRoot);
    const other=await opened.client.call({type:"workspace.open",payload:{root:otherRoot}});
    t.assertions.assert(other?.type==="workspace","second workspace not opened");
    if(other?.type==="workspace"){
      const isolated=await opened.client.call({type:"process.workspaceList",payload:{workspaceId:other.data.id}});
      t.assertions.assert(isolated?.type==="processes"&&!isolated.data.some(p=>p.service?.runId===firstRun),"service leaked into another workspace");
    }
    const narrow=await t.flows.main.pairDevice(opened.client,opened.daemon,["read","files","session"],"no-services");
    try{
      const hidden=await narrow.client.call({type:"process.workspaceList",payload:{workspaceId:opened.workspaceId}});
      t.assertions.assert(hidden?.type==="processes"&&!hidden.data.some(p=>p.service),"service metadata bypassed Services permission");
      let denied=false;try{await narrow.client.call({type:"process.serviceStop",payload:{workspaceId:opened.workspaceId,entryPath,runId:firstRun}})}catch{denied=true}
      t.assertions.assert(denied,"unprivileged application shutdown succeeded");
    }finally{narrow.client.close()}
    const bytes=new Uint8Array(90000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    const response=await active.fetch('/api/demo/echo',{method:'POST',body:bytes});
    const echoed=new Uint8Array(await response.arrayBuffer());
    t.assertions.assert(response.status===201&&echoed.length===bytes.length&&echoed.every((v,i)=>v===bytes[i]),"Python binary HTTP changed");
    const progress=await active.fetch('/api/demo/stream');const reader=progress.body!.getReader();let count=0;while(!(await reader.read()).done)count++;
    t.assertions.assert(count>=2,"Python progress buffered");
    const received:Uint8Array[]=[];
    const ws=await active.websocket('/api/demo/ws',async p=>{received.push(p)});
    await t.tools.waitUntil(()=>received.some(p=>new TextDecoder().decode(p.slice(1)).includes('"open"')),5000);
    await ws.send({kind:'text',text:'preview'});await ws.send(new Uint8Array([0,255,42]));
    await t.tools.waitUntil(()=>received.some(p=>p[0]===1&&p[2]===255)&&received.some(p=>new TextDecoder().decode(p.slice(1)).includes('preview')),5000);ws.close();
    await stop(firstRun);
    await t.tools.waitUntil(()=>app.exitCode!==null,10000);
    active.close();active=null;
    t.assertions.assert(await ServicePreviewClient.discover(opened.client,opened.workspaceId,entryPath)===null,"shutdown left registration");
    app=launch();active=await discover();
    t.assertions.assert(active.descriptor.runId!==firstRun,"restart reused run identity");
    let stale=false;try{await stop(firstRun)}catch{stale=true}
    t.assertions.assert(stale,"old run shutdown was accepted");
    t.assertions.assert((await active.fetch('/api/demo/health')).ok,"new application was stopped by stale request");
    await stop(active.descriptor.runId);await t.tools.waitUntil(()=>app.exitCode!==null,10000);
  }finally{
    active?.close();app.kill('SIGTERM');opened.client.close();opened.daemon.stop();await opened.mock.stop();
  }
});

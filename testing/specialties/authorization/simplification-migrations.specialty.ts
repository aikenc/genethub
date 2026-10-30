import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenet, type CaseContext } from "../../framework/public.ts";

function migration(id: string, oracle: string, run: (t: CaseContext) => Promise<void>) {
  defineSpecialty({ id: `specialty.authorization.migration.${id}`, title: oracle, oracle,
    catches: ["legacy data silently gains execution", "migration discards the original", "current team session is mistaken for Workflow history"],
    tags: ["core", "authorization", "simplification-migration"], llm: { default: "mock" },
    expectedDurationMs: 30_000, timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
    surfaces: ["daemon", "genet-cli", "filesystem"], productInterfaces: ["genet-cli", "@genehub/workbench/client"] }, run);
}

migration("devices", "Old full credentials survive; restricted and unknown credentials cannot reconnect, and migration is private and idempotent", async t => {
  const opened = await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  const full = await t.flows.main.pairDevice(opened.client,opened.daemon,"legacy-full");
  const limited = await t.flows.main.pairDevice(opened.client,opened.daemon,"legacy-limited");
  const future = await t.flows.main.pairDevice(opened.client,opened.daemon,"future-version");
  const unknown = await t.flows.main.pairDevice(opened.client,opened.daemon,"unknown-grant");
  let fresh: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  try {
    full.client.close(); limited.client.close(); future.client.close(); unknown.client.close(); opened.client.close(); opened.daemon.stop();
    const file=path.join(t.env.data,"devices.json");
    const old=JSON.parse(readFileSync(file,"utf8")); delete old.authorityVersion;
    for(const row of old.devices) {
      row.grantsVersion=1;
      row.grants=row.id===full.deviceId ? ["handshake","read","session","files","git","pty","pty:unconfined","devices","settings","speech","services","update"] : ["handshake","read"];
    }
    old.devices.find((d:{id:string})=>d.id===future.deviceId).grantsVersion=99;
    old.devices.find((d:{id:string})=>d.id===unknown.deviceId).grants=["handshake","read","unknown-future-grant"];
    writeFileSync(file,JSON.stringify(old));
    const start=runGenet(opened.daemon.genet,["daemon","start"],opened.daemon.env);
    t.assertions.assert(start.code===0,"migration prevented startup");
    fresh=await connectProductClient({...daemonEndpoint(opened.daemon)});
    const list=await fresh.call({type:"device.list"});
    t.assertions.assert(list?.type==="devices"&&list.data.devices.length===1&&list.data.devices[0]?.id===full.deviceId,"old restricted authority widened or full identity lost");
    const preserved=await t.flows.main.connectDevice(opened.daemon,full.credential,"returning-full");
    try { t.assertions.assert((await preserved.call({type:"settings.get"}))?.type==="settings","full credential could not configure"); } finally {preserved.close();}
    await Promise.all([limited.credential,future.credential,unknown.credential].map(async credential => {
      let refused=false;
      try {const wronglyAccepted=await t.flows.main.connectDevice(opened.daemon,credential,"retired-legacy");wronglyAccepted.close();} catch {refused=true;}
      t.assertions.assert(refused,"restricted or unknown legacy credential reconnected");
    }));
    const backups=readdirSync(t.env.data).filter(name=>name.startsWith("devices.pre-full-access-"));
    t.assertions.assert(backups.some(name=>JSON.parse(readFileSync(path.join(t.env.data,name),"utf8")).devices.some((d:{id:string})=>d.id===limited.deviceId)),"original limited authorization was not backed up");
    const now=JSON.parse(readFileSync(file,"utf8"));
    t.assertions.assert(now.authorityVersion===1&&now.devices.every((d:Record<string,unknown>)=>!("grants"in d)),"live grant model survived migration");
    fresh.close();opened.daemon.stop();
    t.assertions.assert(runGenet(opened.daemon.genet,["daemon","start"],opened.daemon.env).code===0,"second migration startup failed");
    fresh=await connectProductClient({...daemonEndpoint(opened.daemon)});
    const again=await fresh.call({type:"device.list"});
    t.assertions.assert(again?.type==="devices"&&again.data.devices.length===1&&again.data.devices[0]?.id===full.deviceId,"second startup changed migrated authority");
    t.assertions.assert(readdirSync(t.env.data).filter(name=>name.startsWith("devices.pre-full-access-")).length===backups.length,"second startup repeated migration or backup");
  } finally {fresh?.close();full.client.close();limited.client.close();future.client.close();unknown.client.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});

migration("history", "Legacy Workflow context is readable and forkable but neither queued inputs nor old instructions execute", async t => {
  const opened=await t.flows.main.completeVerifiableTask({openRoot:t.openRoot,lease:t.env,task:{prompt:"Write the requested file",relative:"history-origin.txt",contents:"preserved"}});
  let client: Awaited<ReturnType<typeof connectProductClient>>|undefined;
  try {
    const completed=((opened.events as Array<{type?:string;raw?:unknown}>).find(e=>e.type==="turnCompleted")?.raw as {event?:{type?:string;turnId?:string}})?.event;
    t.assertions.assert(completed?.type==="turnCompleted","no completed source turn");
    if(completed?.type!=="turnCompleted" || !completed.turnId)throw new Error("completed turn missing");
    opened.client.close();opened.daemon.stop();
    const file=path.join(opened.workspaceRoot,".genethub","sessions",opened.sessionId,"meta.json");
    const meta=JSON.parse(readFileSync(file,"utf8"));meta.format=9;delete meta.historyOnly;
    meta.managed={parentSessionId:"s_missing_parent",workflowRunId:"retired-run",workflowId:"retired-workflow",nodeId:"old-node",role:"worker",userInteraction:"readOnly",evidenceScope:{root:opened.workspaceRoot,sessions:{}}};
    meta.managedSystemPrompt="RETIRED_SYSTEM_PROMPT_MUST_NOT_RUN";
    writeFileSync(file,JSON.stringify(meta));
    t.assertions.assert(runGenet(opened.daemon.genet,["daemon","start"],opened.daemon.env).code===0,"restart failed");
    client=await connectProductClient({...daemonEndpoint(opened.daemon)});
    const history=await client.call({type:"session.get",payload:{sessionId:opened.sessionId}});
    t.assertions.assert(history?.type==="snapshot"&&history.data.summary.historyOnly===true&&!("managed"in history.data.summary),"legacy execution became normal running metadata");
    await t.assertions.expectProtocolCode(()=>client!.call({type:"session.send",payload:{sessionId:opened.sessionId,messageId:"must-not-replay",text:"must not execute",attachments:[],artifactPreviewBaseUrl:null,continuesRound:null}}),"badRequest");
    const fork=await client.call({type:"session.fork",payload:{sessionId:opened.sessionId,turnId:completed.turnId,target:{agentId:"genet",workspaceId:opened.workspaceId,runtimeValues:{}}}});
    t.assertions.assert(fork?.type==="session"&&!fork.data.historyOnly,"fork retained retired control binding");
    if(fork?.type!=="session")throw new Error("fork failed");
    opened.mock.script({tool:{name:"write",arguments:{path:"history-fork.txt",content:"ordinary"}}},{text:"Finished"});
    const events=await t.flows.main.attachEventLog(client,fork.data.id);
    await t.flows.main.sendPrompt(client,fork.data.id,"Continue by writing the requested file");
    await t.tools.waitUntil(()=>events.some(e=>e.type==="turnCompleted"),45_000);
    t.assertions.fileEquals(opened.workspaceRoot,"history-origin.txt","preserved");
    t.assertions.fileEquals(opened.workspaceRoot,"history-fork.txt","ordinary");
  } finally {client?.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});

migration("space-config", "Old Space records migrate once without losing new components; invalid parents preserve the original config", async t => {
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let client:Awaited<ReturnType<typeof connectProductClient>>|undefined;
  try {
    const configured=await opened.client.call({type:"agentSpace.configure",payload:{workspaceId:opened.workspaceId,expectedRevision:0,operation:{kind:"setComponent",componentId:"worker",enabled:true,role:"coder"}}});
    t.assertions.assert(configured?.type==="workspace","normal component setup failed");
    const secondRoot=path.join(t.env.workspace,"legacy-child");
    mkdirSync(secondRoot,{recursive:true});
    const second=await opened.client.call({type:"workspace.open",payload:{root:secondRoot}});
    if(second?.type!=="workspace")throw new Error("second workspace not opened");
    opened.client.close();opened.daemon.stop();
    const file=path.join(t.env.data,"config.json");
    const config=JSON.parse(readFileSync(file,"utf8"));
    config.pipeSpaces=[{workspaceId:opened.workspaceId,workerRole:"tester",lifecycle:"pooled"},{workspaceId:second.data.id,parentWorkspaceId:"missing-parent",workerRole:"tester",lifecycle:"pooled"}];
    config.speech={...(config.speech??{}),apiKey:"legacy-fixture-secret",region:"legacy-region",dashscopeWorkspaceId:"legacy-workspace"};
    const invalid=JSON.stringify(config);writeFileSync(file,invalid);
    t.assertions.assert(runGenet(opened.daemon.genet,["daemon","start"],opened.daemon.env).code!==0,"invalid legacy parent was accepted");
    t.assertions.assert(readFileSync(file,"utf8")===invalid,"failed migration rewrote its invalid input");
    config.pipeSpaces[1].parentWorkspaceId=opened.workspaceId;
    writeFileSync(file,JSON.stringify(config));
    t.assertions.assert(runGenet(opened.daemon.genet,["daemon","start"],opened.daemon.env).code===0,"valid legacy migration failed");
    client=await connectProductClient({...daemonEndpoint(opened.daemon)});
    const listed=await client.call({type:"workspace.list"});
    if(listed?.type!=="workspaces")throw new Error("migrated workspace list missing");
    const root=listed.data.find(w=>w.id===opened.workspaceId),child=listed.data.find(w=>w.id===second.data.id);
    t.assertions.assert(root?.agentSpace?.components.some(c=>c.componentId==="worker"&&c.role==="coder"),"legacy entry overwrote an existing component");
    t.assertions.assert(child?.agentSpace?.parentWorkspaceId===opened.workspaceId&&child.agentSpace.components.some(c=>c.role==="tester"),"legacy tree or role was lost");
    t.assertions.assert(listed.data.every(w=>!("pipeSpace"in w)),"removed projection leaked into the current protocol");
    const saved=JSON.parse(readFileSync(file,"utf8"));
    t.assertions.assert(!("pipeSpaces"in saved)&&saved.agentSpaces.some((s:{workspaceId:string})=>s.workspaceId===second.data.id),"legacy data was not durably migrated");
  } finally {client?.close();opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});


migration("invitation-write-failure", "A failed credential write publishes no device and leaves the same invitation usable for a durable retry", async t => {
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  const file=path.join(t.env.data,"devices.json"), backup=path.join(t.env.data,"devices-before-write-failure.json");
  let displaced=false, blocked=false;
  try {
    const prior=await t.flows.main.pairDevice(opened.client,opened.daemon,"existing-before-failure");
    prior.client.close();
    const invite=await opened.client.call({type:"device.invite",payload:null});
    if(invite?.type!=="invite")throw new Error("invitation missing");
    renameSync(file,backup);displaced=true;mkdirSync(file);blocked=true;
    let failed=false;
    try{await t.flows.main.claimDeviceInvite(opened.daemon,invite.data.code,"failed-claim");}catch{failed=true;}
    t.assertions.assert(failed,"claim reported success without a credential file");
    const unchanged=await opened.client.call({type:"device.list"});
    t.assertions.assert(unchanged?.type==="devices"&&unchanged.data.devices.length===1&&unchanged.data.devices[0]?.id===prior.deviceId,"failed write published a phantom device or discarded existing identity");
    rmdirSync(file);blocked=false;renameSync(backup,file);displaced=false;
    const retry=await t.flows.main.claimDeviceInvite(opened.daemon,invite.data.code,"successful-retry");
    const persisted=JSON.parse(readFileSync(file,"utf8"));
    t.assertions.assert(persisted.devices.some((d:{id:string})=>d.id===retry.deviceId)&&persisted.devices.length===2,"retry returned before durable credential publication");
    const peer=await t.flows.main.connectDevice(opened.daemon,retry,"successful-retry");
    try{t.assertions.assert((await peer.call({type:"settings.get"}))?.type==="settings","durable retry is not a full credential");}finally{peer.close();}
  } finally {
    if(blocked)rmdirSync(file);
    if(displaced)renameSync(backup,file);
    opened.client.close();opened.daemon.stop();await opened.mock.stop();
  }
});

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync, startRelay, type CaseContext } from "../../framework/public.ts";

type Opened=Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Reply={type:string;data:any;error?:{code:string;retryable:boolean;details?:{stage?:string}}};
const records=(s:string):Reply[]=>s.split("\n").filter(line=>line.trim().startsWith("{")).map(line=>JSON.parse(line));
async function fixture(t:CaseContext,run:(f:{opened:Opened;caller:Opened;machine:string;device:string;cli:(args:string[],stdin?:string)=>ReturnType<typeof runGenetAsync>;json:(args:string[])=>Promise<Reply>;settled:(session:string)=>Promise<number>})=>Promise<void>){
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  const relay=await startRelay({openRoot:t.openRoot});
  const callerRoot=path.join(t.env.root,"caller");
  const lease={...t.env,root:callerRoot,home:path.join(callerRoot,"home"),data:path.join(callerRoot,"data"),workspace:path.join(callerRoot,"workspace"),config:path.join(callerRoot,"config"),logs:path.join(callerRoot,"logs"),env:{...t.env.env}};
  for(const dir of [lease.root,lease.home,lease.data,lease.workspace,lease.config,lease.logs])mkdirSync(dir,{recursive:true});
  Object.assign(lease.env,{HOME:lease.home,USERPROFILE:lease.home,GENEHUB_DATA_DIR:lease.data,GENEHUB_LOCAL_DATA_DIR:lease.data,GENEHUB_WORKSPACE_DIR:lease.workspace,GENEHUB_LOCAL_WORKSPACE_DIR:lease.workspace,GENEHUB_LOG:path.join(lease.logs,"daemon.log")});
  let caller:Opened|undefined;
  try{
    caller=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease});
    await t.flows.main.configureMockProvider(opened.client,opened.mock);
    const cli=(args:string[],stdin?:string)=>runGenetAsync(caller!.daemon.genet,args,caller!.daemon.env,{stdin});
    const json=async(args:string[])=>{const result=await cli(args);return parseJson(result.stdout) as unknown as Reply;};
    await opened.client.call({type:"device.remoteAttach",payload:{relayUrl:relay.origin,joinToken:relay.joinToken,channelCount:1}});
    let endpoint="";
    await t.tools.waitUntil(async()=>{const r=await opened.client.call({type:"device.list"});if(r?.type!=="devices")return false;endpoint=r.data.remote.rendezvousUrl??"";return r.data.remote.online&&endpoint!=="";},15000);
    const invite=await opened.client.call({type:"device.invite",payload:null});if(invite?.type!=="invite")throw new Error("no invite");
    const paired=await cli(["machine","pair",invite.data.code,"--endpoint",endpoint,"--name","TS CLI parity"]);
    const pairedReply=parseJson(paired.stdout) as unknown as Reply;
    t.assertions.assert(paired.code===0,"CLI pairing failed");
    const machine=pairedReply.data.machine.machineId as string;
    const listed=await opened.client.call({type:"device.list"});if(listed?.type!=="devices")throw new Error("no paired devices");
    const device=listed.data.devices.find(d=>d.name==="TS CLI parity")?.id;if(!device)throw new Error("CLI device missing");
    const settled=async(session:string)=>{let seq=0;await t.tools.waitUntil(async()=>{const r=await opened.client.call({type:"session.get",payload:{sessionId:session}});if(r?.type!=="snapshot")return false;seq=r.data.seq;return r.data.summary.status==="idle";},30000);return seq;};
    await run({opened,caller,machine,device,cli,json,settled});
  }finally{caller?.client.close();caller?.daemon.stop();await caller?.mock.stop();opened.client.close();opened.daemon.stop();await opened.mock.stop();relay.stop();}
}
function check(id:string,oracle:string,run:Parameters<typeof fixture>[1],mock=false){
  defineSpecialty({id:`specialty.cli.remote-contract.${id}`,title:oracle,oracle,catches:["local and paired CLI disagree","remote failure loses recovery semantics","pairing or stream source silently changes"],tags:["core","cli","remote-cli-parity"],llm:{default:mock?"mock":"none"},expectedDurationMs:30000,timeoutMs:150000,resources:{environments:1,cpu:2,memoryMb:1536,io:1,browser:0},surfaces:["genet-cli","daemon","relay"],productInterfaces:["genet-cli","@genehub/workbench/client"]},t=>fixture(t,run));
}
check("identity-and-offline","A paired relay target answers as itself; offline is retryable",async({opened,machine,cli,json})=>{
  const context=await json(["context","--machine",machine]);
  if(context.type!=="context")throw new Error("remote context failed");
  if(context.data.source!=="remoteDaemon"||context.data.target.machineId!==machine||context.data.target.credential!=="pairedDeviceSecret")throw new Error("target identity or credential attribution changed");
  if((await json(["session","list","--machine",machine])).type!=="session.list")throw new Error("remote sessions failed");
  await opened.client.call({type:"device.remoteDetach"});
  let result:Reply|undefined;await new Promise(resolve=>setTimeout(resolve,300));
  for(let i=0;i<30;i++){const r=await cli(["session","list","--machine",machine]);result=parseJson(r.stdout) as unknown as Reply;if(result.error?.code==="machineOffline"){if(r.code!==3||!result.error.retryable)throw new Error("offline exit/retry semantics changed");return;}await new Promise(resolve=>setTimeout(resolve,200));}
  throw new Error(`offline target returned ${result?.error?.code}`);
});
check("exact-bytes","Local and paired CLI return identical workspace/session/Agent bytes",async({opened,machine,cli})=>{
  let prior="";for(let i=0;i<50;i++){const r=await runGenetAsync(opened.daemon.genet,["agent","list"],opened.daemon.env);if(r.stdout===prior)break;prior=r.stdout;await new Promise(resolve=>setTimeout(resolve,200));}
  for(const args of [["workspace","list"],["session","list"],["agent","list"]]){
    const local=await runGenetAsync(opened.daemon.genet,args,opened.daemon.env);const remote=await cli([...args,"--machine",machine]);
    if(local.code!==remote.code||local.stdout!==remote.stdout)throw new Error(`different local/remote bytes for ${args.join(" ")}`);
  }
});
check("shell-io","Remote shell preserves file bytes, stdin, stderr, child exit and timeout",async({opened,machine,cli})=>{
  writeFileSync(path.join(opened.workspaceRoot,"remote.txt"),"on remote");
  const shell=(args:string[],stdin?:string)=>cli(["--machine",machine,"--cwd",opened.workspaceRoot,"shell",...args],stdin);
  const cat=await shell(["--","cat","remote.txt"]);
  if(cat.code!==0||records(cat.stdout).filter(r=>r.type==="shell.output"&&r.data.stream==="stdout").map(r=>r.data.data).join("")!=="on remote")throw new Error("remote file output differs");
  const piped=await shell(["--","cat"],"piped from caller");
  if(piped.code!==0||records(piped.stdout).filter(r=>r.type==="shell.output"&&r.data.stream==="stdout").map(r=>r.data.data).join("")!=="piped from caller")throw new Error("stdin lost");
  const failed=await shell(["--","sh","-c","echo failed 1>&2; exit 7"]);const failedRows=records(failed.stdout);
  if(failed.code!==0||failedRows.at(-1)?.data.exitCode!==7||!failedRows.some(r=>r.type==="shell.output"&&r.data.stream==="stderr"&&r.data.data.includes("failed")))throw new Error("child failure became transport failure");
  const timeout=await shell(["--timeout","1","--","sleep","60"]);
  if(timeout.code!==0||records(timeout.stdout).at(-1)?.type!=="shell.exit"||records(timeout.stdout).at(-1)?.data.timedOut!==true||records(timeout.stdout).at(-1)?.data.exitCode===0)throw new Error("remote timeout not reported");
});
check("revoked","Revoked remote CLI asks to pair again without retrying",async({opened,machine,device,cli})=>{
  await opened.client.call({type:"device.revoke",payload:{deviceId:device}});
  const result=await cli(["session","list","--machine",machine]);const reply=parseJson(result.stdout) as unknown as Reply;
  if(result.code!==4||reply.error?.code!=="credentialRevoked"||reply.error.retryable)throw new Error(`revoked device result: exit=${result.code} error=${JSON.stringify(reply.error)}`);
});
check("stale-identity","A changed paired identity is refused; forget removes local credential",async({caller,machine,cli})=>{
  const file=path.join(caller.daemon.env.GENEHUB_LOCAL_DATA_DIR!,"machines.json");const store=JSON.parse(readFileSync(file,"utf8"));store.machines[0].fingerprint="AA-BB-CC-DD";writeFileSync(file,JSON.stringify(store));
  const result=await cli(["session","list","--machine",machine]);const reply=parseJson(result.stdout) as unknown as Reply;
  if(result.code!==3||reply.error?.code!=="protocolIncompatible"||reply.error.retryable)throw new Error(`stale identity not refused: ${reply.error?.code}`);
  const forgotten=parseJson((await cli(["machine","forget",machine])).stdout) as unknown as Reply;if(forgotten.data.forgotten!==true)throw new Error("forget failed");
  const gone=await cli(["session","list","--machine",machine]);const goneError=(parseJson(gone.stdout) as unknown as Reply).error;
  if(gone.code!==4||goneError?.code!=="internal"||goneError.details?.stage!=="hubTicket")throw new Error("forgotten credential reused instead of attempting account discovery");
});
check("background-replay","Remote Agent works after CLI exits and replays only missed events",async({opened,machine,cli,settled})=>{
  opened.mock.script({text:"first watched answer"},{text:"second unwatched answer",delayMs:200},{text:"third resumed answer"},{text:"fourth reset answer"});
  const first=await cli(["agent","run","--agent","genet","--model","deepseek/deepseek-v4-flash","--workspace",opened.workspaceId,"--machine",machine,"First answer"]);
  const firstRows=records(first.stdout);const session=firstRows.find(r=>typeof r.data?.sessionId==="string")?.data.sessionId as string;
  if(first.code!==0||!session||!first.stdout.includes("first watched answer")||firstRows.at(-1)?.data.status!=="completed")throw new Error("remote prompt did not run on target");
  const seen=await settled(session);
  const background=await cli(["session","send",session,"Second answer","--machine",machine,"--no-wait"]);const backgroundResult=records(background.stdout).at(-1);
  if(background.code!==0||backgroundResult?.type!=="session.result"||backgroundResult.data.status!=="running"||backgroundResult.data.waited!==false)throw new Error("background send did not leave a running turn");
  if(await settled(session)<=seen)throw new Error("background turn made no events");
  const resumed=await cli(["session","send",session,"Third answer","--machine",machine,"--since-seq",String(seen)]);const rows=records(resumed.stdout);
  if(resumed.code!==0||!resumed.stdout.includes("second unwatched answer")||!resumed.stdout.includes("third resumed answer")||rows.some(r=>r.type==="session.desync")||rows.filter(r=>r.type==="session.event").some(r=>r.data.seq<=seen)||rows.at(-1)?.data.status!=="completed")throw new Error("replay lost missed events or repeated known events");
  const zero=await cli(["session","send",session,"Fourth answer","--machine",machine,"--since-seq","0"]);const zeroRows=records(zero.stdout);
  if(zero.code!==0||zeroRows[0]?.type!=="session.attached"||zeroRows[1]?.type!=="session.desync"||zero.stdout.includes("second unwatched answer")||!zero.stdout.includes("fourth reset answer")||opened.mock.requests.length!==4)throw new Error("reset replay or model request count differs");
},true);

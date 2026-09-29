import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, runGenetAsync, startRelay, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Envelope = {
  type: string;
  data?: { machine?: { machineId: string }; source?: string; target?: { machineId?: string; credential?: string };
    daemon?: { machineId: string }; sessionId?: string; streamEpoch?: string; status?: string; waited?: boolean; forgotten?: boolean;
    session?: { summary: { status: string }; seq: number }; stream?: string; data?: string; seq?: number;
    exitCode?: number; timedOut?: boolean };
  error?: { code: string; retryable: boolean; message: string };
};
type Answer = { code: number; stdout: string; stderr: string; records: Envelope[]; last: Envelope };
type Remote = { o: Opened; machineId: string; call(args: string[], stdin?: string): Promise<Answer>; pair(grants?: string[], name?: string): Promise<string> };

async function withRemote(t: CaseContext, run: (r: Remote) => Promise<void>) {
  const o = await t.flows.main.openWorkspace({openRoot:t.openRoot, lease:t.env});
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  const cliData = join(t.env.root, "remote-cli"); mkdirSync(cliData, {recursive:true});
  const env = {...o.daemon.env, GENEHUB_DATA_DIR:cliData, GENEHUB_LOCAL_DATA_DIR:cliData};
  const call = async (args: string[], stdin?: string): Promise<Answer> => {
    const result = await runGenetAsync(o.daemon.genet, args, env, {stdin});
    const records = result.stdout.split("\n").filter(line => line.trim().startsWith("{")).map(line => JSON.parse(line) as Envelope);
    if (!records.length) throw new Error(`CLI emitted no envelope (exit=${result.code}): ${result.stderr.slice(-1000)}`);
    return {...result, records, last:records.at(-1)!};
  };
  try {
    relay = await startRelay({openRoot:t.openRoot});
    const attached = await o.client.call({type:"device.remoteAttach", payload:{relayUrl:relay.origin, joinToken:relay.joinToken}});
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("remoteAttach failed");
    const endpoint = attached.data.rendezvousUrl;
    await t.tools.waitUntil(async () => {const d=await o.client.call({type:"device.list"}); return d?.type==="devices" && d.data.remote.online;}, 20000);
    const started = await runGenetAsync(o.daemon.genet, ["daemon","start"], env);
    t.assertions.assert(started.code===0, "remote CLI coordinator did not start");
    const pair = async (grants?:string[], name="remote-cli") => {
      const invite=await o.client.call({type:"device.invite", payload:grants ? {grants} : null});
      if (invite?.type!=="invite") throw new Error("invitation failed");
      const p=await call(["machine","pair",invite.data.code,"--endpoint",endpoint,"--name",name]);
      t.assertions.assert(p.code===0 && Boolean(p.last.data?.machine?.machineId), "CLI pairing failed");
      return p.last.data!.machine!.machineId;
    };
    const machineId=await pair();
    await run({o,machineId,call,pair});
  } finally {
    await runGenetAsync(o.daemon.genet,["daemon","stop"],env);
    relay?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop();
  }
}

function define(id:string, title:string, oracle:string, run:(t:CaseContext,r:Remote)=>Promise<void>, llm:"mock"|"none"="none") {
  defineSpecialty({id:`specialty.connectivity.remote-cli-${id}`,title,oracle,
    catches:["remote CLI differs from loopback", "legacy retirement drops the only relay CLI fact"],
    tags:["core","contract","connectivity","refactor-remote-cli"],llm:{default:llm},
    resources:{environments:1,cpu:2,memoryMb:1024,io:1,browser:0,pool:"standard"},
    expectedDurationMs:25000,timeoutMs:120000,
    requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
    surfaces:["genet-cli","daemon","relay","agent"],productInterfaces:["genet-cli","@genehub/workbench/client"],
  },t=>withRemote(t,r=>run(t,r)));
}

define("admission","Remote CLI respects pairing, narrow grants and offline verdicts", "The real CLI names its remote credential, rejects device management with read-only grants, and returns machineOffline/retryable/exit 3 after detach", async(t,r)=>{
  const context=await r.call(["context","--machine",r.machineId]);
  t.assertions.assert(context.code===0 && context.last.data?.source==="remoteDaemon" && context.last.data.target?.machineId===r.machineId && context.last.data.target.credential==="pairedDeviceSecret", "remote context misidentified the target or credential");
  await r.pair(["read"],"narrow-cli");
  t.assertions.assert((await r.call(["session","list","--machine",r.machineId])).code===0,"read grant rejected");
  const denied=await r.call(["device","invite","--machine",r.machineId]);
  t.assertions.assert(denied.code!==0 && denied.last.type==="error" && denied.last.error?.retryable===false && denied.last.error.message.includes("devices"),"narrow credential managed devices or hid the missing grant");
  await r.o.client.call({type:"device.remoteDetach"});
  const offline=await t.tools.waitUntil(async()=>{const a=await r.call(["session","list","--machine",r.machineId]);return a.last.error?.code==="machineOffline" ? a : undefined;},20000,200);
  t.assertions.assert(offline.code===3 && offline.last.error?.retryable===true,"offline machine was treated as a permanent refusal");
});

define("prompt","A prompt typed here is answered by the agent there","The real remote CLI opens the target directory and emits a completed result from the sole mocked model endpoint",async(t,r)=>{
  await t.flows.main.configureMockProvider(r.o.client,r.o.mock); r.o.mock.script({text:"REMOTE_ANSWER"});
  const a=await r.call(["--machine",r.machineId,"--cwd",r.o.workspaceRoot,"genet","answer remotely","--model","deepseek/deepseek-v4-flash","--open-workspace","--timeout","60"]);
  t.assertions.assert(a.code===0 && a.last.type==="session.result" && a.last.data?.status==="completed" && a.stdout.includes("REMOTE_ANSWER") && r.o.mock.requests.length===1,"remote prompt was not answered by the far agent");
},"mock");

define("shell","Remote CLI transports stdin, stdout, stderr, timeout and command exit","Real shell bytes stay separated from CLI failure and timeout is explicitly reported",async(t,r)=>{
  const args=["--machine",r.machineId,"--cwd",r.o.workspaceRoot,"shell"];
  const out=await r.call([...args,"--","python3","-c","import sys; print(sys.stdin.read(),end='')"],"piped-from-here");
  const text=out.records.filter(e=>e.type==="shell.output" && e.data?.stream==="stdout").map(e=>e.data?.data??"").join("");
  t.assertions.assert(out.code===0 && text==="piped-from-here" && out.last.type==="shell.exit" && out.last.data?.exitCode===0,"stdin/stdout was lost or confused with CLI failure");
  const failed=await r.call([...args,"--","python3","-c","import sys; print('went wrong',file=sys.stderr); sys.exit(7)"]);
  t.assertions.assert(failed.code===0 && failed.last.data?.exitCode===7 && failed.records.some(e=>e.data?.stream==="stderr" && e.data.data?.includes("went wrong")),"remote command status or stderr was rewritten");
  const timed=await r.call([...args,"--timeout","1","--","python3","-c","import time; time.sleep(60)"]);
  t.assertions.assert(timed.code===0 && timed.last.type==="shell.exit" && timed.last.data?.timedOut===true,"remote command timeout was hidden");
});

define("revoked","A revoked remote CLI credential requires pairing again","The actual CLI returns credentialRevoked, retryable=false and exit 4",async(t,r)=>{
  const d=await r.o.client.call({type:"device.list"});if(d?.type!=="devices")throw new Error("device list failed");
  const device=d.data.devices.find(d=>d.name==="remote-cli");if(!device)throw new Error("paired device absent");
  await r.o.client.call({type:"device.revoke",payload:{deviceId:device.id}});
  const a=await r.call(["session","list","--machine",r.machineId]);
  t.assertions.assert(a.code===4 && a.last.error?.code==="credentialRevoked" && a.last.error.retryable===false,"revocation became an offline retry");
});

define("equivalence","The same CLI returns identical local and remote list bytes","workspace, session and agent list envelopes match byte for byte; context honestly reports its route",async(t,r)=>{
  for(const args of [["workspace","list"],["session","list"],["agent","list"]]){
    const local=await runGenetAsync(r.o.daemon.genet,args,r.o.daemon.env); const remote=await r.call([...args,"--machine",r.machineId]);
    t.assertions.assert(local.code===remote.code && local.stdout===remote.stdout,`${args.join(" ")} differs through relay`);
  }
  const local=await runGenetAsync(r.o.daemon.genet,["context"],r.o.daemon.env);
  const here=JSON.parse(local.stdout.trim().split("\n").at(-1)!) as Envelope; const there=(await r.call(["context","--machine",r.machineId])).last;
  t.assertions.assert(here.data?.source==="localDaemon" && there.data?.source==="remoteDaemon" && here.data?.daemon?.machineId===there.data?.daemon?.machineId,"context misreported the answering machine");
});

define("background","A remote conversation survives its CLI and replays only missed seqs","No-wait acknowledges running; the next CLI process replays the unwatched turn once, while since-seq zero explicitly desyncs",async(t,r)=>{
  await t.flows.main.configureMockProvider(r.o.client,r.o.mock);r.o.mock.script({text:"FIRST_REPLY"},{text:"UNWATCHED_REPLY"},{text:"THIRD_REPLY"},{text:"FOURTH_REPLY"});
  const first=await r.call(["--machine",r.machineId,"--cwd",r.o.workspaceRoot,"genet","first","--model","deepseek/deepseek-v4-flash","--open-workspace"]);
  t.assertions.assert(first.code===0,"first remote turn failed");const sessionId=first.records.find(e=>e.data?.sessionId)?.data?.sessionId;if(!sessionId)throw new Error("no session id");
  const settled=async()=>t.tools.waitUntil(async()=>{const a=await r.call(["session","get",sessionId,"--machine",r.machineId]);return a.code===0 && a.last.data?.session?.summary.status==="idle" ? a.last.data?.session?.seq : undefined;},30000,100);
  const epoch=first.records.find(e=>e.data?.streamEpoch)?.data?.streamEpoch;
  t.assertions.assert(Boolean(epoch),"remote subscription did not expose its stream epoch");
  const seen=await settled();const second=await r.call(["session","send",sessionId,"second","--machine",r.machineId,"--no-wait"]);
  t.assertions.assert(second.code===0 && second.last.data?.status==="running" && second.last.data.waited===false,"no-wait did not leave a running obligation");
  t.assertions.assert(await settled()>seen,"unwatched turn emitted no events");
  const third=await r.call(["session","send",sessionId,"third","--machine",r.machineId,"--since-seq",String(seen),"--since-epoch",epoch!]);
  t.assertions.assert(third.code===0 && third.stdout.includes("UNWATCHED_REPLY") && third.last.data?.status==="completed" && !third.records.some(e=>e.type==="session.desync") && third.records.filter(e=>e.type==="session.event").every(e=>(e.data?.seq??0)>seen),"missed events were lost, reset or duplicated");
  const zero=await r.call(["session","send",sessionId,"fourth","--machine",r.machineId,"--since-seq","0"]);
  t.assertions.assert(zero.code===0 && zero.records[0]?.type==="session.attached" && zero.records[1]?.type==="session.desync" && !zero.stdout.includes("UNWATCHED_REPLY") && r.o.mock.requests.length===4,"since-seq zero hid reset or replayed old work");
},"mock");

define("identity","A different remote identity is refused and forgetting revokes local use","Fingerprint mismatch returns protocolIncompatible/exit 3; public machine forget immediately returns machineNotPaired/exit 4",async(t,r)=>{
  const store=join(t.env.root,"remote-cli","machines.json");
  const saved=JSON.parse(readFileSync(store,"utf8")) as {machines:Array<{fingerprint:string}>}; saved.machines[0]!.fingerprint="AA-BB-CC-DD";writeFileSync(store,JSON.stringify(saved));
  const a=await r.call(["session","list","--machine",r.machineId]);
  t.assertions.assert(a.code===3 && a.last.error?.code==="protocolIncompatible" && a.last.error.retryable===false,"changed remote identity was accepted");
  const forgotten=await r.call(["machine","forget",r.machineId]);t.assertions.assert(forgotten.code===0 && forgotten.last.data?.forgotten===true,"public forget failed");
  const gone=await r.call(["session","list","--machine",r.machineId]);t.assertions.assert(gone.code===4 && gone.last.error?.code==="machineNotPaired","forgotten credential still worked");
});

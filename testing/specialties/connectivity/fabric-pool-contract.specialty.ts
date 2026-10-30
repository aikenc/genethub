import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";
import { collectShellResult, defineSpecialty, startRelay, startSharedBottleneck, startTcpPayloadServer, measureTcpTransfer } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.fabric-pool.public-contract", title: "Independent same-daemon Fabric node channels retain device authority and legacy default",
  oracle: "One-channel default remains usable; explicit 2/4 lanes have separate TCP and logical owners for the same machine; invalid sizes cannot change configuration and device revocation closes every lane",
  catches: ["extra sockets replace one endpoint", "pool multiplies device permissions", "channel configuration silently ignored"],
  tags: ["fabric-pool", "authorization", "connectivity"], llm: { default: "none" }, expectedDurationMs: 30000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "relay", "workbench-client"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const link = await startSharedBottleneck(relay.origin, { bandwidthMbps: 1000, rttMs: 0 });
  const peers: Client[] = [];
  try {
    const attach = (channelCount?: number) => o.client.call({ type: "device.remoteAttach", payload: { relayUrl: link.urlFor(relay.origin), joinToken: relay.joinToken, ...(channelCount === undefined ? {} : { channelCount }) } });
    const old = await attach();
    t.assertions.assert(old?.type === "remoteAccess" && !!old.data.rendezvousUrl, "legacy attachment stopped returning its primary route");
    if (old?.type !== "remoteAccess") throw new Error("remote attach failed");
    const primary = new URL(old.data.rendezvousUrl!).searchParams.get("route");
    await attach(2);
    await t.tools.waitUntil(async () => { const r = await o.client.call({ type: "device.list" }); return r?.type === "devices" && r.data.remote.channels?.length === 2 && r.data.remote.channels.every(c => c.online); }, 15000);
    await attach(4);
    let lanes: Array<{ id: number; url: string; online: boolean }> = [];
    await t.tools.waitUntil(async () => { const r = await o.client.call({ type: "device.list" }); if (r?.type === "devices") lanes = r.data.remote.channels ?? []; return lanes.length === 4 && lanes.every(c => c.online); }, 15000);
    t.assertions.assert(new Set(lanes.map(c => c.url)).size === 4 && new URL(lanes[0]!.url).searchParams.get("route") === primary, "pool replaced the legacy slot or duplicated a node route");
    for (const channelCount of [0, 5]) await t.assertions.expectProtocolCode(() => attach(channelCount), "badRequest");
    const paired = await t.flows.main.pairDevice(o.client, o.daemon, "pool-authority"); paired.client.close();
    const accepted = link.stats().accepted;
    for (const lane of lanes) {
      const url = new URL(lane.url); url.host = new URL(relay.origin).host;
      const peer = new Client({ separateDataChannel: false, url: url.toString(), credential: paired.credential, rtcEnabled: false,
        socketFactory: u => new WebSocket(u) as unknown as WebSocketLike });
      peers.push(peer); peer.connect(); await t.tools.waitUntil(() => peer.connectionState === "ready", 10000);
      const reply = await peer.call({ type: "workspace.list" });
      t.assertions.assert(reply?.type === "workspaces" && reply.data.some(w => w.id === o.workspaceId), "pool lane did not reach the original daemon workspace");
    }
    t.assertions.assert(new Set(peers.map(p => p.logicalConnectionId)).size === 4 && new Set(peers.map(p => p.identity?.machineId)).size === 1, "channels did not retain distinct journals and same source identity");
    const readOnly = await t.flows.main.pairDevice(o.client, o.daemon, "pool-read-only");
    try { t.assertions.assert((await readOnly.client.call({type:"device.list"}))?.type === "devices", "paired pool peer lost identity"); }
    finally { readOnly.client.close(); }
    await o.client.call({ type: "device.revoke", payload: { deviceId: paired.deviceId } });
    await t.tools.waitUntil(() => peers.every(p => p.connectionState !== "ready"), 5000);
    const status = await o.client.call({ type: "device.list" });
    t.assertions.assert(status?.type === "devices" && status.data.remote.channels?.length === 4, "invalid requests or revocation mutated node configuration");
    t.note(JSON.stringify({ legacyPrimaryStable: true, channels: 4, independentOwners: 4, machineIdentities: 1, nodeTcpBeforeClients: accepted, nodeTcpAfterClients: link.stats().accepted, invalidSizesRejected: true, pairedDeviceFull: true, revokedAllLanes: true }));
  } finally { peers.forEach(p => p.close()); await link.stop(); relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

defineSpecialty({
  id: "specialty.fabric-pool.calibration", title: "Revised shared bottleneck conserves capacity for one, two and four physical flows",
  oracle: "Identical exact payload totals and hashes cross 1/2/4 TCP flows near the same 5Mbps aggregate rate",
  catches: ["timer-per-record overhead changes the experiment", "adding channels multiplies offered bandwidth"],
  tags: ["fabric-pool", "calibration"], llm: { default: "none" }, expectedDurationMs: 25000, timeoutMs: 40000,
  resources: { environments: 1, cpu: 2, memoryMb: 512, io: 1, browser: 0, pool: "exclusive" }, surfaces: ["tcp"], retention: true,
}, async t => {
  const samples: unknown[] = [];
  for (const flows of [1, 2, 4]) {
    const source = await startTcpPayloadServer(4*1024*1024/flows);
    const link = await startSharedBottleneck(source.url, { bandwidthMbps: 5, rttMs: 200 });
    try {
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: flows }, () => measureTcpTransfer({ url: link.urlFor(source.url), expectedBytes: source.sizeBytes, expectedSha256: source.sha256 })));
      const elapsedMs = performance.now()-start, bytes = results.reduce((n,s) => n+s.bytes,0), mbps = bytes*8/elapsedMs/1000;
      samples.push({ flows, bytes, hashes: results.length, elapsedMs: Math.round(elapsedMs), mbps: +mbps.toFixed(3) });
      t.note(JSON.stringify(samples.at(-1)));
      t.assertions.assert(mbps > 4 && mbps < 5.25, "raw capacity is not comparable across channel counts");
    } finally { await link.stop(); await source.stop(); }
  }
  t.note(JSON.stringify(samples));
});


defineSpecialty({
  id:"specialty.fabric-pool.resize-preserves-primary", title:"Changing the node pool size preserves retained physical lanes and control owners",
  oracle:"2 to 4 to 2 lanes keeps the two original TCP sockets and original logical control owner, with successful control queries after each change",
  catches:["pool resize restarts all node sockets", "shrinking one tail closes the primary lane"], tags:["fabric-pool","fabric-automatic"],llm:{default:"none"},
  surfaces:["daemon","relay","workbench-client","tcp"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
  resources:{environments:1,cpu:2,memoryMb:1024,io:1,browser:0},expectedDurationMs:15000,timeoutMs:60000,
},async t=>{
  const p=await openFabricPool(t,2,1);const original=p.link.connections().filter(c=>!c.closed).map(c=>c.id),owner=p.clients[0]!.logicalConnectionId;
  try{
    for(const size of [4,2]){
      await p.opened.client.call({type:"device.remoteAttach",payload:{relayUrl:p.link.urlFor(p.relay.origin),joinToken:p.relay.joinToken,channelCount:size}});
      await t.tools.waitUntil(async()=>{const r=await p.opened.client.call({type:"device.list"});return r?.type==="devices"&&r.data.remote.channels?.length===size&&r.data.remote.channels.every(c=>c.online);},15000);
      t.assertions.assert(original.every(id=>p.link.connections().some(c=>c.id===id&&!c.closed)),"resize replaced an original node socket");
      t.assertions.assert((await p.clients[0]!.call({type:"workspace.list"}))?.type==="workspaces"&&p.clients[0]!.logicalConnectionId===owner,"resize replaced the control owner");
    }
  }finally{await p.dispose();}
});


defineSpecialty({
  id:"specialty.fabric-pool.resize-to-one-recovers-body",title:"Removing the data node lane retains its in-flight logical body on the surviving primary",
  oracle:"A real in-flight 8 MiB shell output survives 2-to-1 node resize with the same logical owners, exact hash/exit and one source execution",
  catches:["companion redials a removed lane forever", "fallback replays the shell command", "shrinking a tail replaces the primary control owner"],
  tags:["fabric-pool","fabric-automatic"],llm:{default:"none"},resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:0,pool:"exclusive"},
  surfaces:["daemon","relay","workbench-client","shell","tcp"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
  expectedDurationMs:20000,timeoutMs:60000,
},async t=>{
  const p=await openFabricPool(t,2,1);let client:Client|undefined;let stream:ReturnType<Client["openShellStream"]>|undefined;
  try{
    const url=p.browserFaults[0]!.url;
    client=new Client({url,credential:p.credential,rtcEnabled:false,redial:async()=>({url}),socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike});
    client.connect();await t.tools.waitUntil(()=>client!.connectionState==="ready",10000);
    const body=await client.prepareDataChannel();t.assertions.assert(body!==client,"data lane was not automatically admitted");
    const owners=[client.logicalConnectionId,body.logicalConnectionId];
    stream=client.openShellStream({workspaceId:p.opened.workspaceId,cwd:p.opened.workspaceRoot,timeoutMs:45000,argv:["python3","-c","import pathlib,sys,time\npathlib.Path('resize-starts').open('a').write('once\\n')\nwhile not pathlib.Path('resize-go').exists():time.sleep(.01)\nfor i in range(512):sys.stdout.write('R'*16384);sys.stdout.flush();time.sleep(.001)"]});
    await stream.finish();await stream.responseHead;
    const result=collectShellResult(stream);void result.catch(()=>{});
    p.link.setProfile({bandwidthMbps:2,rttMs:200});writeFileSync(join(p.opened.workspaceRoot,"resize-go"),"go");await new Promise(r=>setTimeout(r,500));
    await p.opened.client.call({type:"device.remoteAttach",payload:{relayUrl:p.link.urlFor(p.relay.origin),joinToken:p.relay.joinToken,channelCount:1}});
    p.link.setProfile({bandwidthMbps:1000,rttMs:0});
    await t.tools.waitUntil(()=>body.connectionState!=="ready",3000);
    await t.tools.waitUntil(()=>body.connectionState==="ready",15000);
    const r=await result,text=t.flows.main.shellText(r.frames,"stdout");
    t.assertions.assert(createHash("sha256").update(text).digest("hex")===createHash("sha256").update(Buffer.alloc(8*1024*1024,82)).digest("hex")&&t.flows.main.shellExit(r.frames)?.code===0,"fallback did not recover exact body and exit");
    t.assertions.assert(readFileSync(join(p.opened.workspaceRoot,"resize-starts"),"utf8")==="once\n"&&client.logicalConnectionId===owners[0]&&body.logicalConnectionId===owners[1],"resize repeated source execution or replaced an owner");
    t.note(JSON.stringify({bytes:Buffer.byteLength(text),sourceExecutions:1,retainedOwners:true,nodeChannels:1}));
  }finally{stream?.reset(1);client?.close();await p.dispose();}
});

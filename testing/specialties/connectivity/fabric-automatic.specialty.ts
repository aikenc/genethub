import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client, type WebSocketLike, type ProtocolDial } from "@genehub/workbench/client";
import { allocatePort, defineSpecialty, startHub, startRelay, startSharedBottleneck } from "../../framework/public.ts";

for (const hosted of [false, true]) defineSpecialty({
  id: `specialty.fabric-pool.automatic-${hosted ? "hosted" : "paired"}`,
  title: `The normal ${hosted ? "Hosted" : "paired"} Client automatically separates control and body on both hops`,
  oracle: "Two authenticated owners on the same machine, two node uplinks and two browser sockets, exact 8 MiB preview while control stays below 1500ms, fresh authenticated owners serve new requests after all physical sockets are cut",
  catches: ["only browser connections were split", "normal product client still shares the bulk path", "Hosted node endpoint replaces its other lane", "new requests remain bound to a closed owner"],
  tags: ["fabric-pool", "fabric-automatic", "connectivity"], llm: { default: "none" }, requiredRepos: ["cloud"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "relay", "workbench-client", "cloud-server", "tcp"], productInterfaces: ["@genehub/workbench/client", "hub-http"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  stages: ["workspace-ready", "control-ready", "body-admission", "control-under-preview", "preview-complete", "physical-recovery", "revocation", "daemon-stop", "mock-stop", "hub-stop", "link-stop"],
  expectedDurationMs: 45000, timeoutMs: 120000, retention: true,
}, async t => {
  const port = await allocatePort(), token = randomBytes(32).toString("hex");
  const origin = `http://127.0.0.1:${port}`;
  const link = await startSharedBottleneck(origin, { bandwidthMbps: 1000, rttMs: 0 });
  const hub = await startHub({ databasePath: join(t.env.root, "automatic.sqlite"), relayOrigin: hosted ? link.urlFor(origin) : origin, relayToken: token });
  const relay = await startRelay({ openRoot: t.openRoot, port, ...(hosted ? { control: { origin: hub.origin, token } } : {}) });
  t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
  t.env.env.GENEHUB_LOCAL_LOG = "warn";
  const o = await t.stage("workspace-ready", () => t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }));
  let client: Client | undefined;
  const events: unknown[] = [];
  try {
    const bytes = randomBytes(8 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    writeFileSync(join(t.env.workspace,"automatic.png"),bytes);
    const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    let credential: { deviceId: string; secret: string } | undefined;
    let dial: ProtocolDial;
    let redial: () => Promise<ProtocolDial>;
    let revoke: () => Promise<void>;
    if (hosted) {
      const owner = hub.browser(); await hub.signInOwner(owner);
      const pair = await o.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "automatic" } });
      if (pair?.type !== "hubStatus" || pair.data.state !== "pairing") throw new Error("Hosted pairing did not start");
      await hub.approvePairing(owner,pair.data.userCode);
      let machineId = "";
      await t.tools.waitUntil(async () => { const me = await owner.json<{machines: Array<{id:string;online:boolean}>}>("/app/me"); machineId = me.machines.find(m=>m.online)?.id ?? ""; return !!machineId; },30000);
      type Ticket = {url:string; fabricRouteTicket:string; fabricAuthorizationExpiresAt?:string;channelCapability:string;channelSecret:string;bulk?:Ticket};
      const fields = (ticket: Ticket): ProtocolDial => ({ url:ticket.url, fabricRouteTicket:ticket.fabricRouteTicket, fabricAuthorizationExpiresAt:ticket.fabricAuthorizationExpiresAt, channelCredential:{capabilityId:ticket.channelCapability,secret:ticket.channelSecret} });
      redial = async () => { const response = await owner.fetch(`/app/machines/${machineId}/connect`,{method:"POST"}); if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("machine route temporarily unavailable"),{status:response.status}); } const ticket = await response.json() as Ticket; return {...fields(ticket), bulk:ticket.bulk ? fields(ticket.bulk) : undefined}; };
      let ready: ProtocolDial | undefined;
      await t.tools.waitUntil(async()=> { ready = await redial(); return !!ready.bulk; },15000);
      dial = ready!;
      const stranger=hub.browser();await hub.signInOwner(stranger);
      const denied=await stranger.fetch(`/app/machines/${machineId}/connect`,{method:"POST"});await denied.body?.cancel();
      t.assertions.assert(denied.status===404 || denied.status===403,"a second account obtained machine routes");
      revoke=async()=>{const r=await owner.fetch(`/app/machines/${machineId}/revoke`,{method:"POST"});await r.body?.cancel();t.assertions.assert(r.ok,"machine revocation failed");};
    } else {
      const pair = await t.flows.main.pairDevice(o.client,o.daemon,"automatic"); pair.client.close(); credential = pair.credential;
      const attached = await o.client.call({type:"device.remoteAttach",payload:{relayUrl:link.urlFor(origin),joinToken:relay.joinToken,channelCount:2}});
      if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("paired attachment failed");
      await t.tools.waitUntil(async()=>{const d=await o.client.call({type:"device.list"});return d?.type==="devices" && d.data.remote.channels?.length===2 && d.data.remote.channels.every(l=>l.online);},15000);
      dial = {url:attached.data.rendezvousUrl}; redial = async()=>dial;
      revoke=async()=>{await o.client.call({type:"device.revoke",payload:{deviceId:credential!.deviceId}});};
    }
    client = new Client({...dial,credential,redial,rtcEnabled:false,onDiagnostic(e){if(e.kind === "connection"){events.push({state:e.detail.state,phase:e.detail.phase,lane:e.detail.lane});if(events.length>32)events.shift();}},socketFactory:u=>new WebSocket(u) as unknown as WebSocketLike});
    t.assertions.assert(await client.prepareDataChannel()===client,"an unauthenticated primary opened a companion");
    client.connect(); await t.stage("control-ready", () => t.tools.waitUntil(()=>client!.connectionState==="ready",15000));
    const body = await t.stage("body-admission", () => client!.prepareDataChannel());
    t.assertions.assert(body !== client && body.identity?.machineId === client.identity?.machineId,"automatic body route missing or reaches another machine");
    t.assertions.assert(await body.prepareDataChannel() === body,"body carrier recursively opens another owner");
    const owners = [client.logicalConnectionId,body.logicalConnectionId];
    t.assertions.assert(owners.every(Boolean) && owners[0]!==owners[1],"body owner was not independently admitted");
    const connections = link.connections().filter(c=>!c.closed);
    t.assertions.assert(connections.length === 4,"both physical hops were not established");
    link.setProfile({bandwidthMbps:5,rttMs:200});
    const preview = client.preview(o.workspaceId,`${o.rootHandle}/automatic.png`);
    const latency:number[]=[];
    await t.stage("control-under-preview", async () => {
      for(let i=0;i<12;i++){const began=performance.now();const r=await client!.call({type:"workspace.list"}); t.assertions.assert(r?.type==="workspaces","control failed under body traffic");latency.push(performance.now()-began);await new Promise(r=>setTimeout(r,100));}
    });
    const result=await t.stage("preview-complete", () => preview);
    t.assertions.assert(hash(result.bytes)===hash(bytes),"body bytes changed");
    latency.sort((a,b)=>a-b); const p95=latency[Math.ceil(latency.length*.95)-1]!;
    t.note(JSON.stringify({hosted,physicalConnections:connections.length,bytes:result.bytes.length,p95,ownersDistinct:true}));
    t.assertions.assert(p95<1500,"automatic production routing exceeded control p95 target");
    await t.stage("physical-recovery", async () => {
      link.setProfile({bandwidthMbps:1000,rttMs:0});
      for(const flow of link.connections().filter(c=>!c.closed)) link.cutConnection(flow.id);
      await t.tools.waitUntil(()=>client!.connectionState!=="ready" || body.connectionState!=="ready",3000);
      await t.tools.waitUntil(()=>client!.connectionState==="ready" && body.connectionState==="ready",20000);
      const after=await client!.call({type:"workspace.list"});
      const bodyAfter=await body.call({type:"workspace.list"});
      t.note(JSON.stringify({phase:"recovered",primaryReplaced:client!.logicalConnectionId!==owners[0],bodyReplaced:body.logicalConnectionId!==owners[1],bodyReady:bodyAfter?.type === "workspaces"}));
      t.assertions.assert(after?.type==="workspaces" && bodyAfter?.type==="workspaces" && client!.logicalConnectionId!==owners[0] && body.logicalConnectionId!==owners[1],"new authenticated owners did not serve both control and body after physical loss");
    });
    await t.stage("revocation", async () => {
      await revoke();
      await t.tools.waitUntil(()=>client!.connectionState!=="ready" && body.connectionState!=="ready",8000);
      t.assertions.assert((await o.client.call({type:"workspace.list"}))?.type==="workspaces","revoking remote owners affected local authority");
      t.note(JSON.stringify({phase:"revoked",bothOwnersRejected:true,localOwnerRetained:true}));
    });
  } catch(error) { t.note(JSON.stringify({events,error:String(error)})); throw error; } finally {client?.close();o.client.close();await t.stage("daemon-stop", async () => o.daemon.stop());await t.stage("mock-stop", () => o.mock.stop());relay.stop();await t.stage("hub-stop", () => hub.stop());await t.stage("link-stop", () => link.stop());}
});

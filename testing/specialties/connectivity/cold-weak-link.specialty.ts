import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { daemonEndpoint, defineSpecialty, startRelay, startShapedTcpProxy } from "../../framework/public.ts";

for (const relayed of [false, true]) for (const bandwidthMbps of [0.5, 5]) defineSpecialty({
  id: `specialty.neteff.cold-weak-${relayed ? "relay" : "direct"}-${bandwidthMbps === 0.5 ? "500k" : "5m"}`,
  title: `A new ${relayed ? "two-hop relay" : "direct"} connection at ${bandwidthMbps}Mbps and 200ms per hop keeps the owner and recovers control`,
  oracle: "The link is slow before authentication, a 2MiB preview is exact, the original logical owner and one physical carrier survive the body, and control recovers after it; RPCs during the body may consume their 6s budget",
  catches: ["compressed probe replies overestimate a cold weak link", "warm-link and capacity-drop tests miss unsafe initial queue growth", "opening extra physical lanes hides shared-path blocking"],
  tags: ["neteff", "connectivity", "cold-weak", "network-isolation-fix"],
  llm: { default: "none" }, requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp", ...(relayed ? ["relay"] : [])],
  productInterfaces: ["@genehub/workbench/client"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "exclusive" },
  expectedDurationMs: 55000, timeoutMs: 120000, retention: true,
}, async t => {
  t.env.env.GENEHUB_LOCAL_LOG = "warn";
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const links: Array<Awaited<ReturnType<typeof startShapedTcpProxy>>> = [];
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let client: Client | undefined;
  try {
    const bytes = randomBytes(2 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    writeFileSync(join(t.env.workspace, "cold-weak.png"), bytes);
    const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    const profile = { bandwidthMbps, rttMs: 200 };
    let dial: { url: string; credential?: { deviceId: string; secret: string }; localServerProof?: ReturnType<typeof daemonEndpoint>["localServerProof"] };
    if (relayed) {
      relay = await startRelay({ openRoot: t.openRoot });
      const nodeLink = await startShapedTcpProxy({ targetUrl: relay.origin, profile }); links.push(nodeLink);
      const paired = await t.flows.main.pairDevice(o.client, o.daemon, [], "cold-weak"); paired.client.close();
      const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: nodeLink.urlFor(relay.origin), joinToken: relay.joinToken, channelCount: 1 } });
      if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("cold relay attachment failed");
      await t.tools.waitUntil(async () => { const r = await o.client.call({ type: "device.list" }); return r?.type === "devices" && r.data.remote.online === true; }, 20000);
      const browserLink = await startShapedTcpProxy({ targetUrl: relay.origin, profile }); links.push(browserLink);
      dial = { url: browserLink.urlFor(attached.data.rendezvousUrl), credential: paired.credential };
    } else {
      const endpoint = daemonEndpoint(o.daemon);
      const link = await startShapedTcpProxy({ targetUrl: endpoint.url, profile }); links.push(link);
      dial = { url: link.urlFor(endpoint.url), localServerProof: endpoint.localServerProof };
    }
    client = new Client({ ...dial, rtcEnabled: false, separateDataChannel: false, requestTimeoutMs: 6000,
      socketFactory: u => new WebSocket(u) as unknown as WebSocketLike });
    const connectAt = performance.now(); client.connect();
    await t.tools.waitUntil(() => client!.connectionState === "ready", 45000);
    const connectMs = performance.now() - connectAt, owner = client.logicalConnectionId;
    const physical = links.map(link => link.stats().acceptedConnections);
    for (const link of links) { t.assertions.assert(link.stats().acceptedConnections === 1, "cold fixture opened another physical carrier"); link.resetStats(); }
    let finished = false;
    const preview = client.preview(o.workspaceId, `${o.rootHandle}/cold-weak.png`).then(r => { finished = true; return r; });
    void preview.catch(() => {});
    await t.tools.waitUntil(() => links.every(link => (relayed && link === links[0] ? link.stats().clientToTargetBytes : link.stats().targetToClientBytes) >= 64 * 1024), 15000);
    t.assertions.assert(!finished, "cold preview completed before control contention");
    const latency: number[] = []; let underBody = 0, rpcErrors = 0;
    for (let i = 0; i < 6; i++) {
      if (!finished) underBody++;
      const began = performance.now();
      try {
        const r = await client.call({ type: "workspace.list" });
        t.assertions.assert(r?.type === "workspaces", "cold-link RPC failed");
      } catch { rpcErrors++; }
      latency.push(performance.now() - began);
    }
    const result = await preview;
    const recovered = await client.call({ type: "workspace.list" })
      .then(reply => reply?.type === "workspaces").catch(() => false);
    t.note(JSON.stringify({ relayed, bandwidthMbps, connectMs: Math.round(connectMs), rpcMs: latency.map(Math.round), rpcErrors, recovered, underBody, bytes: result.bytes.length , physical, additionalPhysical: links.map(link => link.stats().acceptedConnections) }));
    t.assertions.assert(result.bytes.length === bytes.length && hash(result.bytes) === hash(bytes), "cold-link preview changed bytes");
    t.assertions.assert(!!owner && client.logicalConnectionId === owner && client.connectionState === "ready", "cold link replaced its logical owner");
    t.assertions.assert(underBody >= 1 && links.every(link => link.stats().acceptedConnections === 0), "cold fixture lost contention or replaced a physical carrier");
    t.assertions.assert(recovered, `cold weak-link control never recovered (errors=${rpcErrors})`);
  } finally {
    client?.close(); o.client.close(); o.daemon.stop(); await o.mock.stop();
    for (const link of links.reverse()) await link.stop(); await relay?.stop();
  }
});

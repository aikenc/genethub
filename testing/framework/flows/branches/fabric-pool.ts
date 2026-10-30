import { Client, type ClientDiagnosticEvent, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { startRelay } from "../../drivers/relay.ts";
import { startSharedBottleneck } from "../../drivers/shared-bottleneck.ts";
import { startFaultLink } from "../../drivers/fault-link.ts";
import type { CaseContext } from "../../context.ts";

export async function openFabricPool(t: CaseContext, nodeChannels: number, browserChannels: number, bothLegs = false, nativePath = false, observe?: (event: ClientDiagnosticEvent, peer: number) => void, options: { independentBrowserLeg?: boolean } = {}) {
  if (options.independentBrowserLeg && (!bothLegs || nativePath)) throw new Error("independent browser shaping requires both Fabric legs");
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const link = await startSharedBottleneck(relay.origin, { bandwidthMbps: 1000, rttMs: 0 });
  let browserLink: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  const clients: Client[] = [], browserFaults: Awaited<ReturnType<typeof startFaultLink>>[] = [];
  const diagnostics: Array<{ peer: number; state: unknown; phase: unknown; reason: unknown }> = [];
  async function dispose() {
    clients.forEach(c => c.close());
    for (const fault of browserFaults) await fault.stop();
    await browserLink?.stop(); await link.stop(); relay.stop(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
  try {
    if (options.independentBrowserLeg) browserLink = await startSharedBottleneck(relay.origin, { bandwidthMbps: 1000, rttMs: 0 });
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, "all-hop-pool"); paired.client.close();
    const reply = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: nativePath ? relay.origin : link.urlFor(relay.origin), joinToken: relay.joinToken, channelCount: nodeChannels } });
    if (reply?.type !== "remoteAccess") throw new Error("node pool attachment did not return metadata");
    let lanes = reply.data.channels ?? [];
    await t.tools.waitUntil(async () => { const r = await opened.client.call({ type: "device.list" }); if (r?.type === "devices") lanes = r.data.remote.channels ?? []; return lanes.length === nodeChannels && lanes.every(l => l.online); }, 15000);
    const browserNodeFlowIds: number[] = [];
    const nodeFlowIds = link.connections().filter(c => !c.closed).map(c => c.id);
    for (let peer = 0; peer < browserChannels; peer++) {
      const url = new URL(lanes[peer % nodeChannels]!.url); url.host = new URL(relay.origin).host;
      const fault = nativePath ? undefined : await startFaultLink(browserLink ? browserLink.urlFor(url.toString()) : bothLegs ? link.urlFor(url.toString()) : url.toString());
      if (fault) browserFaults.push(fault);
      const fresh = () => ({ url: fault ? fault.urlFor(url.toString()) : url.toString(), credential: paired.credential });
      const beforeNode = new Map(link.connections().filter(flow => nodeFlowIds.includes(flow.id)).map(flow => [flow.id, [...flow.bytes]]));
      const client = new Client({ separateDataChannel: false, ...fresh(), rtcEnabled: false, requestTimeoutMs: 10000, redial: async () => fresh(),
        socketFactory: u => new WebSocket(u) as unknown as WebSocketLike,
        onDiagnostic(event) { if (event.kind === "connection" || event.kind === "error") { diagnostics.push({ peer, state: event.detail.state, phase: event.detail.phase, reason: event.kind === "error" ? event.detail.errorName : event.detail.closeReason }); if (diagnostics.length > 40) diagnostics.shift(); } observe?.(event, peer); },
      });
      clients.push(client); client.connect(); await t.tools.waitUntil(() => client.connectionState === "ready", 15000);
      if (!nativePath) {
        // Correlate one public handshake's opaque byte deltas; TCP accept
        // order need not match the daemon's advertised lane order.
        const observed = link.connections().filter(flow => nodeFlowIds.includes(flow.id)).map(flow => {
          const before = beforeNode.get(flow.id) ?? [0, 0];
          const delta = flow.bytes.map((bytes, direction) => bytes - before[direction]!);
          return { id: flow.id, delta, total: delta.reduce((sum, bytes) => sum + bytes, 0) };
        }).sort((a, b) => b.delta[1]! - a.delta[1]!);
        const selected = observed[0];
        // Existing peers can receive a large background catalog meanwhile;
        // the new client's authentication contributes the reverse traffic.
        if (!selected || selected.delta.some(bytes => bytes <= 0) || selected.delta[1]! <= (observed[1]?.delta[1] ?? 0)) throw new Error("public handshake did not uniquely identify its physical node lane");
        if (browserChannels <= nodeChannels && browserNodeFlowIds.includes(selected.id)) throw new Error("independent advertised lanes reused one physical node flow");
        browserNodeFlowIds.push(selected.id);
      }
    }
    return { opened, relay, link, browserLink, nodeFlowIds, browserNodeFlowIds, browserFaults, clients, diagnostics, credential: paired.credential, dispose };
  } catch (error) { await dispose(); throw error; }
}

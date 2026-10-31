import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLease, releaseLease } from "../../../infrastructure/public.ts";
import { registerControlledAgent } from "../../builders/script-agent.ts";
import { startRelay } from "../../drivers/relay.ts";
import { startSharedBottleneck } from "../../drivers/shared-bottleneck.ts";
import type { CaseContext } from "../../context.ts";
import { daemonEndpoint } from "../../drivers/daemon.ts";
import { runGenetAsync } from "../../drivers/cli.ts";
import { Client, type ClientDiagnosticEvent, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";

/** Real isolated machines, not mocked session stores. Labels model team membership;
 * this does not manufacture a Hub team ACL or claim the UI already aggregates them. */
export async function openScaleFleet(t: CaseContext, machines: number, members: number, separateControl = false, poolOptions: { nodeChannels?: number; dataChannels?: number; bothLegs?: boolean; automatic?: boolean; nativeLog?: string; floodIntervalMs?: number; onDiagnostic?: (machine: number, event: ClientDiagnosticEvent) => void } = {}) {
  const relay = await startRelay({ openRoot: t.openRoot });
  const link = await startSharedBottleneck(relay.origin, { bandwidthMbps: 1000, rttMs: 0 });
  const nodes: Array<{ lease: ReturnType<typeof createLease>; opened: Awaited<ReturnType<typeof t.flows.main.openWorkspace>>; client: Client; dataClients: Client[]; control: Client; sessions: string[]; workspaces: string[]; pid: number; agent: ReturnType<typeof registerControlledAgent> }> = [];
  async function dispose() {
    for (const node of nodes) { node.client.close(); node.control.close(); node.dataClients.forEach(c => c.close()); }
    await link.stop(); relay.stop();
    const stopped = await Promise.allSettled(nodes.map(async node => {
      try {
        node.opened.client.close();
        const result = await runGenetAsync(node.opened.daemon.genet, ["daemon", "stop"], node.opened.daemon.env);
        if (result.code !== 0) throw new Error("isolated fleet daemon stop failed");
      }
      finally { await node.opened.mock.stop(); }
    }));
    for (const node of nodes) releaseLease(node.lease);
    const failed = stopped.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  try {
    for (let machine = 0; machine < machines; machine++) {
      const lease = createLease("genehub-scale-");
      if (poolOptions.nativeLog) lease.env.GENEHUB_LOCAL_LOG = poolOptions.nativeLog;
      const agent = registerControlledAgent(lease, { id: "scale-agent", profile: "flood-events", floods: 200, delayMs: 1000, floodIntervalMs: poolOptions.floodIntervalMs ?? 0 });
      let opened: Awaited<ReturnType<typeof t.flows.main.openWorkspace>>;
      try { opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease }); }
      catch (error) { releaseLease(lease); throw error; }
      // Register cleanup before doing any more fallible setup.
      const node = { lease, opened, client: opened.client, dataClients: [] as Client[], control: opened.client, sessions: [] as string[], workspaces: [] as string[], pid: 0, agent };
      nodes.push(node);
      node.pid = daemonEndpoint(opened.daemon).localServerProof.pid;
      await t.flows.main.requireAgentReady(opened.client, "scale-agent");
      for (let member = 0; member < members; member++) {
        const root = join(lease.workspace, `team-${machine}`, `member-${member}`);
        mkdirSync(root, { recursive: true });
        const workspace = await opened.client.call({ type: "workspace.open", payload: { root } });
        if (workspace?.type !== "workspace") throw new Error("member workspace was not opened");
        node.workspaces.push(workspace.data.id);
        const session = await opened.client.call({ type: "session.create", payload: {
          workspaceId: workspace.data.id, agentId: "scale-agent", modelId: null, modeId: null, title: `Team ${machine} member ${member}`, cwd: null,
        } });
        if (session?.type !== "session") throw new Error("member session was not created");
        node.sessions.push(session.data.id);
      }
      const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, `scale-manager-${machine}`);
      paired.client.close();
      const count = poolOptions.nodeChannels ?? 1;
      const attached = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: link.urlFor(relay.origin), joinToken: relay.joinToken, channelCount: count } });
      if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("node did not attach to real Relay");
      let lanes = attached.data.channels ?? [];
      await t.tools.waitUntil(async () => { const r = await opened.client.call({ type: "device.list" }); if (r?.type === "devices") lanes = r.data.remote.channels ?? []; return lanes.length === count && lanes.every(l => l.online); },15000);
      const laneUrl = (lane: number) => { const value = new URL(lanes[lane % count]!.url); value.host = new URL(relay.origin).host; return poolOptions.bothLegs ? link.urlFor(value.toString()) : value.toString(); };
      const url = new URL(laneUrl(poolOptions.automatic ? 0 : count > 1 ? 1 : 0));
      node.client = new Client({ onDiagnostic: event => poolOptions.onDiagnostic?.(machine, event), separateDataChannel: poolOptions.automatic ? undefined : false, url: url.toString(), credential: paired.credential, rtcEnabled: false, requestTimeoutMs: 10000,
        socketFactory: u => new WebSocket(u) as unknown as WebSocketLike,
        redial: async () => ({ url: url.toString(), credential: paired.credential }),
      });
      node.client.connect();
      await t.tools.waitUntil(() => node.client.connectionState === "ready", 15000);
      if (poolOptions.automatic) {
        const body = await node.client.prepareDataChannel();
        if (body === node.client || body.logicalConnectionId === node.client.logicalConnectionId) throw new Error("production body carrier was not independently admitted");
      }
      node.dataClients.push(node.client);
      for (let lane=1;lane<(poolOptions.dataChannels ?? 1);lane++) {
        const dataUrl = laneUrl(lane+1);
        const extra = new Client({ separateDataChannel: false, url: dataUrl, credential: paired.credential, rtcEnabled: false, requestTimeoutMs: 10000,
          socketFactory: u => new WebSocket(u) as unknown as WebSocketLike, redial: async () => ({ url: dataUrl, credential: paired.credential }) });
        node.dataClients.push(extra); extra.connect(); await t.tools.waitUntil(() => extra.connectionState === "ready",15000);
      }
      node.control = node.client;
      if (separateControl) {
        const controlUrl = laneUrl(0);
        node.control = new Client({ onDiagnostic: event => poolOptions.onDiagnostic?.(machine, event), separateDataChannel: false, url: controlUrl, credential: paired.credential, rtcEnabled: false, requestTimeoutMs: 10000,
          socketFactory: u => new WebSocket(u) as unknown as WebSocketLike,
          redial: async () => ({ url: controlUrl, credential: paired.credential }),
        });
        node.control.connect();
        await t.tools.waitUntil(() => node.control.connectionState === "ready", 15000);
      }
    }
    return { nodes, link, relay, dispose };
  } catch (error) { await dispose(); throw error; }
}

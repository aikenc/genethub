import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Client, ProtocolDial } from "@genehub/workbench/client";
import { allocatePort, type EnvironmentLease } from "../../infrastructure/public.ts";
import { waitUntil } from "../tools/wait.ts";
import { startHub } from "./hub.ts";
import { startRelay } from "./relay.ts";
import { connectProductClient } from "./client.ts";

/** Real account-facing workspace admission, with credentials kept in memory. */
export async function openWorkspacePeer(input: {openRoot: string; lease: EnvironmentLease; client: Client; workspaceId: string}) {
  const port = await allocatePort(), token = randomBytes(24).toString("hex");
  const hub = await startHub({databasePath: join(input.lease.root, "workspace-peer.sqlite"), relayOrigin: `http://127.0.0.1:${port}`, relayToken: token});
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let client: Client | undefined;
  const close = async () => { client?.close(); relay?.stop(); await hub.stop(); };
  try {
    relay = await startRelay({openRoot: input.openRoot, port, control: {origin: hub.origin, token}});
    const pair = await input.client.call({type: "hub.pair", payload: {hubUrl: hub.origin, displayName: "Scoped preview machine"}});
    if (pair?.type !== "hubStatus" || pair.data.state !== "pairing") throw new Error("workspace peer pairing did not start");
    const owner = hub.browser(); await hub.signInOwner(owner); await hub.approvePairing(owner, pair.data.userCode);
    const local = await input.client.call({type: "workspace.list"});
    const name = local?.type === "workspaces" ? local.data.find(w => w.id === input.workspaceId)?.name : undefined;
    if (!name) throw new Error("fixture workspace absent");
    let workspaceId = "";
    await waitUntil(async () => {
      const directory = await owner.json<{workspaces: Array<{id: string; name: string; availability: string}>}>("/app/workspaces");
      const matches = directory.workspaces.filter(w => w.name === name && w.availability === "online");
      if (matches.length > 1) throw new Error("ambiguous fixture workspace");
      workspaceId = matches[0]?.id ?? ""; return !!workspaceId;
    }, 45_000);
    const dial = async (): Promise<ProtocolDial> => {
      const endpoint = await owner.json<{endpointId: string; url: string}>("/app/fabric/endpoints", {method: "POST", body: "{}"});
      const route = await owner.json<{routeTicket: string; operationExpiresAt: string; peerCapability: string; peerSecret: string}>("/app/fabric/routes", {method: "POST", body: JSON.stringify({sourceEndpointId: endpoint.endpointId, target: {workspaceId}})});
      return {url: endpoint.url, fabricRouteTicket: route.routeTicket, fabricAuthorizationExpiresAt: route.operationExpiresAt, channelCredential: {capabilityId: route.peerCapability, secret: route.peerSecret}};
    };
    client = await connectProductClient(await dial());
    return {client, workspaceId, dial, close};
  } catch (error) { await close(); throw error; }
}

import { spawnSync } from "node:child_process";

import type { EnvironmentLease } from "../../../infrastructure/public.ts";
import { daemonEndpoint, startDaemon } from "../../drivers/daemon.ts";
import { locateGenet, tryLocateDaemonComponent } from "../../drivers/cli.ts";
import { connectProductClient } from "../../drivers/client.ts";

export {
  openControlledAgentSession,
  processAlive,
  timeControlCall,
  type ControlledAgentSession,
} from "./controlled-agent.ts";

export async function reconnectAfterStop(input: {
  openRoot: string;
  lease: EnvironmentLease;
}): Promise<{ listed: boolean }> {
  const genet = locateGenet(input.openRoot);
  const wasm = tryLocateDaemonComponent(input.openRoot);
  const first = startDaemon({ genet, wasm, lease: input.lease });
  const firstEndpoint = daemonEndpoint(first);
  const firstClient = await connectProductClient({
    ...firstEndpoint,
    redial: async () => daemonEndpoint(first),
  });
  const registered = await firstClient.call({ type: "workspace.open", payload: { root: input.lease.workspace } });
  if (registered?.type !== "workspace") throw new Error("pre-restart workspace registration failed");
  const workspaceId = registered.data.id;
  await firstClient.call({ type: "workspace.rename", payload: { workspaceId, name: "persisted-network-workspace" } });
  const before = await firstClient.call({ type: "workspace.list" });
  const oldLogicalId = firstClient.logicalConnectionId;
  firstClient.close();
  first.stop();
  const second = startDaemon({ genet, wasm, lease: input.lease });
  const secondEndpoint = daemonEndpoint(second);
  const secondClient = await connectProductClient({
    ...secondEndpoint,
    redial: async () => daemonEndpoint(second),
  });
  const after = await secondClient.call({ type: "workspace.list" });
  const newLogicalId = secondClient.logicalConnectionId;
  secondClient.close();
  second.stop();
  return { listed: before?.type === "workspaces" && after?.type === "workspaces"
    && before.data.some(w => w.id === workspaceId && w.name === "persisted-network-workspace")
    && after.data.some(w => w.id === workspaceId && w.name === "persisted-network-workspace")
    && typeof oldLogicalId === "string" && typeof newLogicalId === "string" && oldLogicalId !== newLogicalId };
}

export function leftoverProcesses(lease: EnvironmentLease): number {
  const result = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  return (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(lease.data) || line.includes(lease.root))
    .length;
}

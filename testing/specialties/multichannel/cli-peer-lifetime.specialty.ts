import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.multichannel.native-cli-peer-lifetime",
  title: "Completed remote CLI calls release logical peers instead of exhausting admission",
  oracle: "64 sequential real workspace-list commands finish through a real relay within60s; every reply contains target-only data and completed calls promptly release the daemon's32 live admission slots",
  catches: ["normal CLI exit leaves resumable logical peers retained", "remote CLI falls back to the local daemon", "connection cleanup disables recovery for running commands"],
  tags: ["core", "cli", "multichannel", "peer-lifetime"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"], surfaces: ["daemon", "relay", "genet-cli"],
  expectedDurationMs: 20000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const relay = await startRelay({ openRoot: t.openRoot });
  const data = path.join(t.env.root, "source-cli"); mkdirSync(data);
  const env = { ...o.daemon.env, GENEHUB_DATA_DIR: data, GENEHUB_LOCAL_DATA_DIR: data };
  const cli = (args: string[]) => runGenetAsync(o.daemon.genet, args, env);
  let started = false;
  try {
    if ((await cli(["daemon", "start"])).code !== 0) throw new Error("source coordinator failed to start");
    started = true;
    const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("target attach failed");
    await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 20000);
    const invite = await o.client.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("target invitation failed");
    const pair = await cli(["machine", "pair", invite.data.code, "--endpoint", attached.data.rendezvousUrl, "--name", "peer-lifetime"]);
    if (pair.code !== 0) throw new Error("pairing failed");
    const machine = (parseJson(pair.stdout).data as any).machine.machineId;
    const start = Date.now();
    for (let n = 0; n < 64; n++) {
      const result = await cli(["workspace", "list", "--machine", machine]);
      const answer = parseJson(result.stdout) as any;
      t.assertions.assert(result.code === 0 && answer.type === "workspace.list", `remote command ${n + 1}/64 failed: ${answer.error?.code}: ${answer.error?.message}`);
      t.assertions.assert(answer.data.workspaces.some((w: any) => w.id === o.workspaceId && w.root === o.workspaceRoot), "command did not reach the target-only workspace");
    }
    t.assertions.assert(Date.now() - start < 60000, "test did not exceed admission within the retained-peer lifetime");
    t.note("64 real remote CLI calls completed against target-only data within60s without retaining completed peers");
  } finally {
    if (started) await cli(["daemon", "stop"]);
    relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop();
  }
});

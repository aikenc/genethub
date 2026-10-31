import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, startRelay, startFaultLink, runGenetAsync, parseJson } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.multichannel.native-cli-resume",
  title: "The native CLI reports interruption after socket loss without re-executing the command",
  oracle: "The actual CLI pairs publicly; opaque TCP loss fails the old command, its source runs once and a fresh public RPC succeeds",
  catches: ["browser recovery falsely claimed for native CLI", "native channel loss reported as success"],
  tags: ["network-risk-v2", "multichannel", "native-cli-resume"], llm: { default: "none" }, expectedDurationMs: 20000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
  surfaces: ["genet-cli", "daemon", "websocket"], productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  stages: ["pair", "start-command", "fail-original-and-open-fresh-request"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const cliData = join(t.env.root, "remote-cli"); mkdirSync(cliData, { recursive: true });
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cliEnv = { ...o.daemon.env, GENEHUB_DATA_DIR: cliData, GENEHUB_LOCAL_DATA_DIR: cliData };
  const relay = await startRelay({ openRoot: t.openRoot });
  const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
  if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) { relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); throw new Error("rendezvous attachment failed"); }
  await t.tools.waitUntil(async () => { const d = await o.client.call({type:"device.list"}); return d?.type === "devices" && d.data.remote.online; }, 20000);
  const link = await startFaultLink(attached.data.rendezvousUrl);
  try {
    const started = await runGenetAsync(o.daemon.genet, ["daemon", "start"], cliEnv);
    if (started.code !== 0) throw new Error("CLI coordinator failed to start");
    const invite = await o.client.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("invitation failed");
    const data = await t.stage("pair", async () => {
    const paired = await runGenetAsync(o.daemon.genet, ["machine", "pair", invite.data.code, "--endpoint", link.url, "--name", "network-cli"], cliEnv);
    if (paired.code !== 0) {
      const error = parseJson(paired.stdout).error as { code?: string; message?: string } | undefined;
      throw new Error(`public CLI pairing failed: code=${error?.code} message=${String(error?.message).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(0, 500)}`);
    }
    return parseJson(paired.stdout).data as { machine: { machineId: string } };
    });
    const marker = join(o.workspaceRoot, "cli-starts");
    const result = runGenetAsync(o.daemon.genet, ["--machine", data.machine.machineId, "shell", "--workspace", o.workspaceId, "--timeout", "20", "--", "python3", "-c",
      "import pathlib,time; pathlib.Path('cli-starts').open('a').write('start\\n'); print('before-cli',flush=True); time.sleep(5); print('after-cli',flush=True)"], cliEnv);
    await t.stage("start-command", () => Promise.race([
      t.tools.waitUntil(() => existsSync(marker), 10000),
      result.then(r => { if (!existsSync(marker)) throw new Error("native command ended before execution: exit=" + r.code + " " + r.stdout.replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(-1500)); }),
    ]));
    await t.stage("fail-original-and-open-fresh-request", async () => {
    link.cut();
    const completed = await result;
    t.assertions.assert(readFileSync(marker, "utf8") === "start\n", "CLI recovery repeated command execution");
    const records = completed.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const output = records.filter(r => r.type === "shell.output" && r.data?.stream === "stdout").map(r => r.data.data).join("");
    const exits = records.filter(r => r.type === "shell.exit");
    t.assertions.assert(completed.code !== 0 && !exits.some(r => r.data.exitCode === 0) && !output.includes("after-cli"),
      `native CLI reported an interrupted command as success (exit=${completed.code})`);
    const fresh = await runGenetAsync(o.daemon.genet, ["--machine", data.machine.machineId, "workspace", "list"], cliEnv);
    t.assertions.assert(fresh.code === 0, "fresh native CLI request failed after socket loss");
    t.assertions.assert(readFileSync(marker, "utf8") === "start\n", "fresh RPC replayed the old command");
    t.note(`interruptedExit=${completed.code} oldExitFrames=${exits.length} freshRequestExit=${fresh.code} sourceExecutions=1`);
    });
  } finally { await runGenetAsync(o.daemon.genet, ["daemon", "stop"], cliEnv); await link.stop(); relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

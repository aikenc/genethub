import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, parseJson, runGenetAsync, startFaultLink, startRelay } from "../../framework/public.ts";

const MIB = 1024 * 1024;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const records = (stdout: string): any[] => stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
const scrub = (text: string) => text.replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(-1000);

defineSpecialty({
  id: "specialty.connectivity.file-verify-connection",
  title: "A healthy file stream can finish digest verification when new connections are unavailable; corrupt bytes never publish",
  oracle: "After a real native transfer begins delivering bytes, the opaque TCP boundary refuses new connections while preserving established ones. The CLI must still publish the byte-identical file with the source SHA. A second transfer whose partial is corrupted while its stream is held must fail integrity verification and publish nothing.",
  catches: ["dropping a healthy receive connection before digest verification", "treating all bytes received as verified completion", "publishing a corrupted partial"],
  tags: ["network-risk-v2", "file-transfer", "genet-cli"], llm: { default: "none" },
  expectedDurationMs: 20_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 2, browser: 0, pool: "standard" },
  surfaces: ["genet-cli", "daemon", "relay"], productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  stages: ["pair", "verify-on-existing-connection", "reject-corrupt-partial"],
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const data = join(t.env.root, "receiver"); mkdirSync(data);
  const env = { ...o.daemon.env, GENEHUB_DATA_DIR: data, GENEHUB_LOCAL_DATA_DIR: data };
  const cli = (args: string[]) => runGenetAsync(o.daemon.genet, args, env);
  const relay = await startRelay({ openRoot: t.openRoot });
  const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
  if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) {
    relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); throw new Error("source attach failed");
  }
  const link = await startFaultLink(attached.data.rendezvousUrl);
  const landing = join(t.env.root, "landing"); mkdirSync(landing);
  const source = join(t.env.root, "outside-workspace.bin"); writeFileSync(source, randomBytes(16 * MIB));
  const digest = sha256(source);
  try {
    const started = await cli(["daemon", "start"]);
    t.assertions.assert(started.code === 0, `receiver startup failed: ${scrub(started.stderr)}`);
    const machine = await t.stage("pair", async () => {
      await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 20_000);
      const invite = await o.client.call({ type: "device.invite", payload: null });
      if (invite?.type !== "invite") throw new Error("source invite failed");
      const paired = await cli(["machine", "pair", invite.data.code, "--endpoint", link.url, "--name", "verify-connection"]);
      t.assertions.assert(paired.code === 0, `pair failed: ${scrub(paired.stdout)}`);
      return (parseJson(paired.stdout).data as any).machine.machineId as string;
    });
    await t.stage("verify-on-existing-connection", async () => {
      link.refuseNewConnectionsAfterServerBytes(MIB);
      const destination = join(landing, "verified.bin");
      const downloaded = await cli(["file", "download", "--from", machine, source, destination, "--timeout", "70"]);
      const transfer = records(downloaded.stdout).find(row => row.type === "transfer.result")?.data?.transfer;
      t.assertions.assert(downloaded.code === 0 && transfer?.state === "completed" && transfer.sha256 === digest,
        `healthy established transfer needed a new connection: exit=${downloaded.code} ${scrub(downloaded.stdout)} ${scrub(downloaded.stderr)} refused=${link.refusedConnections()}`);
      t.assertions.assert(existsSync(destination) && sha256(destination) === digest, "verified output differs from the real source");
      t.assertions.assert(link.bytes().server > MIB, "the transfer never crossed the armed network fault boundary");
      t.assertions.assert(link.refusedConnections() === 0, "successful verification unnecessarily attempted a fresh connection");
      t.assertions.assert(!readdirSync(landing).some(name => name.includes(".genet-partial-")), "successful publication left a partial");
    });
    link.unblock();
    await t.stage("reject-corrupt-partial", async () => {
      link.blackholeAfterServerBytes(2 * MIB);
      const destination = join(landing, "corrupt.bin");
      const begun = await cli(["file", "download", "--from", machine, source, destination, "--no-wait"]);
      const id = records(begun.stdout).find(row => row.type === "transfer.started")?.data?.transferId as string | undefined;
      t.assertions.assert(begun.code === 0 && Boolean(id), `corruption fixture did not start: ${scrub(begun.stdout)}`);
      let partial = "";
      await t.tools.waitUntil(() => {
        partial = readdirSync(landing).find(name => name.startsWith(".corrupt.bin.genet-partial-")) ?? "";
        return link.heldBytes().server > 0 && Boolean(partial) && statSync(join(landing, partial)).size > MIB;
      }, 30_000);
      const fd = openSync(join(landing, partial), "r+");
      try { writeSync(fd, Buffer.from([readFileSync(source)[0]! ^ 0xff]), 0, 1, 0); } finally { closeSync(fd); }
      link.clearBlackhole();
      let transfer: any;
      await t.tools.waitUntil(async () => {
        const state = await cli(["file", "transfer", "status", id!]);
        transfer = (parseJson(state.stdout).data as any);
        return transfer.state === "failed";
      }, 30_000);
      t.assertions.assert(String(transfer.error).startsWith("integrityMismatch"), `corrupt partial was not refused by SHA: ${scrub(JSON.stringify(transfer))}`);
      t.assertions.assert(!existsSync(destination) && !existsSync(join(landing, partial)), "corrupt bytes were published or retained");
      t.assertions.assert(sha256(source) === digest, "negative fixture accidentally changed the source");
    });
  } finally {
    await cli(["daemon", "stop"]); await link.stop(); relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop();
  }
});

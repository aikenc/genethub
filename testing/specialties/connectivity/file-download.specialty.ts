import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty, parseJson, runGenetAsync, startFaultLink, startRelay } from "../../framework/public.ts";

const MIB = 1024 * 1024;
const scrub = (text: string): string => text.replace(/https?:\/\/\S+|wss?:\/\/\S+/g, "[endpoint]").slice(-1200);
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const records = (stdout: string): Array<Record<string, any>> =>
  stdout.split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));

defineSpecialty({
  id: "specialty.connectivity.file-download",
  title: "A machine downloads a file from another, survives its own restart mid-transfer, refuses a changed source, and cancels a stalled transfer",
  oracle: "The receiving daemon's product CLI downloads a file that lives outside every workspace on the source machine; the landed file's SHA-256 equals the source and the CLI reports the same digest; an existing destination is refused; a transfer stalled mid-stream and cut off by a receiver restart is reported interrupted and resumes from the bytes already on disk to a byte-identical file; a source changed during an interrupted transfer is refused and its partial removed; while one transfer writes a destination a second one to it is refused; cancelling a stalled transfer settles it as canceled without waiting for more bytes and leaves nothing behind",
  catches: [
    "completion claimed before the bytes were verified",
    "a resumed transfer restarting from zero or splicing two versions",
    "a receiver restart losing the transfer record",
    "a destination silently overwritten",
    "paths outside a workspace refused for the account owner",
    "two transfers racing to the same destination",
    "a cancel that waits on a stalled stream or still publishes the file",
  ],
  tags: ["network-risk-v2", "file-transfer", "genet-cli"],
  llm: { default: "none" },
  expectedDurationMs: 60_000,
  timeoutMs: 240_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 2, browser: 0, pool: "standard" },
  surfaces: ["genet-cli", "daemon", "relay"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  stages: ["pair", "download", "refuse-existing", "resume-after-restart", "busy-and-cancel", "refuse-changed-source"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const receiverData = join(t.env.root, "receiver"); mkdirSync(receiverData, { recursive: true });
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const receiverEnv = { ...o.daemon.env, GENEHUB_DATA_DIR: receiverData, GENEHUB_LOCAL_DATA_DIR: receiverData };
  const genet = (args: string[]) => runGenetAsync(o.daemon.genet, args, receiverEnv);
  const relay = await startRelay({ openRoot: t.openRoot });
  const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
  if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) { relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); throw new Error("rendezvous attachment failed"); }
  await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 20_000);
  const link = await startFaultLink(attached.data.rendezvousUrl);

  // The source sits outside every registered workspace on purpose.
  const sourceDir = join(t.env.root, "source-outside-workspaces"); mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, "payload.bin");
  writeFileSync(source, randomBytes(48 * MIB));
  const sourceDigest = sha256(source);
  const landing = join(t.env.root, "landing"); mkdirSync(landing, { recursive: true });
  const partials = () => readdirSync(landing).filter(name => name.includes(".genet-partial-"));

  try {
    const started = await genet(["daemon", "start"]);
    if (started.code !== 0) throw new Error(`receiver daemon failed to start: ${scrub(started.stderr)}`);
    const machineId = await t.stage("pair", async () => {
      const invite = await o.client.call({ type: "device.invite", payload: null });
      if (invite?.type !== "invite") throw new Error("invitation failed");
      const paired = await genet(["machine", "pair", invite.data.code, "--endpoint", link.url, "--name", "file-download"]);
      if (paired.code !== 0) throw new Error(`pairing failed: ${scrub(paired.stdout)}`);
      return (parseJson(paired.stdout).data as { machine: { machineId: string } }).machine.machineId;
    });

    await t.stage("download", async () => {
      const target = join(landing, "first.bin");
      const run = await genet(["file", "download", "--from", machineId, source, target, "--timeout", "120"]);
      const result = records(run.stdout).find(record => record.type === "transfer.result");
      t.assertions.assert(
        run.code === 0 && result?.data?.transfer?.state === "completed" && result.data.transfer.sha256 === sourceDigest,
        `download did not complete verified: exit=${run.code} ${scrub(run.stdout)} ${scrub(run.stderr)}`,
      );
      t.assertions.assert(existsSync(target) && sha256(target) === sourceDigest, "the landed file differs from the source");
      t.assertions.assert(partials().length === 0, `a completed transfer left partial files: ${partials().join(",")}`);
    });

    await t.stage("refuse-existing", async () => {
      const again = await genet(["file", "download", "--from", machineId, source, join(landing, "first.bin")]);
      const error = parseJson(again.stdout).error as { code?: string } | undefined;
      t.assertions.assert(again.code !== 0 && error?.code === "destinationExists", `an existing destination was not refused: exit=${again.code} ${scrub(again.stdout)}`);
    });

    // Stall the stream partway, take the receiver down, bring it back.
    const interrupt = async (name: string): Promise<{ id: string; onDisk: number }> => {
      link.blackholeAfterServerBytes(6 * MIB);
      const begun = await genet(["file", "download", "--from", machineId, source, join(landing, name), "--no-wait"]);
      const id = (records(begun.stdout).find(record => record.type === "transfer.started")?.data?.transferId ?? "") as string;
      t.assertions.assert(begun.code === 0 && id !== "", `the download did not start: ${scrub(begun.stdout)} ${scrub(begun.stderr)}`);
      await t.tools.waitUntil(() => link.heldBytes().server > 0 && partials().some(file => statSync(join(landing, file)).size > 0), 30_000);
      const stopped = await genet(["daemon", "stop"]);
      t.assertions.assert(stopped.code === 0, `receiver daemon did not stop: ${scrub(stopped.stderr)}`);
      link.clearBlackhole(); link.cut();
      const onDisk = partials().map(file => statSync(join(landing, file)).size).reduce((a, b) => Math.max(a, b), 0);
      const restarted = await genet(["daemon", "start"]);
      t.assertions.assert(restarted.code === 0, `receiver daemon did not restart: ${scrub(restarted.stderr)}`);
      const status = await genet(["file", "transfer", "status", id]);
      const state = (parseJson(status.stdout).data as { state?: string } | undefined)?.state;
      t.assertions.assert(state === "interrupted", `a transfer cut off by a restart was reported ${state}: ${scrub(status.stdout)}`);
      return { id, onDisk };
    };

    await t.stage("resume-after-restart", async () => {
      const { id, onDisk } = await interrupt("second.bin");
      t.assertions.assert(onDisk > 0 && onDisk < 48 * MIB, `the stall did not leave a partial file: ${onDisk}`);
      const resumed = await genet(["file", "download", "--from", machineId, source, join(landing, "second.bin"), "--timeout", "120"]);
      const transfer = records(resumed.stdout).find(record => record.type === "transfer.result")?.data?.transfer;
      t.assertions.assert(
        resumed.code === 0 && transfer?.transferId === id && transfer.state === "completed" && transfer.resumedFrom > 0 && transfer.sha256 === sourceDigest,
        `the interrupted transfer did not resume from disk: exit=${resumed.code} ${scrub(resumed.stdout)} ${scrub(resumed.stderr)}`,
      );
      t.assertions.assert(sha256(join(landing, "second.bin")) === sourceDigest, "the resumed file differs from the source");
    });

    await t.stage("busy-and-cancel", async () => {
      link.blackholeAfterServerBytes(6 * MIB);
      const target = join(landing, "fourth.bin");
      const begun = await genet(["file", "download", "--from", machineId, source, target, "--no-wait"]);
      const id = (records(begun.stdout).find(record => record.type === "transfer.started")?.data?.transferId ?? "") as string;
      t.assertions.assert(begun.code === 0 && id !== "", `the download did not start: ${scrub(begun.stdout)}`);
      await t.tools.waitUntil(() => link.heldBytes().server > 0 && partials().some(file => statSync(join(landing, file)).size > 0), 30_000);
      const other = join(sourceDir, "other.bin");
      writeFileSync(other, randomBytes(MIB));
      const busy = await genet(["file", "download", "--from", machineId, other, target, "--no-wait"]);
      const busyError = parseJson(busy.stdout).error as { code?: string } | undefined;
      t.assertions.assert(busy.code !== 0 && busyError?.code === "destinationBusy", `a second writer to the same destination was not refused: ${scrub(busy.stdout)}`);
      const canceled = await genet(["file", "transfer", "cancel", id]);
      t.assertions.assert(canceled.code === 0, `cancel failed: ${scrub(canceled.stdout)}`);
      // The stream is still stalled: the cancel must settle without more bytes.
      let state: string | undefined;
      await t.tools.waitUntil(async () => {
        const status = await genet(["file", "transfer", "status", id]);
        state = (parseJson(status.stdout).data as { state?: string } | undefined)?.state;
        return state === "canceled";
      }, 15_000);
      t.assertions.assert(!existsSync(target) && partials().length === 0, "a canceled transfer left files behind");
      link.clearBlackhole(); link.cut();
    });

    await t.stage("refuse-changed-source", async () => {
      await interrupt("third.bin");
      appendFileSync(source, randomBytes(MIB));
      const rerun = await genet(["file", "download", "--from", machineId, source, join(landing, "third.bin"), "--timeout", "120"]);
      const error = parseJson(rerun.stdout).error as { code?: string; message?: string } | undefined;
      t.assertions.assert(
        rerun.code !== 0 && error?.code === "transferFailed" && String(error.message).startsWith("sourceChanged"),
        `a changed source was not refused: exit=${rerun.code} ${scrub(rerun.stdout)}`,
      );
      t.assertions.assert(!existsSync(join(landing, "third.bin")) && partials().length === 0, "a refused transfer left files behind");
    });
  } finally {
    await genet(["daemon", "stop"]);
    await link.stop(); relay.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop();
  }
});

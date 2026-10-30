import { execFile } from "node:child_process";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureSocket, defineSpecialty, openCapturePreview } from "../../framework/public.ts";

const common = {
  tags: ["core", "network-risk-v2", "service-preview", "remote-desktop"],
  llm: {default: "none" as const}, expectedDurationMs: 15000, timeoutMs: 90000,
  resources: {environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0},
  surfaces: ["daemon", "service-preview", "capture"],
  productInterfaces: ["@genehub/workbench/client"],
  requirements: [{kind: "command" as const, env: "GENEHUB_CAPTURE_BINARY", args: ["--probe"], contains: '"available"'}],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
};

defineSpecialty({...common,
  id: "specialty.preview.capture-challenge-replay",
  title: "Real Capture ignores duplicate renewals without extending authority",
  oracle: "A consumed challenge can be retransmitted without disconnecting the socket, but only repeating that challenge still closes it within the unchanged three-second authority deadline",
  catches: ["duplicate response spuriously terminates a healthy connection", "replayed challenge extends authority forever", "expired connection wedges Capture"],
}, async t => {
  const capture = await openCapturePreview(t);
  const wire = await captureSocket(capture.service);
  let replay: ReturnType<typeof setInterval> | undefined;
  try {
    await t.tools.waitUntil(() => wire.messages.some(m => m.event === "challenge"), 5000);
    const nonce = wire.messages.find(m => m.event === "challenge")!.params.nonce;
    const renewal = {method: "renew", params: {nonce}};
    await wire.send(renewal);
    await wire.send(renewal);
    await wire.send({id: "alive", method: "state.get"});
    await t.tools.waitUntil(() => wire.messages.some(m => m.id === "alive"), 2000);
    t.assertions.assert(!wire.closed(), "a duplicate challenge closed the connection");
    // Continue application traffic; it must not replace a fresh challenge.
    replay = setInterval(() => {void wire.send(renewal).catch(() => {});}, 250);
    await t.tools.waitUntil(wire.closed, 6000);
    const state = await (await capture.service.fetch("/api/remote/state")).json();
    t.assertions.assert(state.shared === false && state.viewing === false, "expiry changed source policy or left a view");
    t.assertions.assert(state.source === null, "state reports source health without a view");
    t.note("Real public Capture WS tolerated duplicate reply, expired despite repeated old nonce, and remained available default off; no native media/input claimed.");
  } finally {clearInterval(replay); wire.close(); await capture.close();}
});

defineSpecialty({...common,
  id: "specialty.preview.capture-rpc-replay",
  title: "Real Capture request IDs are idempotent and conflicts close only their connection",
  oracle: "Byte-identical state request replay returns the same response; changing the method under that ID closes the socket, while another socket remains usable and cannot open a source-off session",
  catches: ["duplicate request is lost", "same ID can be reused for a different action", "malformed client tears down unrelated clients", "control WS opens a view"],
}, async t => {
  const capture = await openCapturePreview(t);
  const first = await captureSocket(capture.service);
  const second = await captureSocket(capture.service, "/api/remote/control");
  try {
    const request = {id: "once", method: "state.get"};
    await first.send(request); await first.send(request);
    await t.tools.waitUntil(() => first.messages.filter(m => m.id === "once").length === 2, 5000);
    const replies = first.messages.filter(m => m.id === "once");
    t.assertions.assert(JSON.stringify(replies[0]) === JSON.stringify(replies[1]), "idempotent reply changed");
    await first.send({id: "once", method: "session.open"});
    await t.tools.waitUntil(first.closed, 5000);
    await second.send({id: "wrong-plane", method: "session.open"});
    await t.tools.waitUntil(() => second.messages.some(m => m.id === "wrong-plane"), 2000);
    t.assertions.assert(second.messages.find(m => m.id === "wrong-plane")!.error?.code === "unsupported_method", "control anchor opened a view");
    t.assertions.assert(!second.closed(), "conflict terminated a different connection");
    t.note("Public Capture RPC replay/conflict and anchor-plane isolation verified without native media or OS input.");
  } finally {first.close(); second.close(); await capture.close();}
});

defineSpecialty({...common,
  id: "specialty.preview.capture-process-lifecycle",
  title: "Capture singleton, graceful restart and crash residue preserve registration ownership",
  oracle: "A second app cannot acquire the same account lock; graceful exit removes its own entry only, restart has a new run ID, hard-kill recovery rotates its own run without a manual deletion, and a foreign replacement survives shutdown and restart refusal",
  catches: ["multiple Capture providers overlap in one account", "graceful stop deletes a different registration", "reconnect reuses old run identity", "own crash residue requires manual deletion", "foreign registration is silently replaced", "old client reaches recovered run"],
}, async t => {
  const capture = await openCapturePreview(t);
  const directory = join(t.env.data, "service-previews");
  const unrelated = join(directory, "unrelated.json");
  try {
    const otherEntry = join(t.env.workspace, "other.html");
    await copyFile(capture.entry, otherEntry);
    const competing = capture.launch(otherEntry);
    await competing.exited;
    t.assertions.assert(competing.child.exitCode !== 0 && competing.output().includes("Capture lock is busy"), "second Capture did not fail on singleton lock");
    const original = capture.service.descriptor.runId;
    const state = await (await capture.service.fetch("/api/remote/state")).json();
    t.assertions.assert(state.runId === original && state.shared === false, "competing process changed current source");
    await writeFile(unrelated, '{"sentinel":"owned-by-another-service"}', {mode: 0o600});
    capture.source.child.kill("SIGTERM"); await capture.source.exited;
    t.assertions.assert(capture.source.child.exitCode === 0, "graceful source stop failed");
    t.assertions.assert(await capture.discover() === null, "graceful stop left discoverable source");
    t.assertions.assert(await readFile(unrelated, "utf8") === '{"sentinel":"owned-by-another-service"}', "stop changed another registration");
    const restarted = capture.launch();
    let newRun = "";
    await t.tools.waitUntil(async () => {
      const service = await capture.discover();
      if (!service) return false;
      newRun = service.descriptor.runId; service.close(); return true;
    }, 15000);
    t.assertions.assert(newRun !== original, "restart reused old run ID");
    restarted.child.kill("SIGKILL"); await restarted.exited;
    const files = (await readdir(directory)).filter(name => name !== "unrelated.json" && name.endsWith(".json"));
    t.assertions.assert(files.length === 1, "crash did not leave the one known source record");
    const record = join(directory, files[0]!);
    const before = await readFile(record, "utf8");
    const recovered = capture.launch();
    await t.tools.waitUntil(async () => {
      if (recovered.child.exitCode !== null) throw new Error(`Own crash recovery exited: ${recovered.output()}`);
      if (!recovered.output().includes('"ready":true')) return false;
      const service = await capture.discover();
      if (!service) return false;
      if (service.descriptor.runId === newRun) {service.close(); return false;}
      service.close(); return true;
    }, 15000);
    const recoveredService = await capture.discover();
    t.assertions.assert(recoveredService !== null, "recovered source disappeared");
    const recoveredState = await (await recoveredService!.fetch("/api/remote/state")).json();
    t.assertions.assert(recoveredState.runId !== newRun && recoveredState.shared === false && recoveredState.allowControl === false && recoveredState.viewing === false, "recovered source reused authority or enabled sharing");
    let staleRejected = false;
    try {await capture.service.fetch("/api/remote/state");} catch {staleRejected = true;}
    t.assertions.assert(staleRejected, "stale public consumer reached recovered run");
    recoveredService!.close();
    const ownRecord = JSON.parse(await readFile(record, "utf8"));
    const foreign = JSON.stringify({...ownRecord, name: "Different provider using this entry"});
    // Retain runId: cleanup must compare the owned record, not only its ID.
    await writeFile(record, foreign, {mode: 0o600});
    recovered.child.kill("SIGTERM"); await recovered.exited;
    t.assertions.assert(await readFile(record, "utf8") === foreign, "shutdown deleted another provider with the same run ID");
    const refused = capture.launch(); await refused.exited;
    t.assertions.assert(refused.child.exitCode !== 0 && refused.output().includes("entry already registered"), "foreign registration was replaced");
    t.assertions.assert(await readFile(record, "utf8") === foreign, "failed restart changed foreign registration");
    t.assertions.assert(await readFile(unrelated, "utf8") === '{"sentinel":"owned-by-another-service"}', "recovery changed unrelated service");
    t.assertions.assert(before.length > 0, "missing original crash evidence");
    t.note("Real process crash recovered with a fresh default-off run; stale public consumer rejected; same-run foreign record and unrelated service survived cleanup and restart refusal. Native video/input remain separate.");
  } finally {await capture.close();}
});

defineSpecialty({
  id: "specialty.preview.capture-source-health-units",
  title: "Capture's own source-health, H.264 level and SPS rules hold",
  oracle: "The owning Capture crate runs its pure rules: repeated floor pictures never prove a live capture, the advertised H.264 level is derived from size/rate/bitrate, and the encoder's real SPS (profile, level, cropped size) is parsed",
  catches: ["encoder activity from a stalled source treated as live desktop", "SDP level drifts from the configured picture", "SPS parse or cropping regression"],
  tags: ["contract", "network-risk-v2", "service-preview", "remote-desktop"], llm: { default: "none" },
  expectedDurationMs: 60000, timeoutMs: 400000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["capture", "os-process"],
}, async t => {
  try {
    const { stdout } = await promisify(execFile)("cargo", ["test", "--manifest-path", join(t.openRoot, "apps/capture/Cargo.toml")], {
      cwd: t.openRoot, env: process.env, timeout: 380000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(!!result, "capture unit rules did not execute successfully: " + stdout.slice(-3000));
    t.note(`capture units passed=${result![1]}`);
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`capture unit rules failed: ${(e.stdout ?? "").slice(-4000)}\n${(e.stderr ?? e.message).slice(-3000)}`);
  }
});

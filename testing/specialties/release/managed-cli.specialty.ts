import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BlockedError, defineSpecialty, locateGenet, parseJson, runGenetAsync,
  seedScriptAgentRuntime, tryLocateDaemonComponent, tryLocateHost, type CaseContext,
} from "../../framework/public.ts";

// Public CLI consumers against an external release-protocol fixture. Nothing
// inside daemon/Host is replaced: bytes are packed by the actual native Host.
async function fixture(t: CaseContext, selfUpdate = false) {
  const hostArtifact = tryLocateHost(t.openRoot);
  const raw = tryLocateDaemonComponent(t.openRoot);
  if (!hostArtifact || !raw) throw new BlockedError("CLI updater requires built Host and guest artifacts");
  const bin = path.join(t.env.root, "bin");
  mkdirSync(bin);
  const cli = path.join(bin, "genet-local");
  const host = path.join(bin, "genehub-host-local");
  copyFileSync(locateGenet(t.openRoot), cli);
  copyFileSync(hostArtifact, host);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...t.env.env, GENEHUB_CLI: cli, GENEHUB_LOCAL_CLI: cli,
    GENEHUB_BUNDLED_RELEASE_VERSION: "0.1.0",
  };
  for (const key of ["GENEHUB_SESSION_ID", "GENEHUB_CONTROLLER_TOKEN", "GENEHUB_HOST", "GENEHUB_LOCAL_COMPONENT", "GENEHUB_LOCAL_DAEMON_COMPONENT", "GENEHUB_LOCAL_DAEMON_COMMAND", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
  const exec = async (binary: string, args: string[]) => {
    const r = await runGenetAsync(binary, args, env, { cwd: t.env.workspace });
    if (r.code !== 0) throw new Error(`${path.basename(binary)} ${args[0]} failed: ${r.stdout || r.stderr}`);
    return args[0] === "pack" ? {} : args[0] === "inspect" ? JSON.parse(r.stdout) : parseJson(r.stdout) as any;
  };
  await exec(host, ["pack", raw, path.join(bin, "genehub_guest.wasm"), "local", "0.1.0"]);
  const latest = path.join(t.env.root, "latest.wasm");
  await exec(host, ["pack", raw, latest, "local", "0.1.1"]);
  const bytes = readFileSync(latest);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = await exec(host, ["inspect", latest]);
  let origin = "";
  let downloads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/component") res.end(JSON.stringify({
      schema: "genehub.release-manifest.v2", channel: "local", releaseVersion: "0.1.1",
      appAbiHash: identity.appAbiHash, webProtocol: identity.webProtocol,
      artifact: { sources: [{ url: origin + "/guest" }], sha256, size: bytes.length },
      source: { kind: "test" }, activation: { enabled: true },
    }));
    else if (req.url === "/guest") { downloads++; res.end(bytes); }
    else if (req.url === "/app") res.end(JSON.stringify({
      channel: "local", version: "0.1.0", platforms: {
        "linux-x86_64": { kind: "cli", url: origin + "/bad-app", size: 3, sha256: "0".repeat(64) },
        "darwin-aarch64": { kind: "cli", url: origin + "/bad-app", size: 3, sha256: "0".repeat(64) },
      },
    }));
    else if (req.url === "/bad-app") res.end("bad");
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("release fixture has no port");
  origin = `http://127.0.0.1:${address.port}`;
  env.GENEHUB_COMPONENT_MANIFEST_URL = origin + "/component";
  env.GENEHUB_APP_MANIFEST_URL = origin + "/app";
  let started = false;
  try {
    if (selfUpdate) {
      seedScriptAgentRuntime(t.env, t.openRoot);
      const agent = path.join(t.env.data, "agents/user/self-probe");
      mkdirSync(agent, { recursive: true });
      writeFileSync(path.join(agent, "agent.genet.json"), JSON.stringify({ schema: "genet.agent.v1", protocol: 1, label: "Update Probe", entry: "agent.py" }));
      copyFileSync(fileURLToPath(new URL("../../fixtures/managed-update/agent.py", import.meta.url)), path.join(agent, "agent.py"));
    }
    await exec(cli, ["daemon", "start"]);
    started = true;
    return {
      call: (args: string[]) => exec(cli, args),
      rejected: async (args: string[]) => {
        const r = await runGenetAsync(cli, args, env);
        return { code: r.code, envelope: parseJson(r.stdout) as any };
      },
      sha256,
      downloads: () => downloads,
      async close() {
        try { if (started) await exec(cli, ["daemon", "stop"]); }
        finally { await new Promise<void>(resolve => server.close(() => resolve())); }
      },
    };
  } catch (error) {
    if (started) await exec(cli, ["daemon", "stop"]);
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}

function meta(id: string, title: string, oracle: string, catches: string[]) {
  return {
    id, title, oracle, catches, tags: ["core", "release", "cli-update"],
    llm: { default: "none" as const }, expectedDurationMs: 40_000, timeoutMs: 180_000,
    resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "heavy" as const },
    surfaces: ["daemon", "genehub-host", "cli"], productInterfaces: ["genet-cli", "genehub-host"],
  };
}

defineSpecialty(meta(
  "specialty.release.cli-live-idempotence", "Native CLI updates once and refuses a conflicting request",
  "receipt confirms a changed guest instance, target version and loaded SHA; duplicate downloads nothing; bad App leaves daemon PID alive",
  ["accepted receipt mistaken for completion", "duplicate installs", "App corruption stops old daemon", "CLI reports compiled rather than running identity"],
), async t => {
  const f = await fixture(t);
  try {
    const before = (await f.call(["update", "check"])).data.current;
    const result = (await f.call(["update", "live", "--request-id", "native-live", "--wait"])).data;
    t.assertions.assert(result.updateState === "succeeded" && result.liveApplied, "Live did not complete");
    t.assertions.assert(result.running.instanceId !== before.instanceId && result.runningComponentVersion === "0.1.1" && result.running.componentSha256 === f.sha256, "running identity does not prove target activation");
    await f.call(["update", "live", "--request-id", "native-live"]);
    t.assertions.assert(f.downloads() === 1, "duplicate downloaded another component");
    const conflict = await f.rejected(["update", "app", "--request-id", "native-live"]);
    t.assertions.assert(conflict.code === 4 && conflict.envelope.error.code === "requestIdConflict", "request kind conflict was accepted");
    const pid = (await f.call(["daemon", "status"])).pid;
    const bad = (await f.call(["update", "app", "--request-id", "bad-app", "--wait"])).data;
    const after = await f.call(["daemon", "status"]);
    t.assertions.assert(bad.updateState === "failed" && /checksum/.test(bad.error) && after.pid === pid && after.running, "bad App did not fail before disturbing daemon");
  } finally { await f.close(); }
});

defineSpecialty(meta(
  "specialty.release.cli-self-update-resume", "Agent resumes its original goal after updating its own daemon",
  "one original input yields a final reply after reload with durable resumed receipt, no pending inputs and one download",
  ["worker dies with caller", "old request remains stuck", "Agent requires Human continue", "duplicate inbox delivery"],
), async t => {
  const f = await fixture(t, true);
  try {
    const run = await f.call(["agent", "run", "--agent", "self-probe", "--model", "probe", "--cwd", t.env.workspace, "--open-workspace", "--no-wait", "--message-id", "original-input", "complete the goal after upgrading yourself"]);
    // A read may fail while the resident guest changes. Poll observations only;
    // no failed assertion or update action is retried.
    const end = Date.now() + 90_000;
    let receipt: any, session: any, sends: any[] = [];
    while (Date.now() < end) {
      try { sends = readFileSync(path.join(t.env.workspace, "self-update-sends.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch {}
      try { receipt = (await f.call(["update", "status", "--request-id", "self-live"])).data; } catch {}
      if (sends.length) try { session = (await f.call(["session", "get", sends[0].sessionId])).data.session; } catch {}
      if (receipt?.updateState === "succeeded" && receipt.continuation.state === "resumed" && session?.summary.status === "idle") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    t.assertions.assert(Boolean(run) && receipt?.updateState === "succeeded" && receipt.continuation.state === "resumed", "self-update did not finish and resume");
    t.assertions.assert(sends.length === 2 && sends[1].hasUpdateReceipt && sends[0].sessionId === sends[1].sessionId, "original Session was not resumed once with its receipt");
    t.assertions.assert(session?.summary.status === "idle" && session.summary.inputSummary.pendingMessageIds.length === 0 && session.items.filter((x: any) => x.type === "assistantMessage").length === 1 && f.downloads() === 1, "original goal did not finish exactly once");
  } finally { await f.close(); }
});

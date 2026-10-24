import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  BlockedError, defineSpecialty, runGenetAsync, tryLocateDaemonComponent, tryLocateHost,
} from "../../framework/public.ts";

// strace is an external OS fault injector, not a product replacement. This
// Linux regression requires it; a missing tool is blocked, never passed.
defineSpecialty({
  id: "specialty.release.component-store-transaction",
  title: "A concurrent Host cannot replace the candidate another Host validated",
  oracle: "with candidate-to-active rename delayed by the OS, a second real Host's recovery/apply cannot steal that candidate; successful target, active signed bytes and watermark agree",
  catches: ["CLI and resident Host rely on different process-local locks", "recovery consumes an in-flight candidate", "a refused older download replaces a newer candidate"],
  tags: ["core", "release", "cli-update", "recovery"], llm: { default: "none" },
  expectedDurationMs: 20_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "heavy" },
  surfaces: ["genehub-host", "filesystem", "os-process", "release-service"],
  productInterfaces: ["genehub-host component-update", "genehub-host inspect"],
}, async t => {
  if (process.platform !== "linux" || spawnSync("strace", ["-V"], { timeout: 5000 }).status !== 0) {
    throw new BlockedError("the Linux candidate-rename fault regression requires strace");
  }
  const host = tryLocateHost(t.openRoot), raw = tryLocateDaemonComponent(t.openRoot);
  if (!host || !raw) throw new BlockedError("built Host and guest are required");
  const env: NodeJS.ProcessEnv = { ...process.env, ...t.env.env, GENEHUB_BUNDLED_RELEASE_VERSION: "0.1.0" };
  for (const key of ["GENEHUB_SESSION_ID", "GENEHUB_CONTROLLER_TOKEN", "GENEHUB_HOST", "GENEHUB_LOCAL_COMPONENT", "GENEHUB_LOCAL_DAEMON_COMPONENT"]) delete env[key];
  const run = (args: string[]) => runGenetAsync(host, args, env, { cwd: t.env.workspace });
  const file = (v: string) => path.join(t.env.root, `${v}.wasm`);
  for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
    const packed = await run(["pack", raw, file(version), "local", version]);
    t.assertions.assert(packed.code === 0, `pack failed: ${packed.stderr}`);
  }
  const inspected = await run(["inspect", file("0.1.2")]);
  t.assertions.assert(inspected.code === 0, `inspect failed: ${inspected.stderr}`);
  const identity = JSON.parse(inspected.stdout);
  const artifacts = new Map(["0.1.1", "0.1.2"].map(version => [`/${version}.wasm`, readFileSync(file(version))]));
  const server = createServer((req, res) => {
    const bytes = artifacts.get(req.url ?? "");
    if (bytes) res.end(bytes);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("release fixture has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  env.GENEHUB_COMPONENT_MANIFEST_URL = origin + "/manifest";
  const manifest = (version: string) => {
    const bytes = artifacts.get(`/${version}.wasm`)!;
    const name = path.join(t.env.root, `${version}.json`);
    writeFileSync(name, JSON.stringify({
      schema: "genehub.release-manifest.v2", channel: "local", releaseVersion: version,
      appAbiHash: identity.appAbiHash, webProtocol: identity.webProtocol,
      artifact: { sources: [{ url: `${origin}/${version}.wasm` }], sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
      source: { kind: "external-release-fixture" }, activation: { enabled: true },
    }));
    return name;
  };
  const trace = path.join(t.env.root, "rename.trace");
  // The Host first renames baseline, candidate, watermark, then active. Pause
  // that last syscall after its real validation, without changing its result.
  const child = spawn("strace", ["-f", "-o", trace, "-e", "trace=rename,renameat,renameat2",
    "-e", "inject=renameat:delay_enter=8s:when=4", host, "component-update", "apply", file("0.1.0"), manifest("0.1.2")],
  { env, cwd: t.env.workspace, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", ended = false;
  child.stdout.on("data", (b: Buffer) => { stdout = (stdout + b.toString()).slice(-8192); });
  child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-8192); });
  const finished = new Promise<number>(resolve => {
    child.once("error", error => { stderr += error.message; ended = true; resolve(-1); });
    child.once("close", code => { ended = true; resolve(code ?? -1); });
  });
  try {
    await t.tools.waitUntil(() => {
      const lines = existsSync(trace) ? readFileSync(trace, "utf8") : "";
      if (lines.includes("candidate.wasm\"") && lines.includes("active.wasm\"")) return true;
      if (ended) throw new Error(`newer Host exited before controlled rename: ${stderr}`);
      return false;
    }, 20_000);
    const watermark = path.join(t.env.data, "component/highest-version");
    t.assertions.assert(readFileSync(watermark, "utf8").trim() === "0.1.2", "fault was not at a fenced commit");
    const older = await run(["component-update", "apply", file("0.1.0"), manifest("0.1.1")]);
    t.assertions.assert(older.code !== 0 && older.stderr.includes("older than highest"), "older activation was not refused");
    t.assertions.assert(await finished === 0 && JSON.parse(stdout).releaseVersion === "0.1.2", `newer activation failed: ${stderr}`);
    t.assertions.assert(readFileSync(trace, "utf8").includes("(DELAYED)"), "OS did not inject the commit interleaving");
    const active = path.join(t.env.data, "component/active.wasm");
    const actual = await run(["inspect", active]);
    t.assertions.assert(actual.code === 0 && JSON.parse(actual.stdout).releaseVersion === "0.1.2", "active version differs from successful target");
    t.assertions.assert(readFileSync(active).equals(artifacts.get("/0.1.2.wasm")!) && readFileSync(watermark, "utf8").trim() === "0.1.2", "activation bytes or monotonic watermark changed");
    t.assertions.assert(!existsSync(path.join(t.env.data, "component/candidate.wasm")), "refused stale apply left a replacement candidate");
  } finally {
    if (!ended && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await finished;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

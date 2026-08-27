#!/usr/bin/env node
// Build, sign, inspect and optionally activate one component-only update —
// and, with --web, the matching website half of the same Live Release.
// Native binaries, tags and GitHub releases are deliberately outside this
// command: a Live Release is local and lands in seconds.

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquirePublishLock, ensureStampedWorktree } from "./lib/publish-tree.mjs";

const open = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsMap = parseArguments(process.argv.slice(2));
if (argumentsMap.has("help")) {
  usage();
  process.exit(0);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const started = Date.now();
  const commit = argumentsMap.has("commit");
  const channel = argumentsMap.get("channel") ?? "beta";
  if (!new Set(["stable", "beta", "dev"]).has(channel)) {
    throw new Error("--channel must be stable, beta or dev");
  }
  const web = argumentsMap.has("web");
  if (web && !commit) throw new Error("--web publishes the live site, so it requires --commit");
  const cloud = resolve(
    argumentsMap.get("cloud-root") ?? process.env.GENEHUB_CLOUD_ROOT ?? join(open, "../genethub-cloud"),
  );
  const { publishComponent } = await import(pathToFileURL(join(cloud, "publisher/component.mjs")).href);
  const { readCurrent } = await import(pathToFileURL(join(cloud, "publisher/store.mjs")).href);
  const { nextLiveVersion } = await import(pathToFileURL(join(cloud, "publisher/version.mjs")).href);
  if (commit) {
    requireClean(open, "genethub");
    requireClean(cloud, "genethub-cloud");
  }
  const source = {
    openSha: git(open, ["rev-parse", "HEAD"]),
    cloudSha: git(cloud, ["rev-parse", "HEAD"]),
    lockfileSha256: lockDigest(cloud),
  };

  const temporary = mkdtempSync(join(tmpdir(), "genehub-guest-publish-"));
  const stage = argumentsMap.has("stage") ? requiredAbsolute("--stage", argumentsMap.get("stage")) : undefined;
  const root = commit
    ? (argumentsMap.has("store")
      ? requiredAbsolute("--store", argumentsMap.get("store"))
      : stage
        ? join(stage, "artifacts")
        : required("--store or --stage", undefined))
    : join(temporary, "artifacts");
  if (web && !stage) throw new Error("--web requires --stage so the site has a stage root");
  const publicOrigin = commit
    ? required("--public-origin", argumentsMap.get("public-origin"))
    : "https://candidate.invalid";
  const runner = process.env.GENEHUB_RUNNER_ID ?? `${userInfo().username}@${hostname()}`;

  // A committed Live build compiles for its channel while the source tree
  // always says `local`, so the guest compiles in a persistent per-channel
  // worktree that stays stamped between publishes (scripts/lib/publish-tree.mjs).
  // Without the stamp the guest carries the local channel constants — it reads
  // GENEHUB_LOCAL_DATA_DIR while a beta host hands it GENEHUB_BETA_DATA_DIR,
  // and every updated machine dies on the next boot with "no platform data
  // directory". Keeping the stamp out of the main checkout is what makes a
  // warm publish fast: the tree never flip-flops, and a byte-identical
  // re-stamp leaves mtimes alone, so cargo keeps target/publish/<channel>
  // warm. The Live version is never stamped into Cargo.toml either — it
  // travels in the signed envelope (pack's argv) and reaches the runtime as
  // GENEHUB_COMPONENT_VERSION, and stamping the workspace version would
  // invalidate every crate's fingerprint for nothing.
  let version = argumentsMap.has("version")
    ? required("--version", argumentsMap.get("version"))
    : undefined;
  if (commit && !version) {
    const current = await readCurrent(root, "component", channel);
    if (!current) throw new Error("the channel's first component release requires an explicit version");
    version = nextLiveVersion(current.value.releaseVersion);
  }
  // One Live publish per channel at a time; held for the whole run because
  // the version computation and the store write race just as badly as the
  // worktree does.
  const releaseLock = commit ? acquirePublishLock(open, channel) : null;

  // The Cargo builds share one package-cache lock, so they run as one
  // sequential chain; the console build (npm/rolldown-vite) is an independent
  // toolchain and runs concurrently with it. A committed guest build compiles
  // in the stamped worktree against its own channel-keyed target directory;
  // the signer compiles from the main checkout — pack/inspect take channel
  // and version from argv (the only compiled-in constants they use, MODULE_ID
  // and the WIT ABI digest, are identical across channels), so one
  // local-stamped host binary signs every channel and target/publish/signer
  // stays warm across publishes. An unchanged tree makes every one of these
  // a no-op measured in seconds.
  const cargo = resolveCargo(argumentsMap.get("cargo"));
  let raw = argumentsMap.get("raw") ? resolve(argumentsMap.get("raw")) : null;
  let signer = argumentsMap.get("signer") ? resolve(argumentsMap.get("signer")) : null;
  const builds = [];
  if (!raw || !signer) {
    builds.push((async () => {
      if (!raw) {
        const tree = commit ? ensureStampedWorktree(open, channel, source.openSha) : open;
        // The channel-keyed target dir doubles as the warm dependency cache;
        // it predates the worktree flow and stays put so the first publish
        // under it does not recompile the world.
        const guestTarget = commit ? join(open, "target", "publish", channel) : join(open, "target");
        raw = await buildRaw(cargo, channel, tree, guestTarget);
      }
      if (!signer) {
        const signerTarget = commit ? join(open, "target", "publish", "signer") : join(open, "target");
        signer = await buildSigner(cargo, signerTarget);
      }
    })());
  }
  if (web) builds.push(buildWeb(cloud, channel));
  await Promise.all(builds);
  const builtMs = Date.now() - started;

  const githubUrl = channel === "stable"
    ? argumentsMap.get("github-url") ??
      (!commit
        ? "https://github.com/aikenc/genethub/releases/download/component-candidate/genehub_guest.wasm"
        : undefined)
    : undefined;
  const appRelease = argumentsMap.has("app-release")
    ? {
        release: required("--app-release", argumentsMap.get("app-release")),
        appAbiHash: requiredHash("--app-abi-hash", argumentsMap.get("app-abi-hash")),
      }
    : undefined;

  try {
    const result = await publishComponent({
      root,
      channel,
      publicOrigin,
      githubUrl,
      source,
      runner,
      verifyPublic: commit,
      appRelease,
      version,
      pausedReason: argumentsMap.get("paused-reason"),
      build: async (version) => signAndInspect({
        signer,
        raw,
        output: join(temporary, `genehub-component-${version}.wasm`),
        channel,
        version,
      }),
    });
    let webReceipt;
    if (web && result.changed !== false) {
      webReceipt = await publishWebHalf({ cloud, stage, channel, source, runner, version: result.version });
    }
    const totalMs = Date.now() - started;
    process.stdout.write(`${JSON.stringify(
      { mode: commit ? "committed" : "candidate", store: root, ...result,
        ...(webReceipt ? { web: webReceipt } : {}),
        timing: { buildMs: builtMs, totalMs } },
      null, 2,
    )}\n`);
  } finally {
    releaseLock?.();
    if (commit || argumentsMap.has("discard-candidate")) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function guestProfile(channel) {
  return channel === "stable" ? "release" : "iterate";
}

function buildRaw(cargo, channel, tree, targetDir) {
  const profile = guestProfile(channel);
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  return run(cargo, ["build", "--profile", profile, "-p", "genehub-guest", "--target", "wasm32-wasip2"], { cwd: tree, env })
    .then(() => join(targetDir, "wasm32-wasip2", profile, "genehub_guest.wasm"));
}

function buildSigner(cargo, targetDir) {
  // The tree is never stamped, so the bin keeps its local name. The binary
  // signs for any channel: `pack` takes channel and version from argv.
  const name = process.platform === "win32" ? "genehub-host-local.exe" : "genehub-host-local";
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  return run(cargo, ["build", "--profile", "iterate", "-p", "genehub-host"], { env })
    .then(() => join(targetDir, "iterate", name));
}

// The website half of a Live Release: exact dependencies only when the
// lockfile moved, then the rolldown-vite build (seconds, not the historical
// tsc+vite half minute). Tests stay with CI — this chain is for iteration.
async function buildWeb(cloud, channel) {
  const consoleRoot = join(cloud, "console");
  await npmCiIfChanged(consoleRoot);
  const brand = { stable: "GeneHub", beta: "GeneHub Beta", dev: "GeneHub Dev" }[channel];
  await run("npm", ["--prefix", consoleRoot, "run", "build"], {
    env: { ...process.env, VITE_GENEHUB_CHANNEL: channel, VITE_GENEHUB_BRAND: brand },
  });
}

async function npmCiIfChanged(prefix) {
  const digest = createHash("sha256").update(readFileSync(join(prefix, "package-lock.json"))).digest("hex");
  const stamp = join(prefix, "node_modules", ".deploy-lockfile-sha256");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === digest) return;
  await run("npm", ["--prefix", prefix, "ci"]);
  writeFileSync(stamp, `${digest}\n`);
}

function publishWebHalf({ cloud, stage, channel, source, runner, version }) {
  const buildId = `${source.cloudSha.slice(0, 12)}-${source.openSha.slice(0, 12)}-${source.lockfileSha256.slice(0, 12)}`;
  return run("node", [
    join(cloud, "deploy", "web-release.mjs"),
    "--stage", stage,
    "--dist", join(cloud, "console", "dist"),
    "--channel", channel,
    "--build-id", buildId,
    "--open-sha", source.openSha,
    "--cloud-sha", source.cloudSha,
    "--lockfile-sha256", source.lockfileSha256,
    "--runner", runner,
    "--release-version", version,
  ]);
}

function signAndInspect({ signer, raw, output, channel, version }) {
  execFileSync(
    signer,
    ["pack", raw, output, channel, version],
    { cwd: open, stdio: ["ignore", "inherit", "inherit"] },
  );
  const identity = JSON.parse(execFileSync(signer, ["inspect", output], { cwd: open, encoding: "utf8" }));
  return { identity, bytes: readFileSync(output) };
}

function lockDigest(cloud) {
  const hash = createHash("sha256");
  for (const [repository, name] of [[open, "Cargo.lock"], [cloud, "publisher/package.json"]]) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(join(repository, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function requireClean(repository, label) {
  if (git(repository, ["status", "--porcelain"])) throw new Error(`${label} must be clean before publication`);
}

// Release hosts run this under sanitized environments (systemd units, masked
// PATH to keep a stray node away from native builds) that may not contain
// rustup's per-user bin directory. Trust an explicit override first, then
// look where rustup actually installs, and only then gamble on PATH.
function resolveCargo(override) {
  if (override) return override;
  if (process.env.CARGO) return process.env.CARGO;
  const rustup = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  return existsSync(rustup) ? rustup : "cargo";
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: open, stdio: "inherit", ...options });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

function required(label, value) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

function requiredAbsolute(label, value) {
  const path = resolve(required(label, value));
  if (!isAbsolute(path) || path === resolve(path, "/")) throw new Error(`${label} must be a narrow absolute path`);
  return path;
}

function requiredHash(label, value) {
  const text = required(label, value);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  return text;
}

function parseArguments(values) {
  const result = new Map();
  const flags = new Set(["commit", "discard-candidate", "help", "web"]);
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith("--")) throw new Error(`unexpected argument ${raw}`);
    const name = raw.slice(2);
    if (result.has(name)) throw new Error(`duplicate argument --${name}`);
    if (flags.has(name)) result.set(name, true);
    else {
      const value = values[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      result.set(name, value);
    }
  }
  return result;
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/publish-component.mjs --channel beta [--raw FILE] [--paused-reason TEXT] [--discard-candidate]
  node scripts/publish-component.mjs --commit --channel beta --store DIR --public-origin URL
  node scripts/publish-component.mjs --commit --channel beta --stage DIR --public-origin URL --web

The default uses an isolated candidate store. --commit additionally requires a
clean paired checkout. --stage implies --store DIR/artifacts, and --web (commit
only) additionally builds the console and activates the same Product Version
on the website half, so one command lands a whole Live Release in seconds.
Every channel signs with the one self-contained development root; the stable
line reintroduces external keys when it graduates.
ABI hash changes additionally require --app-release VERSION --app-abi-hash HASH.
Guest compile uses Cargo profile iterate unless --channel stable (then release).
Cargo itself resolves as --cargo PATH, then $CARGO, then ~/.cargo/bin/cargo,
then a bare PATH lookup — sanitized publish environments without rustup's bin
directory in PATH still find it.
Committed builds compile in a persistent stamped worktree under target/publish/
(scripts/lib/publish-tree.mjs); the checkout itself is never stamped or restored.
`);
}

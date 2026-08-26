#!/usr/bin/env node
// Build, sign, inspect and optionally activate one component-only update —
// and, with --web, the matching website half of the same Live Release.
// Native binaries, tags and GitHub releases are deliberately outside this
// command: a Live Release is local and lands in seconds.

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

  // A committed release compiles for its channel, and the tree always says
  // `local`: stamp the channel and the resolved version in before any Cargo
  // build, and put the tree back afterwards. Without the stamp the guest
  // carries the local channel constants — it reads GENEHUB_LOCAL_DATA_DIR
  // while a beta host hands it GENEHUB_BETA_DATA_DIR, and every updated
  // machine dies on the next boot with "no platform data directory".
  // The version has to be resolved here, before the build: the publisher
  // would pick it inside the channel lease, but the compile needs it stamped.
  let version = argumentsMap.has("version")
    ? required("--version", argumentsMap.get("version"))
    : undefined;
  if (commit && !version) {
    const current = await readCurrent(root, "component", channel);
    if (!current) throw new Error("the channel's first component release requires an explicit version");
    version = nextLiveVersion(current.value.releaseVersion);
  }
  if (commit) {
    run(process.execPath, [join(open, "scripts/channel.mjs"), channel]);
    run(process.execPath, [join(open, "scripts/stamp-version.mjs"), version]);
  }
  const restoreTree = () => {
    if (commit) git(open, ["checkout", "--", "."]);
  };

  // The Cargo builds share one package-cache lock, so they run as one
  // sequential chain; the console build (npm/rolldown-vite) is an independent
  // toolchain and runs concurrently with it. An unchanged tree makes every
  // one of these a no-op measured in seconds.
  const cargo = argumentsMap.get("cargo") ?? "cargo";
  let raw = argumentsMap.get("raw") ? resolve(argumentsMap.get("raw")) : null;
  let signer = argumentsMap.get("signer") ? resolve(argumentsMap.get("signer")) : null;
  const builds = [];
  if (!raw || !signer) {
    builds.push((async () => {
      if (!raw) raw = await buildRaw(cargo, channel);
      if (!signer) signer = await buildSigner(cargo, channel);
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
    restoreTree();
    if (commit || argumentsMap.has("discard-candidate")) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function guestProfile(channel) {
  return channel === "stable" ? "release" : "iterate";
}

function buildRaw(cargo, channel) {
  const profile = guestProfile(channel);
  return run(cargo, ["build", "--profile", profile, "-p", "genehub-guest", "--target", "wasm32-wasip2"])
    .then(() => join(open, "target/wasm32-wasip2", profile, "genehub_guest.wasm"));
}

function buildSigner(cargo, channel) {
  // The stamp renames the bin in apps/host/Cargo.toml, so the signer lands
  // under the channel's host name.
  const name = process.platform === "win32" ? `genehub-host-${channel}.exe` : `genehub-host-${channel}`;
  return run(cargo, ["build", "--profile", "iterate", "-p", "genehub-host"])
    .then(() => join(open, "target/iterate", name));
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
`);
}

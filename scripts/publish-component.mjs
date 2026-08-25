#!/usr/bin/env node
// Build, sign, inspect and optionally activate one component-only update.
// Native binaries, tags and GitHub releases are deliberately outside this command.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const commit = argumentsMap.has("commit");
  const channel = argumentsMap.get("channel") ?? "beta";
  if (!new Set(["stable", "beta", "dev"]).has(channel)) {
    throw new Error("--channel must be stable, beta or dev");
  }
  const cloud = resolve(
    argumentsMap.get("cloud-root") ?? process.env.GENEHUB_CLOUD_ROOT ?? join(open, "../genethub-cloud"),
  );
  const { publishComponent } = await import(pathToFileURL(join(cloud, "publisher/component.mjs")).href);
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
  const root = commit ? requiredAbsolute("--store", argumentsMap.get("store")) : join(temporary, "artifacts");
  const publicOrigin = commit
    ? required("--public-origin", argumentsMap.get("public-origin"))
    : "https://candidate.invalid";
  const raw = argumentsMap.get("raw")
    ? resolve(argumentsMap.get("raw"))
    : buildRaw(argumentsMap.get("cargo") ?? "cargo", channel);
  const signer = argumentsMap.get("signer")
    ? resolve(argumentsMap.get("signer"))
    : buildSigner(argumentsMap.get("cargo") ?? "cargo");
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
      runner: process.env.GENEHUB_RUNNER_ID ?? `${userInfo().username}@${hostname()}`,
      verifyPublic: commit,
      appRelease,
      pausedReason: argumentsMap.get("paused-reason"),
      build: async (version) => signAndInspect({
        signer,
        raw,
        output: join(temporary, `genehub-component-${version}.wasm`),
        channel,
        version,
      }),
    });
    process.stdout.write(`${JSON.stringify({ mode: commit ? "committed" : "candidate", store: root, ...result }, null, 2)}\n`);
  } finally {
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
  exec(cargo, ["build", "--profile", profile, "-p", "genehub-guest", "--target", "wasm32-wasip2"]);
  return join(open, "target/wasm32-wasip2", profile, "genehub_guest.wasm");
}

function buildSigner(cargo) {
  exec(cargo, ["build", "--profile", "iterate", "-p", "genehub-host"]);
  return join(open, "target/iterate", process.platform === "win32" ? "genehub-host-local.exe" : "genehub-host-local");
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

function exec(command, args) {
  execFileSync(command, args, { cwd: open, stdio: "inherit" });
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
  const flags = new Set(["commit", "discard-candidate", "help"]);
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

The default uses an isolated candidate store. --commit additionally requires a
clean paired checkout. Every channel signs with the one self-contained
development root; the stable line reintroduces external keys when it graduates.
ABI hash changes additionally require --app-release VERSION --app-abi-hash HASH.
Guest compile uses Cargo profile iterate unless --channel stable (then release).
`);
}

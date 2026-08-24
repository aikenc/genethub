#!/usr/bin/env node
// Content fingerprint of the native binaries desktop CI may restore from
// cache. The guest wasm is not here: it is compiled once on Linux.
//
//   host  apps/host + packages/native + packages/identity + lockfile
//   cli   apps/cli + packages/frontdoor + packages/native + packages/http + lockfile
//
// Every tree is exactly what gets compiled *into* that binary, which is the
// only thing a content fingerprint can honestly promise. Neither list holds
// `apps/daemon` or `packages/proto` any more: the daemon is the component the
// shell loads, not code linked into the shell, and the session schema went with
// it. That is what the crate split bought — see `docs/cli-thin-forwarder.md` §6.
//
// A cache hit is not a test skip. Supervision still runs. A missing binary
// after a reported hit is a miss: rebuild, do not pretend the gate passed.
//
//   node scripts/ci-native-fingerprint.mjs [--repo <path>]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TREES = {
  host: [
    "Cargo.lock",
    "Cargo.toml",
    "apps/host/",
    "packages/native/",
    "packages/identity/",
  ],
  cli: [
    "Cargo.lock",
    "Cargo.toml",
    "apps/cli/",
    "packages/frontdoor/",
    "packages/native/",
    "packages/http/",
  ],
};

export function listTree(repo, spec) {
  const result = spawnSync("git", ["-C", repo, "ls-files", "-z", "--", spec], {
    encoding: "buffer",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files ${spec} failed`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function fingerprint(repo, specs) {
  const files = [...new Set(specs.flatMap((spec) => listTree(repo, spec)))].sort();
  const hash = createHash("sha256");
  hash.update(`${files.length}\n`);
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(repo, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function allFingerprints(repo) {
  return {
    host: fingerprint(repo, TREES.host),
    cli: fingerprint(repo, TREES.cli),
  };
}

function parseArgs(argv) {
  const at = argv.indexOf("--repo");
  return { repo: at === -1 ? process.cwd() : argv[at + 1] };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const { repo } = parseArgs(process.argv.slice(2));
  const prints = allFingerprints(repo);
  for (const [key, value] of Object.entries(prints)) {
    console.log(`${key}=${value}`);
  }
}

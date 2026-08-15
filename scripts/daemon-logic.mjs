#!/usr/bin/env node
// Fast local producer for the same single-file artifact that release CI builds.
// It deliberately uses the development profile and development signing root;
// official artifacts are always produced by the Linux release job.

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.CARGO_TARGET_DIR || join(repo, "target");
const raw = join(
  target,
  "wasm32-unknown-unknown",
  "daemon-logic-dev",
  "genet_daemon_logic.wasm",
);
const output = join(target, "daemon-logic.wasm");
const cargo = process.env.CARGO || "cargo";
const run = (args) => execFileSync(cargo, args, { cwd: repo, stdio: "inherit" });

const started = performance.now();
run([
  "build",
  "-p",
  "genet-daemon-logic",
  "--target",
  "wasm32-unknown-unknown",
  "--profile",
  "daemon-logic-dev",
]);
mkdirSync(dirname(output), { recursive: true });
run([
  "run",
  "--quiet",
  "-p",
  "genet-daemon-artifact",
  "--",
  "pack-dev",
  raw,
  output,
  "0.0.0-dev",
]);
const elapsed = ((performance.now() - started) / 1000).toFixed(2);
console.log(`ready: ${output} (${statSync(output).size} bytes, ${elapsed}s)`);
console.log(`run with GENET_DAEMON_LOGIC_WASM=${output}`);

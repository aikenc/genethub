#!/usr/bin/env node
// Start the staged iterate host + guest and wait for a listening line.
// Desktop CI runs this before the 120s supervision suite so a pairing or
// loader failure is printed, not hidden behind a timeout.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const exe = process.platform === "win32" ? ".exe" : "";
const host = path.resolve(`target/debug/genehub-host-local${exe}`);
const wasm = path.resolve("target/debug/genehub_guest.wasm");
const magic = readFileSync(wasm).subarray(0, 4);
if (Buffer.compare(magic, Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== 0) {
  console.error(`staged guest is not wasm: ${wasm} magic=${magic.toString("hex")}`);
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "genehub-smoke-"));
const child = spawn(host, ["run", "--component", wasm], {
  env: {
    ...process.env,
    GENEHUB_LOCAL_DATA_DIR: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
let listened = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  if (listened || !/listening/.test(stdout)) return;
  listened = true;
  clearTimeout(timeout);
  child.kill();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill();
  console.error("staged trio did not print listening within 30s");
  if (stdout) console.error(`stdout:\n${stdout}`);
  if (stderr) console.error(`stderr:\n${stderr}`);
  process.exit(1);
}, 30_000);

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(`failed to spawn ${host}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (listened || /listening/.test(stdout)) {
    console.log("staged trio reached listening");
    process.exit(0);
  }
  console.error(`host exited before listening (code=${code} signal=${signal})`);
  if (stdout) console.error(`stdout:\n${stdout}`);
  if (stderr) console.error(`stderr:\n${stderr}`);
  process.exit(1);
});

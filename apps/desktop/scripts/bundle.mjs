#!/usr/bin/env node
// Builds a desktop installer.
//
// The CLI (which is also the daemon) and the built-in agent are release
// binaries copied into `bin/`, where Tauri picks them up as bundled
// resources. Nothing here needs Node at runtime: the UI is a static build
// loaded by the system WebView, which is what keeps the installer small and
// the machine free of a runtime it never asked for (`docs/desktop-client.md`
// §4.1).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");

// What this build calls itself. `scripts/channel.mjs` writes channel.env next
// to itself before a release build (and `dev` when nobody stamped), so the
// packaging here agrees with the names cargo just built. The defaults are for
// a local build nobody stamped — dev, because that is what the tree says.
let CHANNEL = "dev";
let PRODUCT = "GeneHub Dev";
let CLI_BINARY = "genet-dev";
let AGENT_BINARY = "genet-agent-dev";
const LOGIC_ARTIFACT = "daemon-logic.wasm";

const envFile = join(repo, "scripts/channel.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (!match) continue;
    const [, key, val] = match;
    if (key === "CHANNEL") CHANNEL = val;
    else if (key === "PRODUCT") PRODUCT = val;
    else if (key === "CLI_BINARY") CLI_BINARY = val;
    else if (key === "AGENT_BINARY") AGENT_BINARY = val;
  }
}

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

// There is deliberately no Linux desktop product. Linux receives the static
// daemon/CLI tarball from release.yml and uses the browser workbench. Failing
// before cargo/npm work prevents an accidental CI invocation from quietly
// resurrecting an unsupported deb/AppImage release path.
const platformBundle = { win32: "nsis", darwin: "dmg" }[process.platform];
if (!platformBundle) {
  fail(`desktop bundles support only Windows and macOS (got ${process.platform}); use the Linux daemon/CLI tarball`);
}
const bundles = process.env.BUNDLES || platformBundle;
if (bundles !== platformBundle) {
  fail(`desktop bundle '${bundles}' is not supported on ${process.platform}; expected '${platformBundle}'`);
}

console.log(`==> building the CLI (which is the daemon) and the built-in agent (${CHANNEL})`);
run("cargo", ["build", "--release", "--manifest-path", join(repo, "Cargo.toml"), "-p", "genet-cli", "-p", "genet-agent"]);

console.log("==> staging binaries");
const binDir = join(here, "../src-tauri/bin");
// Cleaned first: the previous build's staged binaries are still here, and a
// beta build after an official one would otherwise ship both channels'
// daemons in one installer. README.md is tracked and stays.
for (const entry of readdirSync(binDir)) {
  if (entry !== "README.md") rmSync(join(binDir, entry), { recursive: true, force: true });
}
// The shell looks for the platform's own name at runtime (`bundled_binary` in
// `src-tauri/src/lib.rs`), so the suffix has to survive the copy.
const exe = process.platform === "win32" ? ".exe" : "";
for (const binary of [CLI_BINARY, AGENT_BINARY]) {
  cpSync(join(repo, "target/release", binary + exe), join(binDir, binary + exe));
}
// The Wasm application is compiled and signed exactly once by the Linux
// producer job. Native installer builders only consume those bytes. A local
// bundle may use `node scripts/daemon-logic.mjs` to create the same dev file.
const logicSource = process.env.GENET_DAEMON_LOGIC_WASM || join(repo, "target", LOGIC_ARTIFACT);
if (!existsSync(logicSource)) {
  fail(`signed daemon logic is missing at ${logicSource}; run 'node scripts/daemon-logic.mjs' or set GENET_DAEMON_LOGIC_WASM`);
}
cpSync(logicSource, join(binDir, LOGIC_ARTIFACT));

console.log(`==> building the installer (${bundles})`);
run("npm", ["--prefix", join(here, ".."), "run", "build", "--", "--bundles", bundles], { shell: process.platform === "win32" });

const bundleDir = join(here, "../src-tauri/target/release/bundle");
if (!existsSync(bundleDir)) fail(`Tauri reported success but ${bundleDir} is missing`);
console.log("==> done");
for (const entry of readdirSync(bundleDir, { recursive: true })) {
  console.log(`    ${entry}`);
}

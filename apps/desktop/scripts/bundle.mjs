#!/usr/bin/env node
// Builds a desktop installer.
//
// The CLI (which is also the daemon) and the built-in agent are release
// binaries copied into `bin/`, where Tauri picks them up as bundled
// resources. Nothing here needs Node at runtime: the UI is a static build
// loaded by the system WebView, which is what keeps the installer small and
// the machine free of a runtime it never asked for (`docs/desktop-client.md`
// §4.1).

import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
let ENV_DATA_DIR = "GENEHUB_DEV_DATA_DIR";
let ENV_WORKSPACE_DIR = "GENEHUB_DEV_WORKSPACE_DIR";
let LIB_DIR_NAME = "GeneHub Dev";
let DESKTOP_FILE = "GeneHub Dev.desktop";

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
    else if (key === "ENV_DATA_DIR") ENV_DATA_DIR = val;
    else if (key === "ENV_WORKSPACE_DIR") ENV_WORKSPACE_DIR = val;
    else if (key === "LIB_DIR_NAME") LIB_DIR_NAME = val;
    else if (key === "DESKTOP_FILE") DESKTOP_FILE = val;
  }
}

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

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

// AppImage is left out of the default because its tooling is downloaded at
// bundle time, which turns an offline build into a failed one. Ask for it
// explicitly with BUNDLES=appimage when a release needs it.
const platformDefault = { linux: "deb", darwin: "dmg" }[process.platform] ?? "nsis";
const bundles = process.env.BUNDLES || platformDefault;

console.log(`==> building the installer (${bundles})`);
run("npm", ["--prefix", join(here, ".."), "run", "build", "--", "--bundles", bundles], { shell: process.platform === "win32" });

const bundleDir = join(here, "../src-tauri/target/release/bundle");

// Matched by name and newest first, not "any .deb": old packages survive in
// this directory, and picking the first match happily checks last week's
// official build while calling it this build — which then fails one rename
// later with "no such file", because the paths inside belong to the other
// channel.
const debDir = join(bundleDir, "deb");
const deb = existsSync(debDir)
  ? readdirSync(debDir)
      .filter((name) => name.startsWith(`${LIB_DIR_NAME}_`) && name.endsWith(".deb"))
      .map((name) => join(debDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  : undefined;
// Missing is only a failure when this build was asked for one — the Windows
// job builds nsis and has no deb to check, by design.
if (bundles.includes("deb") && !deb) {
  fail(`no package named '${LIB_DIR_NAME}_*.deb' under ${debDir}`);
}

// The claims the installer has to keep are cheap to check and easy to break
// by accident, so they are checked here rather than trusted: no Node runtime
// anywhere in the tree, and a download under budget (`docs/roadmap.md` MVP
// 验收清单).
if (deb) {
  console.log(`    checking ${deb}`);
  console.log("==> checking the package");
  const contents = execFileSync("dpkg-deb", ["-c", deb], { encoding: "utf8" });
  const nodeHits = contents.split("\n").filter((line) => /\/(node|node\.exe)$|\/node_modules\//.test(line));
  if (nodeHits.length > 0) {
    console.error(nodeHits.join("\n"));
    fail("a Node runtime is inside the package");
  }

  const downloadMb = Math.trunc(statSync(deb).size / 1_000_000);
  const installedMb = Math.trunc(Number(execFileSync("dpkg-deb", ["-f", deb, "Installed-Size"], { encoding: "utf8" }).trim()) / 1000);
  console.log(`    download ${downloadMb}MB (budget 80MB), installed ${installedMb}MB (budget 200MB)`);
  if (downloadMb > 80 || installedMb > 200) fail("over the size budget");
  console.log("    no Node runtime in the package");

  // A package that installs cleanly but ships a binary that cannot start is a
  // failure nobody notices until a user hits it, so the shipped daemon is run
  // from an unpacked copy rather than the one cargo just built.
  const staged = mkdtempSync(join(tmpdir(), "genehub-bundle-"));
  try {
    run("dpkg-deb", ["-x", deb, staged]);
    // Output goes to files rather than pipes: the daemon does not exit on its
    // own, and a full pipe under it would make this look like a crash. stderr
    // is kept too — a daemon that cannot start says why, and "did not come
    // up" with no reason attached is a debugging session, not a check.
    const outFile = join(staged, "out.json");
    const errFile = join(staged, "err.log");
    const outFd = openSync(outFile, "w");
    const errFd = openSync(errFile, "w");
    spawnSync(join(staged, `usr/lib/${LIB_DIR_NAME}/bin/${CLI_BINARY}`), ["daemon", "run"], {
      stdio: ["ignore", outFd, errFd],
      timeout: 15_000,
      env: { ...process.env, [ENV_DATA_DIR]: join(staged, "data"), [ENV_WORKSPACE_DIR]: join(staged, "workspace") },
      killSignal: "SIGTERM",
    });
    const out = readFileSync(outFile, "utf8");
    if (out.includes('"event":"listening"')) {
      console.log("    the packaged daemon starts and reports a port");
    } else {
      console.error(readFileSync(errFile, "utf8"));
      fail("the packaged daemon did not come up");
    }

    // A fresh install has to be able to answer "where would you run this?"
    // itself.
    if (!existsSync(join(staged, "workspace"))) fail("a new install has no folder to work in");
    console.log("    a new install comes with a folder to work in");

    if (!existsSync(join(staged, `usr/share/applications/${DESKTOP_FILE}`))) {
      fail("no application entry, so it will not appear in the menu");
    }
    console.log("    the application entry is present");
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

console.log("==> done");
try {
  execSync(`ls -la "${bundleDir}"`, { stdio: "inherit" });
} catch {
  /* nothing bundled is its own report above */
}

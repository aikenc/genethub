#!/usr/bin/env node
// The one place that decides which heavy CI jobs a change set must run. The
// workflow calls this script and nothing else; a path that matches no rule
// fails safe to the full suite, so a renamed directory can never sneak past
// the heavy gates.
//
// The question that opens the expensive legs: will this change set be *shipped
// as a new App*? Only two things make that true — an edit to the ABI boundary
// (`wit/`, which is the digest the publisher signs) or an edit to the App's own
// sources (host, CLI, desktop shell, native, and the tooling that stamps and
// packages them). Everything else, including the whole client session protocol,
// rides out as a Live release against an App that is already installed.
//
// That distinction is a fact, not a policy: `apps/host/src/abi.rs` bakes
// `sha256(wit/genehub-host.wit)` at compile time, and `publisher/component.mjs`
// derives Live-vs-App from that signed digest. A change to `packages/proto`
// cannot move it. This script must not invent a second, stricter answer.
//
// So there are three tiers, not two:
//
//   App (`desktop`) — Win/mac matrix, installer, notarization closure. Either
//   the ABI boundary moved, or a source with platform-specific branches that
//   ships inside a native binary did. Those branches are the reason a second
//   and third operating system have to compile it: an owner-only DACL and a
//   `taskkill` fallback are invisible to a Linux job.
//     wit/, apps/host, apps/cli, apps/desktop, packages/native,
//     packages/frontdoor, Cargo.toml/lock, scripts/, .github/.
//
//   Linux guard (`rust`) — portable code with no platform branches at all. One
//   ubuntu job proves it still compiles and its tests still pass; a second and
//   third operating system would be running the same code path twice more:
//     packages/proto, packages/identity, packages/http, apps/daemon.
//
//   Nothing heavy — build on a Linux box and upload:
//     apps/guest, apps/guest-probe, apps/agent, packages/wasi-guest,
//     packages/workbench, apps/relay, testing/, docs.
//
// `apps/daemon` and `packages/proto` sit in the guard tier because the App no
// longer links either one: the front door's own vocabulary is `packages/
// frontdoor` and the protocol generation it stamps is `packages/identity`, so
// the daemon and the session schema are loaded at run time rather than compiled
// in (`docs/cli-thin-forwarder.md` §6). Before that split, editing a session
// message opened three operating systems.
//
// Extra outputs:
//   app           == desktop. The one bit humans should read: are we building
//                 an App on Windows and macOS this run?
//   guest         Linux-only wasm compile, and only when a native job needs a
//                 component to supervise
//   native_host   Win/mac host rustc + fs_perms
//   native_cli    Win/mac CLI rustc
//   native_daemon leftover Win/mac daemon-lib test (lockfile / force only)
//
//   node scripts/ci-classify.mjs --all            every job
//   node scripts/ci-classify.mjs --stdin          read changed paths, one per line
//   node scripts/ci-classify.mjs --files a b c    classify explicit paths
//
// Output is `key=value` lines for $GITHUB_OUTPUT plus a human summary on
// stderr. Tested by scripts/ci-classify.test.mjs, which the workflow runs
// before trusting any output — a broken classifier never produces one.

const ALL_JOBS = ["rust", "relay", "web", "desktop"];
const ALL_NATIVES = ["host", "cli", "daemon"];

// Order is irrelevant: every file matches exactly one rule or falls through to
// the fail-safe. `jobs` lists the heavy jobs the path must trigger. `native`
// lists which Win/mac rustc trees a later desktop run may not skip.
const RULES = [
  { match: (f) => f.startsWith(".github/"), jobs: ALL_JOBS, force: true, native: ALL_NATIVES, why: "CI/release definition" },
  { match: (f) => f === "Cargo.toml" || f === "Cargo.lock", jobs: ["rust", "desktop"], native: ALL_NATIVES, why: "native dependency graph" },
  { match: (f) => f.startsWith("wit/"), jobs: ["rust", "desktop"], native: ["host"], why: "ABI hash boundary" },
  { match: (f) => f.startsWith("apps/host/"), jobs: ["rust", "desktop"], native: ["host"], why: "Host runtime ships in the installer" },
  { match: (f) => f.startsWith("apps/cli/"), jobs: ["rust", "desktop"], native: ["cli"], why: "CLI/launcher ships in the installer" },
  // Test-only edits assert over shipped sources; they ship nothing themselves.
  // The Win/mac matrix re-runs the suite the next time a shipped source moves,
  // so a tests-only tip pays for no heavy leg at all.
  { match: (f) => f.startsWith("apps/desktop/src-tauri/tests/"), jobs: [], native: [], why: "desktop test-only change: no shipped source moves, no App to rebuild" },
  { match: (f) => f.startsWith("apps/desktop/"), jobs: ["desktop"], native: [], why: "Desktop shell and installer" },
  { match: (f) => f.startsWith("apps/daemon/"), jobs: ["rust"], native: [], why: "Client Component; nothing native links it, so a Linux build guard is the whole gate" },
  { match: (f) => f.startsWith("apps/agent/"), jobs: [], native: [], why: "Client Component; Linux wasm, not a cross-platform App" },
  { match: (f) => f.startsWith("apps/guest/") || f.startsWith("apps/guest-probe/"), jobs: [], native: [], why: "Client Component; Linux wasm, not a cross-platform App" },
  { match: (f) => f.startsWith("apps/relay/"), jobs: [], native: [], why: "hosted service; deploy from a Linux box, not App CI" },
  { match: (f) => f.startsWith("packages/proto/"), jobs: ["rust"], native: [], why: "session protocol: rides inside the Component, no native binary links it" },
  { match: (f) => f.startsWith("packages/identity/"), jobs: ["rust"], native: [], why: "protocol generation the Host stamps: portable, no platform branches" },
  { match: (f) => f.startsWith("packages/http/"), jobs: ["rust"], native: [], why: "compiled into the CLI but portable: one OS proves it" },
  { match: (f) => f.startsWith("packages/frontdoor/"), jobs: ["rust", "desktop"], native: ["cli"], why: "the native front door itself: per-OS locks, permissions and process control" },
  { match: (f) => f.startsWith("packages/wasi-guest/"), jobs: [], native: [], why: "Client Component support crate" },
  { match: (f) => f.startsWith("packages/native/"), jobs: ["rust", "desktop"], native: ["host"], why: "linked into the Host binary" },
  { match: (f) => f.startsWith("packages/workbench/"), jobs: [], native: [], why: "Web/workbench; Linux npm build, not App CI" },
  { match: (f) => f.startsWith("testing/"), jobs: [], native: [], why: "test engineering; run locally, ships nothing" },
  { match: (f) => f.startsWith("scripts/"), jobs: ["rust", "desktop"], native: ["host", "cli"], why: "stamping, installer and release tooling" },
  { match: (f) => f.startsWith("docs/") || f.endsWith(".md") || f.startsWith("LICENSE"), jobs: [], native: [], why: "documentation" },
];

function emptyNatives() {
  return { host: false, cli: false, daemon: false };
}

export function classifyFiles(files) {
  const jobs = { rust: false, relay: false, web: false, desktop: false };
  const natives = emptyNatives();
  const unmatched = [];
  let force = false;
  const reasons = [];

  for (const file of files) {
    const rule = RULES.find((r) => r.match(file));
    if (!rule) {
      unmatched.push(file);
      force = true;
      continue;
    }
    if (rule.force) force = true;
    for (const job of rule.jobs) jobs[job] = true;
    for (const native of rule.native ?? []) natives[native] = true;
    reasons.push(`${file}: ${rule.why}`);
  }

  if (force) {
    for (const job of ALL_JOBS) jobs[job] = true;
    for (const native of ALL_NATIVES) natives[native] = true;
  }

  // Any native job needs one Linux wasm to launch supervision against. Tips
  // that open no native job never reach this.
  const guest = jobs.rust || jobs.desktop;
  // Not `rust || desktop`: a Linux build guard is not an App build. Only the
  // Win/mac matrix produces the thing an App release ships.
  const app = jobs.desktop;

  return {
    ...jobs,
    guest,
    app,
    native_host: natives.host,
    native_cli: natives.cli,
    native_daemon: natives.daemon,
    force,
    unmatched,
    reasons,
  };
}

function parseArgs(argv) {
  if (argv.includes("--all")) return { all: true, files: [] };
  const at = argv.indexOf("--files");
  if (at !== -1) return { all: false, files: argv.slice(at + 1) };
  if (argv.includes("--stdin")) return { all: false, files: null };
  return null;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split("\n").map((l) => l.trim()).filter(Boolean);
}

function allSuite() {
  return {
    rust: true,
    relay: true,
    web: true,
    desktop: true,
    guest: true,
    app: true,
    native_host: true,
    native_cli: true,
    native_daemon: true,
    force: true,
    unmatched: [],
    reasons: ["--all: full suite"],
  };
}

function emit(result) {
  for (const reason of result.reasons) console.error(`  ${reason}`);
  if (result.unmatched.length) {
    console.error(`  unmatched (fail-safe to full suite): ${result.unmatched.join(", ")}`);
  }
  console.error(
    `filter: app=${result.app} rust=${result.rust} relay=${result.relay} web=${result.web} desktop=${result.desktop} guest=${result.guest} native_host=${result.native_host} native_cli=${result.native_cli} native_daemon=${result.native_daemon}`,
  );

  console.log(`app=${result.app}`);
  console.log(`rust=${result.rust}`);
  console.log(`relay=${result.relay}`);
  console.log(`web=${result.web}`);
  console.log(`desktop=${result.desktop}`);
  console.log(`guest=${result.guest}`);
  console.log(`native_host=${result.native_host}`);
  console.log(`native_cli=${result.native_cli}`);
  console.log(`native_daemon=${result.native_daemon}`);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: ci-classify.mjs --all | --stdin | --files <path...>");
    process.exit(2);
  }
  emit(args.all ? allSuite() : classifyFiles(args.files ?? (await readStdin())));
}

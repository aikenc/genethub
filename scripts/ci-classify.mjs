#!/usr/bin/env node
// The one place that decides which heavy CI jobs a change set must run. The
// workflow calls this script and nothing else; a path that matches no rule
// fails safe to the full suite, so a renamed directory can never sneak past
// the heavy gates.
//
// This script does NOT decide the release type. Whether a change ships as a
// Live Release (Client Component + Web, no reinstall) or must be an App
// Release (installer) is a runtime fact, decided at publish time by the ABI
// hash: `publisher/component.mjs` refuses a component whose `appAbiHash`
// differs from the channel's current one unless an explicit App Release is
// paired. A path table can only guess at that boundary; the signed hash is
// the truth. Keeping a second, path-based guess here would let the two
// disagree, so the release decision has exactly one home.
//
// The table below is only a test selector. It is derived from the dependency
// closures:
//
//   Native closure (ships in the installer):
//     apps/host (loads the Component), apps/cli (launcher), apps/desktop
//     (shell + installer), wit/ (ABI hash), scripts/ (stamping/install/
//     release tooling), Cargo.toml/Cargo.lock (native dependency graph),
//     packages/native (linked into the Host binary).
//
//   Component closure (compiled into the Client Component):
//     apps/guest, apps/guest-probe, apps/daemon + apps/agent,
//     packages/proto (WebProtocol), packages/http, packages/wasi-guest.
//
//   Hosted (deployed, not installed): apps/relay, packages/workbench.
//
//   testing/ gates the above but ships nothing itself.
//
// Extra outputs (not jobs) tell later legs what they may skip:
//   guest         compile genehub_guest.wasm once on Linux
//   native_host   Win/mac host rustc + fs_perms
//   native_cli    Win/mac CLI rustc (the CLI links the daemon crate)
//   native_daemon Win/mac `cargo test -p genet-daemon --lib`
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
  { match: (f) => f.startsWith("apps/desktop/"), jobs: ["desktop"], native: [], why: "Desktop shell and installer" },
  { match: (f) => f.startsWith("apps/daemon/"), jobs: ["rust", "desktop"], native: ["cli", "daemon"], why: "compiled into the Component; desktop shares its persistence" },
  { match: (f) => f.startsWith("apps/agent/"), jobs: ["rust"], native: [], why: "compiled into the Component" },
  { match: (f) => f.startsWith("apps/guest/") || f.startsWith("apps/guest-probe/"), jobs: ["rust"], native: [], why: "the Client Component itself" },
  { match: (f) => f.startsWith("apps/relay/"), jobs: ["relay"], native: [], why: "hosted service, deployed not installed" },
  { match: (f) => f.startsWith("packages/proto/"), jobs: ["rust"], native: ["host"], why: "WebProtocol, absorbed by the adapter window" },
  { match: (f) => f.startsWith("packages/http/"), jobs: ["rust"], native: ["cli"], why: "HTTP crate linked into the CLI" },
  { match: (f) => f.startsWith("packages/wasi-guest/"), jobs: ["rust"], native: [], why: "Component closure support crate" },
  { match: (f) => f.startsWith("packages/native/"), jobs: ["rust", "desktop"], native: ["host"], why: "linked into the Host binary" },
  { match: (f) => f.startsWith("packages/workbench/"), jobs: ["web"], native: [], why: "the Workbench" },
  { match: (f) => f.startsWith("testing/"), jobs: ["rust"], native: [], why: "test engineering ships nothing" },
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

  // The web job's mandatory journeys drive a real daemon, agent and relay; a
  // change on either side of that wire must re-prove them.
  if (jobs.rust || jobs.relay) jobs.web = true;

  // wasm32-wasip2 is platform-independent. One Linux compile feeds every
  // job that starts a daemon.
  const guest = jobs.rust || jobs.desktop || jobs.web;

  return {
    ...jobs,
    guest,
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
    `filter: rust=${result.rust} relay=${result.relay} web=${result.web} desktop=${result.desktop} guest=${result.guest} native_host=${result.native_host} native_cli=${result.native_cli} native_daemon=${result.native_daemon}`,
  );

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

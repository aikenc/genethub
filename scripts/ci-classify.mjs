#!/usr/bin/env node
// The one place that decides what a change set means: which CI jobs must run
// and whether the result can ship as a Live Release (Client Component + Web,
// no reinstall) or must be an App Release (installer). The workflow calls this
// script and nothing else; a path that matches no rule fails safe to the full
// suite + App, so a renamed directory can never sneak past the heavy gates.
//
// The table is the spec. `docs/version-management.md` §8.1 in genethub-cloud
// defines the two release types; the mapping below is derived from the
// dependency closures:
//
//   App closure (ships in the installer):
//     apps/host (loads the Component), apps/cli (launcher), apps/desktop
//     (shell + installer), wit/ (ABI hash), scripts/ (stamping/install/
//     release tooling), Cargo.toml/Cargo.lock (native dependency graph),
//     packages/native (linked into the Host binary).
//
//   Component closure (Live-updatable):
//     apps/guest, apps/guest-probe, apps/daemon + apps/agent (compiled into
//     the Component; the CLI only uses their stable control-plane helpers),
//     packages/proto (WebProtocol, absorbed by the adapter window),
//     packages/http, packages/wasi-guest.
//
//   Hosted (Live-deployable): apps/relay, packages/workbench (the Workbench).
//
//   testing/ gates the above but ships nothing itself.
//
//   node scripts/ci-classify.mjs --all            every job, release_type=app
//   node scripts/ci-classify.mjs --stdin          read changed paths, one per line
//   node scripts/ci-classify.mjs --files a b c    classify explicit paths
//
// Output is `key=value` lines for $GITHUB_OUTPUT plus a human summary on
// stderr. Tested by scripts/ci-classify.test.mjs, which the workflow runs
// before trusting any output — a broken classifier never produces one.

const ALL_JOBS = ["rust", "relay", "web", "desktop"];

// Order is irrelevant: every file matches exactly one rule or falls through to
// the fail-safe. `jobs` lists the heavy jobs the path must trigger; `release`
// is the weakest release type the path can ship through.
const RULES = [
  { match: (f) => f.startsWith(".github/"), jobs: ALL_JOBS, release: "app", force: true, why: "CI/release definition" },
  { match: (f) => f === "Cargo.toml" || f === "Cargo.lock", jobs: ["rust", "desktop"], release: "app", why: "native dependency graph" },
  { match: (f) => f.startsWith("wit/"), jobs: ["rust", "desktop"], release: "app", why: "ABI hash boundary" },
  { match: (f) => f.startsWith("apps/host/"), jobs: ["rust", "desktop"], release: "app", why: "Host runtime ships in the installer" },
  { match: (f) => f.startsWith("apps/cli/"), jobs: ["rust", "desktop"], release: "app", why: "CLI/launcher ships in the installer" },
  { match: (f) => f.startsWith("apps/desktop/"), jobs: ["desktop"], release: "app", why: "Desktop shell and installer" },
  { match: (f) => f.startsWith("apps/daemon/"), jobs: ["rust", "desktop"], release: "live", why: "compiled into the Component; desktop shares its persistence" },
  { match: (f) => f.startsWith("apps/agent/"), jobs: ["rust"], release: "live", why: "compiled into the Component" },
  { match: (f) => f.startsWith("apps/guest/") || f.startsWith("apps/guest-probe/"), jobs: ["rust"], release: "live", why: "the Client Component itself" },
  { match: (f) => f.startsWith("apps/relay/"), jobs: ["relay"], release: "live", why: "hosted service, deployed not installed" },
  { match: (f) => f.startsWith("packages/proto/"), jobs: ["rust"], release: "live", why: "WebProtocol, absorbed by the adapter window" },
  { match: (f) => f.startsWith("packages/http/") || f.startsWith("packages/wasi-guest/"), jobs: ["rust"], release: "live", why: "Component closure support crate" },
  { match: (f) => f.startsWith("packages/native/"), jobs: ["rust", "desktop"], release: "app", why: "linked into the Host binary" },
  { match: (f) => f.startsWith("packages/workbench/"), jobs: ["web"], release: "live", why: "the Workbench" },
  { match: (f) => f.startsWith("testing/"), jobs: ["rust"], release: "live", why: "test engineering ships nothing" },
  { match: (f) => f.startsWith("scripts/"), jobs: ["rust", "desktop"], release: "app", why: "stamping, installer and release tooling" },
  { match: (f) => f.startsWith("docs/") || f.endsWith(".md") || f.startsWith("LICENSE"), jobs: [], release: "live", why: "documentation" },
];

export function classifyFiles(files) {
  const jobs = { rust: false, relay: false, web: false, desktop: false };
  const unmatched = [];
  let force = false;
  let releaseType = "live";
  const reasons = [];

  for (const file of files) {
    const rule = RULES.find((r) => r.match(file));
    if (!rule) {
      unmatched.push(file);
      force = true;
      continue;
    }
    if (rule.force) force = true;
    if (rule.release === "app") releaseType = "app";
    for (const job of rule.jobs) jobs[job] = true;
    reasons.push(`${file}: ${rule.why}`);
  }

  if (force) {
    for (const job of ALL_JOBS) jobs[job] = true;
    releaseType = "app";
  }

  // The web job's mandatory journeys drive a real daemon, agent and relay; a
  // change on either side of that wire must re-prove them.
  if (jobs.rust || jobs.relay) jobs.web = true;

  return { ...jobs, releaseType, force, unmatched, reasons };
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

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: ci-classify.mjs --all | --stdin | --files <path...>");
    process.exit(2);
  }
  const result = args.all
    ? { rust: true, relay: true, web: true, desktop: true, releaseType: "app", force: true, unmatched: [], reasons: ["--all: full suite"] }
    : classifyFiles(args.files ?? (await readStdin()));

  for (const reason of result.reasons) console.error(`  ${reason}`);
  if (result.unmatched.length) {
    console.error(`  unmatched (fail-safe to full suite): ${result.unmatched.join(", ")}`);
  }
  console.error(
    `filter: rust=${result.rust} relay=${result.relay} web=${result.web} desktop=${result.desktop} release_type=${result.releaseType}`,
  );

  console.log(`rust=${result.rust}`);
  console.log(`relay=${result.relay}`);
  console.log(`web=${result.web}`);
  console.log(`desktop=${result.desktop}`);
  console.log(`release_type=${result.releaseType}`);
}

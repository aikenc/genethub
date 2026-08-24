#!/usr/bin/env node
// The version of the product, written in at build time.
//
// The product's version is the git tag, and nothing in the tree claims to know it:
// the three files below hold 0.0.0, meaning "this build was never released", and
// the release workflow calls this script with the tag just before it builds. So a
// release is a tag and nothing else — no version commit, no file to remember.
//
// It works this way because the other way was tried: three numbers maintained by
// hand sat at 0.1.0 through seventeen tagged releases, and every installed copy
// reported 0.1.0 to its own workbench. A number that a human has to copy into
// three places is a number that will be wrong, and the only cure that holds is
// nobody having to copy it anywhere.
//
// Why a script rather than `version.workspace = true` everywhere: Cargo can
// inherit a version only inside one workspace and cannot read another file at all,
// and the desktop shell sits outside the workspace on purpose (root `Cargo.toml`
// says why). Its manifest has to carry a literal, so something has to write it.
//
//   node scripts/stamp-version.mjs 0.1.18                 write a version
//   node scripts/stamp-version.mjs --from-tag             write the tag being built, if there is one
//   node scripts/stamp-version.mjs --verify <binary>      check a built binary reports what it should

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// What a build nobody released calls itself. Also the value sitting in the
// tree, so `git diff` after a release build shows exactly what CI wrote.
const UNRELEASED = "0.0.0";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const usage = () => {
  console.error(`  node scripts/stamp-version.mjs 0.1.18                 write a version
  node scripts/stamp-version.mjs --from-tag             write the tag being built, if there is one
  node scripts/stamp-version.mjs --verify <binary>      check a built binary reports what it should`);
};

// What a build made from this checkout should report: the tag it is building,
// or the placeholder. One rule in one place, so no workflow has to spell it
// out and no two of them can spell it differently.
function expected() {
  const ref = process.env.GITHUB_REF_NAME ?? "";
  return /^v[0-9]/.test(ref) ? ref.slice(1) : UNRELEASED;
}

// One line replaced at a time, scoped to its section the way the sed ranges
// were: the workspace number lives under `[workspace.package]`, and without
// the scope the first entry under `[workspace.dependencies]` would be
// rewritten instead. A pattern that matches nothing is an error — a quiet
// no-op is a release that ships 0.0.0.
function rewriteVersion(path, sectionStart, pattern, version) {
  // Split on either newline: a Windows runner checks out with CRLF, and a
  // `$`-anchored pattern then misses every version line (`"0.0.0"\r`).
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let inside = false;
  let done = false;
  const out = lines.map((line) => {
    if (!inside && sectionStart.test(line)) inside = true;
    else if (inside && /^\[/.test(line) && !sectionStart.test(line)) inside = false;
    if (inside && !done && pattern.test(line)) {
      done = true;
      return line.replace(pattern, `$1${version}$2`);
    }
    return line;
  });
  if (!done) throw new Error(`${path}: no version line found — the marker drifted from the stamper`);
  writeFileSync(path, out.join("\n"));
}

function write(version) {
  // The workspace number, which the daemon, the agent, the protocol crate and
  // the test harness all inherit.
  rewriteVersion(join(repo, "Cargo.toml"), /^\[workspace\.package\]/, /^(version = ").*(")$/, version);

  // The desktop shell, which is its own workspace and so needs its own literal.
  rewriteVersion(join(repo, "apps/desktop/src-tauri/Cargo.toml"), /^\[package\]/, /^(version = ").*(")$/, version);

  // What the installer shows, and what Windows lists under installed programs.
  // Tauri would fall back to the crate version if this field were deleted, but
  // it is written here instead: one place that writes all three is easier to
  // trust than a fallback that only shows itself in a bundle nobody builds
  // locally.
  const conf = join(repo, "apps/desktop/src-tauri/tauri.conf.json");
  const body = readFileSync(conf, "utf8");
  if (!/^  "version": "[^"]*"/m.test(body)) throw new Error(`${conf}: no version line found`);
  writeFileSync(conf, body.replace(/^  "version": "[^"]*"/m, `  "version": "${version}"`));

  console.log(`stamped ${version} into the workspace, the shell and the bundle config`);
  // Printed because this runs unattended: the log of a release should show
  // the number that went in, not just that something ran.
  for (const file of ["Cargo.toml", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/tauri.conf.json"]) {
    console.log(readFileSync(join(repo, file), "utf8").match(/^[ \t]*"?version"?\s*[:=].*$/m)[0].trim());
  }
}

const arg = process.argv[2] ?? "";
if (arg === "--from-tag") {
  const version = expected();
  if (version === UNRELEASED) {
    // A rehearsal run, or a build off a branch. Nothing is published from
    // those, so an unreleased number is the honest thing to ship in them.
    console.log(`not a tag build (GITHUB_REF_NAME=${process.env.GITHUB_REF_NAME ?? "unset"}), leaving ${UNRELEASED}`);
  } else {
    write(version);
  }
} else if (arg === "--verify") {
  // Proof that the number CI stamped is the number the artifact carries.
  // Cheap, and it covers the one way this can fail silently: a job that
  // builds something shippable without stamping it first ships 0.0.0, and
  // 0.0.0 tells every user they are running an unreleased build that can
  // never see an update.
  const binary = process.argv[3];
  if (!binary) {
    usage();
    process.exit(2);
  }
  const want = expected();
  const got = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  if (got !== want) {
    console.error(`::error::${binary} calls itself ${got}, but this build should be ${want} — a stamping step is missing`);
    process.exit(1);
  }
  console.log(`ok: ${binary} calls itself ${got}`);
} else if (/^[0-9]/.test(arg)) {
  write(arg);
} else {
  usage();
  process.exit(2);
}

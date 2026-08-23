// Table-driven contract for the CI classifier. Every row is a promise about
// what a change set must re-prove and which release type it can ship through.
// The workflow runs these tests before trusting the classifier's output.
//
// Rows that guard real past gaps are marked [regression]:
//   - apps/proto never existed; the protocol crate is packages/proto
//   - wit/, apps/guest, scripts/ matched nothing and ran zero heavy jobs

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFiles } from "./ci-classify.mjs";

const ALL = { rust: true, relay: true, web: true, desktop: true };
const NONE = { rust: false, relay: false, web: false, desktop: false };

const CASES = [
  // --- App closure: anything here forces an App Release ---
  {
    name: "[regression] WIT change is an App Release and runs rust+desktop",
    files: ["wit/genehub-host.wit"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "host runtime change is an App Release",
    files: ["apps/host/src/update.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "CLI change is an App Release",
    files: ["apps/cli/src/control.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "desktop shell change is an App Release without rust",
    files: ["apps/desktop/src-tauri/src/main.rs"],
    want: { ...NONE, desktop: true, releaseType: "app" },
  },
  {
    name: "[regression] channel stamping script is an App Release",
    files: ["scripts/channel.mjs"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "installer script is an App Release",
    files: ["scripts/install.sh"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "workspace Cargo.lock is an App Release",
    files: ["Cargo.lock"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "packages/native links into the Host binary",
    files: ["packages/native/src/fs.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "workflow edits force the full suite",
    files: [".github/workflows/ci.yml"],
    want: { ...ALL, releaseType: "app" },
  },

  // --- Component closure: Live Release, but the heavy jobs still run ---
  {
    name: "[regression] protocol crate change runs rust and stays Live",
    files: ["packages/proto/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, releaseType: "live" },
  },
  {
    name: "[regression] guest component change runs rust and stays Live",
    files: ["apps/guest/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, releaseType: "live" },
  },
  {
    name: "daemon change runs rust+desktop and stays Live",
    files: ["apps/daemon/src/adapter/claude.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "live" },
  },
  {
    name: "agent change runs rust and stays Live",
    files: ["apps/agent/src/main.rs"],
    want: { ...NONE, rust: true, web: true, releaseType: "live" },
  },
  {
    name: "http support crate runs rust and stays Live",
    files: ["packages/http/src/client.rs"],
    want: { ...NONE, rust: true, web: true, releaseType: "live" },
  },

  // --- Hosted: Live Release ---
  {
    name: "workbench-only change runs web only",
    files: ["packages/web/src/session/Timeline.tsx"],
    want: { ...NONE, web: true, releaseType: "live" },
  },
  {
    name: "relay change runs relay and re-proves the web journeys",
    files: ["apps/relay/src/main.ts"],
    want: { ...NONE, relay: true, web: true, releaseType: "live" },
  },

  // --- Benign and fail-safe ---
  {
    name: "documentation-only change runs nothing and stays Live",
    files: ["docs/architecture.md", "README.md"],
    want: { ...NONE, releaseType: "live" },
  },
  {
    name: "test engineering change runs rust",
    files: ["testing/journeys/session.test.ts"],
    want: { ...NONE, rust: true, web: true, releaseType: "live" },
  },
  {
    name: "[regression] an unmatched path fails safe to full suite + App",
    files: ["brand-new-dir/thing.txt"],
    want: { ...ALL, releaseType: "app" },
  },

  // --- Composition rules ---
  {
    name: "one App path escalates a whole Live change set",
    files: ["packages/web/src/App.tsx", "wit/genehub-host.wit"],
    want: { ...NONE, rust: true, web: true, desktop: true, releaseType: "app" },
  },
  {
    name: "workbench + protocol is a Live Release with web+rust",
    files: ["packages/web/src/App.tsx", "packages/proto/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, releaseType: "live" },
  },
];

for (const { name, files, want } of CASES) {
  test(name, () => {
    const got = classifyFiles(files);
    assert.equal(got.rust, want.rust, "rust");
    assert.equal(got.relay, want.relay, "relay");
    assert.equal(got.web, want.web, "web");
    assert.equal(got.desktop, want.desktop, "desktop");
    assert.equal(got.releaseType, want.releaseType, "releaseType");
  });
}

test("every rule family path matches exactly one rule (no fall-through)", () => {
  const representatives = [
    ".github/workflows/ci.yml",
    "Cargo.toml",
    "wit/genehub-host.wit",
    "apps/host/src/main.rs",
    "apps/cli/src/main.rs",
    "apps/desktop/src-tauri/tauri.conf.json",
    "apps/daemon/src/lib.rs",
    "apps/agent/src/lib.rs",
    "apps/guest/src/lib.rs",
    "apps/guest-probe/src/main.rs",
    "apps/relay/package.json",
    "packages/proto/package.json",
    "packages/http/Cargo.toml",
    "packages/wasi-guest/Cargo.toml",
    "packages/native/Cargo.toml",
    "packages/web/package.json",
    "testing/package.json",
    "scripts/version.mjs",
    "docs/testing.md",
  ];
  for (const file of representatives) {
    const got = classifyFiles([file]);
    assert.equal(got.unmatched.length, 0, `${file} must match a rule`);
  }
});

test("empty change set runs nothing and stays Live", () => {
  const got = classifyFiles([]);
  assert.deepEqual(
    { rust: got.rust, relay: got.relay, web: got.web, desktop: got.desktop, releaseType: got.releaseType },
    { ...NONE, releaseType: "live" },
  );
});

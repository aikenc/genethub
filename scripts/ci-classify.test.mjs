// Table-driven contract for the CI classifier. Every row is a promise about
// which heavy jobs a change set must re-prove. The workflow runs these tests
// before trusting the classifier's output.
//
// The classifier is only a test selector. It does NOT decide the release
// type: Live vs App is a runtime fact the publisher derives from the signed
// ABI hash (see `publisher/component.mjs`), so no row here asserts one.
//
// Rows that guard real past gaps are marked [regression]:
//   - apps/proto never existed; the protocol crate is packages/proto
//   - wit/, apps/guest, scripts/ matched nothing and ran zero heavy jobs

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFiles } from "./ci-classify.mjs";

const ALL = {
  rust: true,
  relay: true,
  web: true,
  desktop: true,
  guest: true,
  native_host: true,
  native_cli: true,
  native_daemon: true,
};
const NONE = {
  rust: false,
  relay: false,
  web: false,
  desktop: false,
  guest: false,
  native_host: false,
  native_cli: false,
  native_daemon: false,
};

const CASES = [
  // --- Native closure: ships in the installer, runs the heavy gates ---
  {
    name: "[regression] WIT change runs rust+desktop",
    files: ["wit/genehub-host.wit"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true },
  },
  {
    name: "host runtime change runs rust+desktop",
    files: ["apps/host/src/update.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true },
  },
  {
    name: "CLI change runs rust+desktop",
    files: ["apps/cli/src/control.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_cli: true },
  },
  {
    name: "desktop shell change runs desktop without rust or native rustc",
    files: ["apps/desktop/src-tauri/src/main.rs"],
    want: { ...NONE, desktop: true, guest: true },
  },
  {
    name: "[regression] channel stamping script runs rust+desktop",
    files: ["scripts/channel.mjs"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true, native_cli: true },
  },
  {
    name: "installer script runs rust+desktop",
    files: ["scripts/install.sh"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true, native_cli: true },
  },
  {
    name: "workspace Cargo.lock runs rust+desktop",
    files: ["Cargo.lock"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true, native_cli: true, native_daemon: true },
  },
  {
    name: "packages/native links into the Host binary",
    files: ["packages/native/src/fs.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true },
  },
  {
    name: "workflow edits force the full suite",
    files: [".github/workflows/ci.yml"],
    want: { ...ALL },
  },

  // --- Component closure: compiled into the Client Component ---
  {
    name: "[regression] protocol crate change runs rust",
    files: ["packages/proto/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, guest: true, native_host: true },
  },
  {
    name: "[regression] guest component change runs rust",
    files: ["apps/guest/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, guest: true },
  },
  {
    name: "daemon change runs rust+desktop",
    files: ["apps/daemon/src/adapter/claude.rs"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_cli: true, native_daemon: true },
  },
  {
    name: "agent change runs rust",
    files: ["apps/agent/src/main.rs"],
    want: { ...NONE, rust: true, web: true, guest: true },
  },
  {
    name: "http support crate runs rust",
    files: ["packages/http/src/client.rs"],
    want: { ...NONE, rust: true, web: true, guest: true, native_cli: true },
  },
  {
    name: "wasi-guest crate is component-only",
    files: ["packages/wasi-guest/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, guest: true },
  },

  // --- Hosted: deployed, not installed ---
  {
    name: "workbench-only change runs web only",
    files: ["packages/workbench/src/session/Timeline.tsx"],
    want: { ...NONE, web: true, guest: true },
  },
  {
    name: "relay change runs relay and re-proves the web journeys",
    files: ["apps/relay/src/main.ts"],
    want: { ...NONE, relay: true, web: true, guest: true },
  },

  // --- Benign and fail-safe ---
  {
    name: "documentation-only change runs nothing",
    files: ["docs/architecture.md", "README.md"],
    want: { ...NONE },
  },
  {
    name: "test engineering change runs rust",
    files: ["testing/journeys/session.test.ts"],
    want: { ...NONE, rust: true, web: true, guest: true },
  },
  {
    name: "[regression] an unmatched path fails safe to the full suite",
    files: ["brand-new-dir/thing.txt"],
    want: { ...ALL },
  },

  // --- Composition rules ---
  {
    name: "one native path escalates a whole change set to rust+desktop",
    files: ["packages/workbench/src/App.tsx", "wit/genehub-host.wit"],
    want: { ...NONE, rust: true, web: true, desktop: true, guest: true, native_host: true },
  },
  {
    name: "workbench + protocol runs web+rust",
    files: ["packages/workbench/src/App.tsx", "packages/proto/src/lib.rs"],
    want: { ...NONE, rust: true, web: true, guest: true, native_host: true },
  },
];

for (const { name, files, want } of CASES) {
  test(name, () => {
    const got = classifyFiles(files);
    assert.equal(got.rust, want.rust, "rust");
    assert.equal(got.relay, want.relay, "relay");
    assert.equal(got.web, want.web, "web");
    assert.equal(got.desktop, want.desktop, "desktop");
    assert.equal(got.guest, want.guest, "guest");
    assert.equal(got.native_host, want.native_host, "native_host");
    assert.equal(got.native_cli, want.native_cli, "native_cli");
    assert.equal(got.native_daemon, want.native_daemon, "native_daemon");
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
    "packages/workbench/package.json",
    "testing/package.json",
    "scripts/stamp-version.mjs",
    "docs/testing.md",
  ];
  for (const file of representatives) {
    const got = classifyFiles([file]);
    assert.equal(got.unmatched.length, 0, `${file} must match a rule`);
  }
});

test("empty change set runs nothing", () => {
  const got = classifyFiles([]);
  assert.deepEqual(
    {
      rust: got.rust,
      relay: got.relay,
      web: got.web,
      desktop: got.desktop,
      guest: got.guest,
      native_host: got.native_host,
      native_cli: got.native_cli,
      native_daemon: got.native_daemon,
    },
    { ...NONE },
  );
});

test("the classifier emits no release-type field", () => {
  // Live vs App is decided by the publisher's ABI-hash gate, not here. This
  // pins the boundary so a path-based release guess cannot creep back in.
  const got = classifyFiles(["wit/genehub-host.wit"]);
  assert.equal("releaseType" in got, false);
});

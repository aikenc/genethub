// Table-driven contract for the CI classifier. Every row is a promise about
// which of the three tiers a change set lands in: an App build on Windows and
// macOS, a single Linux build guard, or nothing heavy at all. The workflow runs
// these tests before trusting the classifier's output.
//
// The classifier is only a job selector. It does NOT decide Live vs App
// release: that is a runtime fact the publisher derives from the signed ABI
// hash (see `publisher/component.mjs`), so no row here asserts a release type.
//
// Rows that guard real past gaps are marked [regression]:
//   - apps/proto never existed; the protocol crate is packages/proto
//   - wit/, apps/guest, scripts/ matched nothing and ran zero heavy jobs
//   - a session-protocol edit opened the Windows and macOS matrix, which no
//     edit under packages/proto can ever justify: the digest host bakes in is
//     sha256 of wit/, so the installed App keeps pairing with the new component
//   - the same for the daemon crate, which the CLI used to link for five
//     modules; those modules are `packages/frontdoor` now, and nothing native
//     links the daemon at all

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFiles } from "./ci-classify.mjs";

const ALL = {
  rust: true,
  relay: true,
  web: true,
  desktop: true,
  guest: true,
  app: true,
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
  app: false,
  native_host: false,
  native_cli: false,
  native_daemon: false,
};

const CASES = [
  // --- App closure: ships in the installer, needs cross-platform CI ---
  {
    name: "[regression] WIT change runs rust+desktop",
    files: ["wit/genehub-host.wit"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true },
  },
  {
    name: "host runtime change runs rust+desktop",
    files: ["apps/host/src/update.rs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true },
  },
  {
    name: "CLI change runs rust+desktop",
    files: ["apps/cli/src/control.rs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_cli: true },
  },
  {
    name: "desktop shell change runs desktop without rust",
    files: ["apps/desktop/src-tauri/src/main.rs"],
    want: { ...NONE, desktop: true, guest: true, app: true },
  },
  {
    name: "[regression] channel stamping script runs rust+desktop",
    files: ["scripts/channel.mjs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true, native_cli: true },
  },
  {
    name: "installer script runs rust+desktop",
    files: ["scripts/install.sh"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true, native_cli: true },
  },
  {
    name: "workspace Cargo.lock runs rust+desktop",
    files: ["Cargo.lock"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true, native_cli: true, native_daemon: true },
  },
  {
    name: "packages/native links into the Host binary",
    files: ["packages/native/src/fs.rs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true },
  },
  {
    name: "workflow edits force the full suite",
    files: [".github/workflows/ci.yml"],
    want: { ...ALL },
  },

  // --- Linux guard only: compiled into a native binary, cannot move the ABI ---
  {
    name: "[regression] session protocol change gets a Linux guard, not the App matrix",
    files: ["packages/proto/src/rpc.rs"],
    want: { ...NONE, rust: true, guest: true },
  },
  {
    name: "[regression] daemon change gets a Linux guard, not the App matrix",
    files: ["apps/daemon/src/adapter/claude.rs"],
    want: { ...NONE, rust: true, guest: true },
  },
  {
    name: "http support crate is portable, so one operating system proves it",
    files: ["packages/http/src/client.rs"],
    want: { ...NONE, rust: true, guest: true },
  },

  {
    name: "protocol generation crate is portable: Linux guard only",
    files: ["packages/identity/src/lib.rs"],
    want: { ...NONE, rust: true, guest: true },
  },

  // --- App: platform-specific code that ships inside a native binary ---
  {
    name: "the native front door opens the App matrix: its code is per-OS",
    files: ["packages/frontdoor/src/perms.rs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_cli: true },
  },
  {
    name: "stamping the build identity is an App change, not a Live one",
    files: ["packages/frontdoor/src/channel.rs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_cli: true },
  },

  // --- Nothing heavy: Client Component / Web / tests ---
  {
    name: "[regression] guest component change does not open App CI",
    files: ["apps/guest/src/lib.rs"],
    want: { ...NONE },
  },
  {
    name: "agent change does not open App CI",
    files: ["apps/agent/src/main.rs"],
    want: { ...NONE },
  },
  {
    name: "wasi-guest crate is component-only",
    files: ["packages/wasi-guest/src/lib.rs"],
    want: { ...NONE },
  },
  {
    name: "workbench-only change does not open App CI",
    files: ["packages/workbench/src/session/Timeline.tsx"],
    want: { ...NONE },
  },
  {
    name: "relay change does not open App CI",
    files: ["apps/relay/src/main.ts"],
    want: { ...NONE },
  },
  {
    name: "documentation-only change runs nothing",
    files: ["docs/architecture.md", "README.md"],
    want: { ...NONE },
  },
  {
    name: "test engineering change does not open App CI",
    files: ["testing/journeys/session.test.ts"],
    want: { ...NONE },
  },
  {
    name: "[regression] an unmatched path fails safe to the full suite",
    files: ["brand-new-dir/thing.txt"],
    want: { ...ALL },
  },

  // --- Composition: the highest tier any single path reaches wins ---
  {
    name: "one App path escalates a whole change set to the Win/mac matrix",
    files: ["packages/workbench/src/App.tsx", "wit/genehub-host.wit"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true },
  },
  {
    name: "workbench + session protocol stops at the Linux guard",
    files: ["packages/workbench/src/App.tsx", "packages/proto/src/rpc.rs"],
    want: { ...NONE, rust: true, guest: true },
  },
  {
    name: "session protocol alongside a Host edit is App, because the Host edit is",
    files: ["packages/proto/src/rpc.rs", "apps/host/src/update.rs"],
    want: { ...NONE, rust: true, desktop: true, guest: true, app: true, native_host: true },
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
    assert.equal(got.app, want.app, "app");
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
      app: got.app,
      native_host: got.native_host,
      native_cli: got.native_cli,
      native_daemon: got.native_daemon,
    },
    { ...NONE },
  );
});

test("the classifier emits no release-type field", () => {
  // Live vs App *release* is decided by the publisher's ABI-hash gate, not
  // here. `app` is only "does GitHub need to compile a cross-platform App".
  const got = classifyFiles(["wit/genehub-host.wit"]);
  assert.equal("releaseType" in got, false);
  assert.equal(got.app, true);
});

test("a Linux build guard is never reported as an App build", () => {
  // `app` drives whether the Windows and macOS legs spin up at all, so it must
  // track `desktop` alone. Reading it as `rust || desktop` is what put a
  // session-protocol edit on three operating systems.
  for (const file of ["packages/proto/src/rpc.rs", "packages/http/src/client.rs", "apps/daemon/src/lib.rs"]) {
    const got = classifyFiles([file]);
    assert.equal(got.rust, true, `${file} must still prove it compiles`);
    assert.equal(got.desktop, false, `${file} must not open the Win/mac matrix`);
    assert.equal(got.app, false, `${file} is not an App build`);
  }
});

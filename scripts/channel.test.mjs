// The channel table is the release policy: which update feed a build dials,
// which component manifest it trusts, and which tag shape belongs to which
// line. A drift here ships as a beta that updates from the stable feed, or a
// daemon reading another channel's data directory — so the table and the tag
// mapping are asserted directly, and a full stamp round-trip runs against a
// throwaway copy of the stamped files.

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fromRef, TABLE } from "./channel.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("local is deliberately off every release scale", () => {
  // A source build must never be reached by a release feed: the checkout in
  // front of a developer is newer than anything published, and an update
  // source would let a published component replace it.
  assert.equal(TABLE.manifest_url.local, "");
  assert.deepEqual(TABLE.component_manifest_urls.local, []);
  assert.equal(TABLE.hub_url.local, "");
});

test("every released channel has its own https update feeds", () => {
  for (const channel of ["dev", "beta", "stable"]) {
    assert.ok(TABLE.manifest_url[channel].startsWith("https://"), `${channel} app manifest`);
    assert.ok(TABLE.component_manifest_urls[channel].length > 0, `${channel} component feed`);
    for (const url of TABLE.component_manifest_urls[channel]) {
      assert.ok(url.startsWith("https://"), `${channel} component feed must be https`);
    }
  }
});

test("no two channels share a feed, a hub, or a data directory", () => {
  // Coexistence on one machine is the point of the channels: a beta that
  // dialled the stable feed would be offered a downgrade as an upgrade.
  for (const key of ["manifest_url", "hub_url", "web_app_url", "download_base", "data_dir_name"]) {
    const seen = new Map();
    for (const channel of ["dev", "beta", "stable"]) {
      const value = TABLE[key][channel];
      assert.ok(value, `${key}.${channel} is empty`);
      assert.ok(!seen.has(value), `${key}: ${channel} shares ${value} with ${seen.get(value)}`);
      seen.set(value, channel);
    }
    // Each channel's feeds name the channel, so a copy-paste row is a failed
    // test instead of a misdirected fleet.
    for (const channel of ["dev", "beta"]) {
      assert.ok(TABLE[key][channel].includes(channel), `${key}.${channel} does not name its channel`);
    }
  }
  for (const channel of ["dev", "beta", "stable"]) {
    for (const url of TABLE.component_manifest_urls[channel]) {
      if (channel === "stable") continue;
      assert.ok(url.includes(channel), `${channel} component feed does not name its channel`);
    }
  }
});

test("release tags map to their channel and nothing else does", () => {
  const cases = [
    ["v0.7.0-beta.3", "beta"],
    ["v0.0.0-dev.4", "dev"],
    ["v0.7.0", "stable"],
    ["v10.20.30", "stable"],
    // Anything else is not a release: rehearsal tags, rc lines, malformed
    // numbers, and a beta with a non-numeric counter all stay local.
    ["v0.7.0-rc.1", ""],
    ["v0.7.0-beta", ""],
    ["v0.7.0-beta.x", ""],
    ["0.7.0", ""],
    ["release-2026-08", ""],
    ["", ""],
  ];
  for (const [ref, channel] of cases) {
    process.env.GITHUB_REF_NAME = ref;
    assert.equal(fromRef(), channel, `${ref} mapped to ${fromRef()}`);
  }
  delete process.env.GITHUB_REF_NAME;
});

// The files `stamp` rewrites in place need their marker lines to survive the
// trip; the wholesale-generated modules need none. This list mirrors
// `stamp()` — a new stamped file belongs here too.
const STAMPED_FILES = [
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/installer.nsh",
  "apps/cli/Cargo.toml",
  "apps/agent/Cargo.toml",
  "apps/host/Cargo.toml",
  "scripts/install.sh",
];

// The wholesale-generated modules need their parent directories only;
// `stamp` writes them from nothing.
const GENERATED_FILES = [
  "packages/frontdoor/src/channel.rs",
  "apps/agent/src/channel.rs",
  "apps/host/src/channel.rs",
  "apps/desktop/src-tauri/src/channel.rs",
  "packages/workbench/src/channel.ts",
  "scripts/channel.env",
];

function stampSandbox() {
  const root = mkdtempSync(join(tmpdir(), "genehub-channel-stamp-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(repo, "scripts/channel.mjs"), join(root, "scripts/channel.mjs"));
  for (const relative of STAMPED_FILES) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    cpSync(join(repo, relative), join(root, relative));
  }
  for (const relative of GENERATED_FILES) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
  }
  return root;
}

function stamped(root, channel) {
  execFileSync(process.execPath, [join(root, "scripts/channel.mjs"), channel], {
    encoding: "utf8",
  });
  return readFileSync(join(root, "packages/frontdoor/src/channel.rs"), "utf8");
}

test("a beta stamp writes beta identity everywhere and local restores it", () => {
  const root = stampSandbox();
  try {
    const beta = stamped(root, "beta");
    assert.match(beta, /pub const CHANNEL: &str = "beta";/);
    assert.ok(beta.includes(TABLE.manifest_url.beta), "beta app manifest URL not stamped");
    assert.ok(beta.includes("relay-beta"), "beta component feed not stamped");

    const tauri = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
    assert.equal(tauri.productName, TABLE.data_dir_name.beta);
    assert.equal(tauri.identifier, TABLE.identifier.beta);
    assert.match(readFileSync(join(root, "apps/cli/Cargo.toml"), "utf8"), /name = "genet-beta"/);
    assert.match(readFileSync(join(root, "scripts/install.sh"), "utf8"), /^channel=beta$/m);

    // Stamping is a round trip: local brings the tree back to source state,
    // and a second beta stamp is byte-identical to the first.
    const local = stamped(root, "local");
    assert.match(local, /pub const CHANNEL: &str = "local";/);
    const localHost = readFileSync(join(root, "apps/host/src/channel.rs"), "utf8");
    assert.ok(localHost.includes("pub const COMPONENT_MANIFEST_URLS: &[&str] = &[];"));
    assert.equal(stamped(root, "beta"), beta);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-stamping the same channel touches nothing on disk", () => {
  // Cargo keys freshness on mtime: a byte-identical re-stamp that rewrites
  // the file anyway rebuilds frontdoor/agent and everything downstream.
  // The persistent publish worktree is re-stamped on every Live publish, so
  // a no-op stamp must be a no-op on the filesystem too.
  const root = stampSandbox();
  try {
    stamped(root, "beta");
    const files = [...STAMPED_FILES, ...GENERATED_FILES];
    const before = new Map(
      files.map((relative) => [relative, statSync(join(root, relative)).mtimeMs]),
    );
    // mtime granularity differs across filesystems; make a rewrite visible.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    stamped(root, "beta");
    for (const [relative, mtime] of before) {
      assert.equal(statSync(join(root, relative)).mtimeMs, mtime, `${relative} was rewritten by a no-op stamp`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

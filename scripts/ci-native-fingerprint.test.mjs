import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TREES, allFingerprints, fingerprint, listTree } from "./ci-native-fingerprint.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("host and cli fingerprints are stable", () => {
  const a = allFingerprints(REPO);
  const b = allFingerprints(REPO);
  assert.equal(a.host.length, 64);
  assert.equal(a.cli.length, 64);
  assert.equal(a.host, b.host);
  assert.equal(a.cli, b.cli);
});

test("guest sources are not part of the host fingerprint", () => {
  const host = fingerprint(REPO, TREES.host);
  const withGuest = fingerprint(REPO, [...TREES.host, "apps/guest/"]);
  assert.notEqual(host, withGuest);
});

test("the component's own sources reach neither native fingerprint", () => {
  // The daemon and the session schema are inside `genehub_guest.wasm`, which
  // the shell loads at run time. A cached host or CLI binary built before they
  // changed is still exactly the binary this tree produces, so expiring it
  // would be a rebuild that proves nothing. This is the property the crate
  // split exists to make true; asserting it is how it stays true.
  const files = {
    host: TREES.host.flatMap((spec) => listTree(REPO, spec)),
    cli: TREES.cli.flatMap((spec) => listTree(REPO, spec)),
  };
  for (const [binary, listed] of Object.entries(files)) {
    for (const component of ["apps/daemon/", "packages/proto/", "apps/agent/", "apps/guest/"]) {
      assert.equal(
        listed.some((file) => file.startsWith(component)),
        false,
        `${binary} tree must not list ${component}: it is loaded, not linked`,
      );
    }
  }
});

test("what is linked into each binary does reach its fingerprint", () => {
  // The other half of the promise: a cache hit must mean the sources that
  // produce the binary are unchanged, so everything compiled into it is listed.
  const linked = {
    host: ["apps/host/", "packages/native/", "packages/identity/"],
    cli: ["apps/cli/", "packages/frontdoor/", "packages/native/", "packages/http/"],
  };
  for (const [binary, trees] of Object.entries(linked)) {
    const listed = TREES[binary].flatMap((spec) => listTree(REPO, spec));
    for (const crate of trees) {
      assert.ok(
        listed.some((file) => file.startsWith(crate)),
        `${binary} links ${crate}, so a cached ${binary} must expire with it`,
      );
    }
    // Lockfile too: a dependency bump changes the binary without touching a
    // single first-party source file.
    assert.ok(listed.includes("Cargo.lock"), `${binary} must expire with the lockfile`);
  }
});

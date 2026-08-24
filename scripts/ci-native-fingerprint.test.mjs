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

test("daemon sources are part of the cli fingerprint, not the host", () => {
  const hostFiles = TREES.host.flatMap((spec) => listTree(REPO, spec));
  assert.equal(
    hostFiles.some((file) => file.startsWith("apps/daemon/")),
    false,
    "host tree must not list the daemon crate",
  );
  const cliFiles = TREES.cli.flatMap((spec) => listTree(REPO, spec));
  assert.equal(
    cliFiles.some((file) => file.startsWith("apps/daemon/")),
    true,
    "cli tree must list the daemon crate it links",
  );
  const cli = fingerprint(REPO, TREES.cli);
  const cliWithoutDaemon = fingerprint(
    REPO,
    TREES.cli.filter((spec) => spec !== "apps/daemon/"),
  );
  assert.notEqual(cli, cliWithoutDaemon);
});

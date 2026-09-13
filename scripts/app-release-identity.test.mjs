import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appReleaseIdentity } from "./app-release-identity.mjs";

test("CI identity binds guest and installers and rejects mismatched bundled versions", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "app-identity-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const options = {
    dist,
    version: "0.14.0-beta.1",
    channel: "beta",
    openSha: "a".repeat(40),
  };
  const identity = {
    releaseVersion: options.version,
    channel: "beta",
    signedFileSize: 5,
    appAbiHash: "b".repeat(64),
    webProtocol: 3,
  };
  writeFileSync(join(dist, "genehub_guest.wasm"), "guest");
  writeFileSync(
    join(dist, "component-identity.json"),
    JSON.stringify(identity),
  );
  assert.throws(() => appReleaseIdentity(options), /installation assets/);
  writeFileSync(join(dist, "genet-beta-linux.tar.gz"), "installer");
  const release = appReleaseIdentity(options);
  assert.equal(release.component.releaseVersion, options.version);
  assert.equal(release.installers.length, 1);
  writeFileSync(join(dist, "genet-beta-linux.tar.gz"), "changed");
  assert.notEqual(
    appReleaseIdentity(options).installers[0].sha256,
    release.installers[0].sha256,
  );
  assert.throws(
    () => appReleaseIdentity({ ...options, version: "0.14.1-beta.1" }),
    /App generation/,
  );
  writeFileSync(
    join(dist, "component-identity.json"),
    JSON.stringify({ ...identity, releaseVersion: "0.13.0-beta.6" }),
  );
  assert.throws(() => appReleaseIdentity(options), /bundled component/);
});

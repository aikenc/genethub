import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentity, buildStamp } from "./build-stamp.js";
test("explicit product version wins regardless of failed/ambiguous Git tags", () => {
  const id = buildIdentity(undefined, {
    VITE_GENEHUB_CHANNEL: "beta",
    RELEASE_VERSION: "0.14.0-beta.1",
    GITHUB_REF_NAME: "v0.13.0-beta.6",
  });
  assert.equal(id.releaseVersion, "0.14.0-beta.1");
  assert.match(id.openSha, /^[a-f0-9]{40}$/);
  assert.doesNotMatch(buildStamp(), /beta\.[0-9]/);
});
test("unmarked builds stay unmarked, not inferred from package versions or tags", () => {
  assert.equal(
    buildIdentity(undefined, { GITHUB_REF_NAME: "v0.13.0-beta.6" })
      .releaseVersion,
    null,
  );
  assert.throws(
    () =>
      buildIdentity(undefined, {
        VITE_GENEHUB_CHANNEL: "beta",
        RELEASE_VERSION: "0.14.0",
      }),
    /channel/,
  );
});

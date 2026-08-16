import assert from "node:assert/strict";
import { test } from "node:test";

import { validateBetaPromotion } from "./beta-promotion.mjs";

const openSha = "a".repeat(40);
const componentSha256 = "b".repeat(64);

function fixtures() {
  return {
    officialRelease: "1.4.0",
    openSha,
    app: {
      schema: "genehub.app-manifest.v1",
      channel: "beta",
      release: "1.4.0-beta.7",
      platformAbi: 19,
      bundledLogic: {
        channel: "beta",
        logicRevision: 70,
        platformAbi: 19,
        protocolVersion: 3,
        componentSha256: "f".repeat(64),
        keyId: "beta-2026",
      },
      source: { openSha },
    },
    logic: {
      schema: "genehub.logic-manifest.v1",
      channel: "beta",
      logicRevision: 81,
      platformAbi: 19,
      protocolVersion: 3,
      artifact: { sha256: componentSha256, size: 1234 },
      source: { openSha },
      activation: { enabled: true },
    },
    identity: {
      moduleId: "genehub:daemon/logic",
      channel: "official",
      platformAbi: 19,
      protocolVersion: 3,
      componentSha256,
      componentSize: 1234,
    },
  };
}

test("an Official App may promote the active same-source Beta pair", () => {
  const result = validateBetaPromotion(fixtures());
  assert.equal(result.promotedFromBeta, "1.4.0-beta.7/logic-r81");
});

test("promotion rejects a Platform ABI that Beta users never installed", () => {
  const values = fixtures();
  values.app.platformAbi = 18;
  assert.throws(() => validateBetaPromotion(values), /Platform ABI differ/);
});

test("promotion rejects an untested Wasm component even at the same ABI", () => {
  const values = fixtures();
  values.logic.artifact.sha256 = "c".repeat(64);
  assert.throws(() => validateBetaPromotion(values), /not the current Beta-proven component/);
});

test("promotion rejects a Beta line built from another Open commit", () => {
  const values = fixtures();
  values.logic.source.openSha = "d".repeat(40);
  assert.throws(() => validateBetaPromotion(values), /Beta logic was not built/);
});

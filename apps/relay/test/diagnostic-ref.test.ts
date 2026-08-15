import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { endpointDiagnosticRef } from "../src/shared/diagnostic-ref.js";

describe("Fabric diagnostic references", () => {
  it("matches Control's cross-repository golden value without exposing the handle", () => {
    const handle = "fep_example_123";
    const ref = endpointDiagnosticRef(handle);
    assert.equal(ref, "ep_a7d5b9ac324c");
    assert.doesNotMatch(ref, /example/);
  });
});

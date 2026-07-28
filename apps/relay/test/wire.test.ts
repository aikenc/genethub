import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The digest of the contract, as both sides last agreed on it.
 *
 * The control plane is closed and lives in another repository with a copy of
 * `wire.ts` and a test holding this same number. Neither repository can import
 * the other, so this is what keeps them honest: change the contract and both
 * tests go red until someone updates both, which is exactly the moment to
 * notice that a deploy has to happen in a particular order.
 *
 * Comments are stripped before hashing, so prose can be improved on one side
 * without dragging the other through a release.
 */
const AGREED_DIGEST = "771dea445d6d08cf06be0ee90c7fffef4fc6b125faa03c157a2ff6028bd459e5";

/** Comments and blank lines out; what is left is what travels. */
export function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

describe("the wire contract", () => {
  it("still matches the digest the control plane was built against", () => {
    const source = readFileSync(path.join(HERE, "../src/contract/wire.ts"), "utf8");
    const digest = createHash("sha256").update(normalize(source)).digest("hex");
    assert.equal(
      digest,
      AGREED_DIGEST,
      `the contract changed. Update AGREED_DIGEST here and in the control plane's own wire test to ${digest}, and ship the control plane first.`,
    );
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Kept in lockstep with genethub-cloud's copy and digest test. */
const AGREED_FABRIC_DIGEST = "83651c0a27065a2e9faaec896dc157725da7e6f19e9325eb047c0acb933f27ee";

function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

describe("the Fabric v2 control-plane wire contract", () => {
  it("still matches the independently deployed control plane", () => {
    const source = readFileSync(path.join(HERE, "../src/contract/fabric-wire.ts"), "utf8");
    const digest = createHash("sha256").update(normalize(source)).digest("hex");
    assert.equal(
      digest,
      AGREED_FABRIC_DIGEST,
      `the Fabric contract changed. Update both repositories and deploy the control plane first; new digest: ${digest}`,
    );
  });
});

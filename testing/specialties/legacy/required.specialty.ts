import { readFileSync } from "node:fs";
import { defineSpecialty } from "../../framework/public.ts";

const parity = JSON.parse(readFileSync(new URL("../../migration/rust-parity.json", import.meta.url), "utf8")) as {
  cases: Array<{ oldId: string; suite: string; testName: string; legacyExecution: string; assertionDelta: string }>;
};

// The frozen Rust crate is retired. These rows remain registered only so a
// plan can report each terminal state and its evidence; none of them runs.
for (const row of parity.cases) {
  const executionTag = row.legacyExecution === "suspended" ? "legacy-suspended"
    : row.legacyExecution === "retired" ? "legacy-retired"
    : row.legacyExecution === "release-only" ? "legacy-release-only"
    : "legacy-required";
  defineSpecialty({
    id: row.oldId, title: row.testName, oracle: row.assertionDelta,
    catches: ["legacy behavior lost before independently verified parity"],
    runner: "node", tags: [executionTag, "legacy-suite-" + row.suite, row.oldId], llm: { default: "mock" },
    expectedDurationMs: 1000, timeoutMs: 5000,
    resources: { pool: "standard", cpu: 1, memoryMb: 512, io: 1 }, surfaces: ["legacy-metadata"],
  }, async () => {
    if (row.legacyExecution === "required") {
      throw new Error("required frozen case has no integrated runner; re-integrate it or retire it with evidence");
    }
  });
}

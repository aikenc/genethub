import { readFileSync } from "node:fs";
import { defineSpecialty } from "../../framework/public.ts";

const parity = JSON.parse(readFileSync(new URL("../../migration/rust-parity.json", import.meta.url), "utf8")) as {
  cases: Array<{ oldId: string; suite: string; testName: string; legacyExecution: string; assertionDelta: string }>;
};
for (const row of parity.cases) {
  defineSpecialty({
    id: row.oldId, title: row.testName, oracle: row.assertionDelta,
    catches: ["legacy behavior lost before independently verified parity"],
    runner: "rust-legacy", tags: ["legacy-required", "legacy-suite-" + row.suite, row.oldId], llm: { default: row.suite === "claude" || row.testName === "a_real_provider_that_rejects_our_key_says_so_instead_of_hanging" ? "real" : "mock" },
    expectedDurationMs: 30000, timeoutMs: 180000,
    resources: { pool: "heavy", cpu: 4, memoryMb: 2048, io: 2 }, surfaces: ["frozen-legacy"],
  }, async () => { throw new Error("frozen cases require the rust-legacy process adapter"); });
}

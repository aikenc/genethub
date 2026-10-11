import { existsSync, readFileSync } from "node:fs";
import { defineSpecialty } from "../../framework/public.ts";

const parity = JSON.parse(readFileSync(new URL("../../migration/rust-parity.json", import.meta.url), "utf8")) as {
  cases: Array<{ oldId: string; suite: string; testName: string; legacyExecution: string; assertionDelta: string }>;
};

/** A frozen case that begins with `real_only!` is skipped (blocked) unless the harness runs it against the real model. */
function needsRealModel(row: { suite: string; testName: string }): boolean {
  if (row.testName === "a_real_provider_that_rejects_our_key_says_so_instead_of_hanging") return true;
  const file = new URL(`../../deprecated/rust/tests/${row.suite}.rs`, import.meta.url);
  if (!existsSync(file)) return false;
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`fn ${row.testName}(`);
  if (start < 0) return false;
  const next = source.slice(start).search(/\n#\[(tokio::)?test/);
  return source.slice(start, next < 0 ? undefined : start + next).includes("real_only!(");
}

for (const row of parity.cases) {
  const real = needsRealModel(row);
  defineSpecialty({
    id: row.oldId, title: row.testName, oracle: row.assertionDelta,
    catches: ["legacy behavior lost before independently verified parity"],
    runner: "rust-legacy", tags: [row.legacyExecution === "suspended" ? "legacy-suspended" : "legacy-required", "legacy-suite-" + row.suite, row.oldId], llm: { default: real ? "real" : "mock" },
    expectedDurationMs: 30000, timeoutMs: 180000,
    resources: { pool: real ? "real-llm" : "heavy", cpu: 4, memoryMb: 2048, io: 2 }, surfaces: ["frozen-legacy"],
  }, async () => { throw new Error("frozen cases require the rust-legacy process adapter"); });
}

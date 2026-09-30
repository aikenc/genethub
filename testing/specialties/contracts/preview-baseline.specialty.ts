import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.preview-baseline",
  title: "Preview and rendered Markdown owning-package regressions",
  oracle: "The existing Preview and Markdown regression tests execute with no failures, pending tests or unhandled errors",
  catches: ["sandbox isolation regression", "storage namespace leak", "runtime artifact loss", "popout identity regression", "Markdown selection or annotation mark regression"],
  tags: ["contract", "preview-annotation"], llm: { default: "none" }, requiredArtifacts: [],
  expectedDurationMs: 15_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536 },
  surfaces: ["workbench-owning-package", "vitest"],
}, async t => {
  const cwd = join(t.openRoot, "packages/workbench");
  const report = join(t.env.root, "preview-vitest.json");
  try {
    await promisify(execFile)(process.execPath, [join(cwd, "node_modules/vitest/vitest.mjs"), "run", "src/preview", "src/session/Markdown.test.tsx", "--maxWorkers", "2", "--reporter=json", "--outputFile", report], { cwd, env: process.env, timeout: 80_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const cause = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${cause.stdout ?? ""}\n${cause.stderr ?? cause.message}`);
  }
  const result = JSON.parse(readFileSync(report, "utf8"));
  t.assertions.assert(result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0, "Preview tests did not complete a passing nonempty run");
  if (result.numPendingTests > 0) throw new BlockedError(`Preview baseline left ${result.numPendingTests} tests pending`);
  t.note(`Preview/Markdown tests=${result.numPassedTests}; scoped owning-package regressions, not the full workbench suite`);
});

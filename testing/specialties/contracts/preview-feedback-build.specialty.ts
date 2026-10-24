import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

// Each compiler/test suite is its own schedulable unit. The previous combined
// unit allowed 3 x 90s of child work inside a single 120s wall-clock deadline.
for (const consumer of ["testing", "console-types", "console-tests"] as const) {
  defineSpecialty({
    id: `specialty.contracts.preview-feedback-build.${consumer}`,
    title: `Preview feedback ${consumer} consumer retains its contracts`,
    oracle: consumer === "console-tests" ? "Existing Console regression suite executes nonzero tests with no failures or pending cases" : "The entire consumer typechecks without emitting files",
    catches: ["public fixture declaration drifts", "Cloud share entry fails TypeScript", "console auth routing regresses"],
    tags: ["contract", "preview-feedback"], requiredRepos: ["cloud"], requiredArtifacts: [], llm: { default: "none" },
    expectedDurationMs: consumer === "console-tests" ? 30_000 : 15_000, timeoutMs: 120_000,
    resources: { environments: 1, cpu: 2, memoryMb: 1536 },
    surfaces: ["cloud-console", "testing-framework"],
  }, async t => {
    const cloud = process.env.TESTCTL_CLOUD_ROOT;
    if (!cloud) throw new BlockedError("Cloud worktree is required");
    const cwd = consumer === "testing" ? join(t.openRoot, "testing") : join(cloud, "console");
    const report = join(t.env.root, "console-vitest.json");
    const args = consumer === "console-tests"
      ? [join(cwd, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers", "2", "--reporter=json", "--outputFile", report]
      : [join(cwd, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"];
    try {
      await promisify(execFile)(process.execPath, args, { cwd, env: process.env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${consumer}: ${e.stdout ?? ""}\n${e.stderr ?? e.message}`);
    }
    if (consumer === "console-tests") {
      const result = JSON.parse(await readFile(report, "utf8"));
      t.assertions.assert(result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0, "Console regressions did not pass");
      if (result.numPendingTests > 0) throw new BlockedError("Console regressions left required pending tests");
      t.note(`Console tests=${result.numPassedTests}`);
    } else {
      t.note(`${consumer} type contracts passed`);
    }
  });
}

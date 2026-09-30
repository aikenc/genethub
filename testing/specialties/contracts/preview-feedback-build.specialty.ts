import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.preview-feedback-build",
  title: "Preview feedback consumers and test declarations retain type contracts",
  oracle: "The complete testing package and Cloud console typecheck; existing Console regression suite passes without pending cases",
  catches: ["public fixture declaration drifts", "Cloud share entry fails TypeScript", "console auth routing regresses"],
  tags: ["contract", "preview-feedback"], requiredRepos: ["cloud"], requiredArtifacts: [], llm: { default: "none" },
  expectedDurationMs: 20_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536 },
  surfaces: ["cloud-console", "testing-framework"],
}, async t => {
  const cloud = process.env.TESTCTL_CLOUD_ROOT;
  if (!cloud) throw new BlockedError("Cloud worktree is required");
  const execute = async (cwd: string, args: string[]) => {
    try { await promisify(execFile)(process.execPath, args, { cwd, env: process.env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { const e = error as Error & { stdout?: string; stderr?: string }; throw new Error(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`); }
  };
  const testing = join(t.openRoot, "testing");
  await execute(testing, [join(testing, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"]);
  const console = join(cloud, "console");
  await execute(console, [join(console, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"]);
  const report = join(t.env.root, "console-vitest.json");
  await execute(console, [join(console, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers", "2", "--reporter=json", "--outputFile", report]);
  const result = JSON.parse(await readFile(report, "utf8"));
  t.assertions.assert(result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0, "Console regressions did not pass");
  if (result.numPendingTests > 0) throw new BlockedError("Console regressions left required pending tests");
  t.note(`Testing and Console type contracts passed; Console tests=${result.numPassedTests}`);
});

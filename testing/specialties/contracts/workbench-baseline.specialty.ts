import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.workbench-baseline",
  title: "Workbench owning-package regression baseline",
  oracle: "The existing Workbench Vitest suite executes nonzero tests with zero failures or unhandled errors",
  catches: ["crypto/cancellation invariant regression", "workbench package regression outside business journeys"],
  tags: ["contract", "network-risk-v2", "workbench-baseline"], llm: { default: "mock" },
  expectedDurationMs: 120000, timeoutMs: 240000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["workbench-owning-package", "vitest"],
}, async t => {
  const cwd = join(t.openRoot, "packages/workbench"), report = join(t.env.root, "vitest.json");
  try {
    await promisify(execFile)(process.execPath, [join(cwd, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers", "2", "--reporter=default", "--reporter=json", "--outputFile", report], {
      cwd, env: process.env, timeout: 220000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(readFileSync(report, "utf8"));
    t.assertions.assert(result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0,
      "Workbench package did not complete a passing nonempty baseline");
    if (result.numPendingTests > 0) throw new BlockedError(`Workbench baseline left ${result.numPendingTests} required tests pending`);
    t.note(`workbenchTests=${result.numPassedTests} pending=${result.numPendingTests}`);
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    const result = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined;
    const failures = result?.testResults?.flatMap((file: any) => file.assertionResults.filter((test: any) => test.status === "failed").map((test: any) => ({ name: test.fullName, errors: test.failureMessages.map((message: string) => message.slice(0, 600)) }))) ?? [];
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`Workbench baseline failed: ${JSON.stringify({ passed: result?.numPassedTests, failed: result?.numFailedTests, pending: result?.numPendingTests, success: result?.success, suiteErrors: result?.testResults?.filter((file: any) => file.message).map((file: any) => ({name: file.name, message: file.message})), failures }).slice(0, 24000)}\n${(e.stdout ?? "").slice(-12000)}\n${(e.stderr ?? e.message).slice(-12000)}`);
  }
});

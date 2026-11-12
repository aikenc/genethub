import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.workbench-session-project-lists",
  title: "Workbench session and project navigation keeps row actions, ordering and preferences consistent",
  oracle: "The owning package runs its six existing component and behavior suites for project/member navigation, session page menus, default conversation filtering, stable ordering and independent pinned preferences. Every selected suite executes and no test fails or remains pending.",
  catches: ["project expansion opens conversations instead of members", "row actions replace page actions", "member activity reorders projects", "session and project preferences leak into each other"],
  tags: ["contract", "workbench-session-project-lists"], llm: { default: "none" }, requiredArtifacts: [],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, browser: 0 },
  expectedDurationMs: 15000, timeoutMs: 60000, surfaces: ["workbench-owning-package", "vitest"],
}, async t => {
  const cwd = join(t.openRoot, "packages/workbench"), report = join(t.env.root, "session-project-lists-vitest.json");
  const files = ["src/app/MachineDirectoryLists.test.tsx", "src/session/SessionHeading.test.tsx",
    "src/session/conversationFilters.test.ts", "src/session/project-view.test.ts",
    "src/session/session-order.test.ts", "src/session/session-preferences.test.ts"];
  try {
    await promisify(execFile)(process.execPath, [join(cwd, "node_modules/vitest/vitest.mjs"), "run", ...files,
      "--maxWorkers", "2", "--reporter=default", "--reporter=json", "--outputFile", report], {
      cwd, timeout: 55000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env },
    });
    const result = JSON.parse(readFileSync(report, "utf8"));
    t.assertions.assert(result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0 && result.numPendingTests === 0,
      "selected Workbench suites failed, were empty, or left pending tests");
    t.assertions.assert(files.every(file => result.testResults.some((suite: any) =>
      suite.name.endsWith(file) && suite.assertionResults.length > 0 && suite.assertionResults.every((test: any) => test.status === "passed"))),
      "a selected owning-package suite did not execute all its assertions");
    t.note(`owningPackageSuites=${files.length} tests=${result.numPassedTests}; component/behavior evidence only, real directory push is a separate native canary`);
  } catch (error) {
    const result = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined;
    const cause = error as Error & { stdout?: string; stderr?: string };
    const failures = result?.testResults?.flatMap((suite: any) => suite.assertionResults.filter((test: any) => test.status === "failed")
      .map((test: any) => ({ name: test.fullName, errors: test.failureMessages.map((message: string) => message.slice(0, 400)) }))) ?? [];
    throw new Error(JSON.stringify({ passed: result?.numPassedTests, failed: result?.numFailedTests,
      pending: result?.numPendingTests, failures }).slice(0, 8000) + "\n" + (cause.stderr ?? cause.stdout ?? cause.message).slice(-4000));
  }
});

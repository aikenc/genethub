import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

const FILES = [
  "src/session/capability-preferences.test.ts",
  "src/session/ComposerControls.test.tsx",
  "src/session/Composer.commands.test.tsx",
  "src/session/Composer.speech.test.tsx",
  "src/session/ForwardDialog.test.tsx",
  "src/session/ForkDialog.test.tsx",
  "src/session/store.test.ts",
  "src/session/workbench.test.tsx",
  "src/shell/targets.test.tsx",
] as const;

defineSpecialty({
  id: "specialty.contracts.capability-preferences-workbench",
  title: "Workbench tag routing, live cost and compact runtime preferences",
  oracle:
    "All UI and store boundaries affected by AND-tag routing pass without pending tests",
  catches: [
    "a surface still exposes the removed capability-first interaction",
    "same-Agent model rows collapse instead of retaining independent tags and costs",
    "machine-global tag, cost or runtime preferences are lost",
    "Fork or Forward bypasses the target machine's AND-tag route",
  ],
  tags: ["contract", "workbench", "tag-routing"],
  llm: { default: "none" },
  expectedDurationMs: 90_000,
  timeoutMs: 220_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["workbench-ui", "workbench-store"],
  productInterfaces: ["@genehub/workbench", "settings.agentPreferences"],
}, async t => {
  const cwd = join(t.openRoot, "packages/workbench");
  const report = join(t.env.root, "vitest.json");
  try {
    await promisify(execFile)(
      process.execPath,
      [
        join(cwd, "node_modules/vitest/vitest.mjs"),
        "run",
        ...FILES,
        "--maxWorkers",
        "2",
        "--reporter=default",
        "--reporter=json",
        "--outputFile",
        report,
      ],
      {
        cwd,
        env: process.env,
        timeout: 200_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const result = JSON.parse(readFileSync(report, "utf8"));
    t.assertions.assert(
      result.success === true &&
        result.numPassedTests > 0 &&
        result.numFailedTests === 0 &&
        result.numPendingTests === 0,
      `Tag routing Workbench suite was not clean: ${JSON.stringify({
        passed: result.numPassedTests,
        failed: result.numFailedTests,
        pending: result.numPendingTests,
      })}`,
    );
    t.note(`tagRoutingWorkbenchTests=${result.numPassedTests}`);
  } catch (error) {
    const result = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined;
    const failures =
      result?.testResults?.flatMap((file: any) =>
        file.assertionResults
          .filter((test: any) => test.status === "failed")
          .map((test: any) => ({
            name: test.fullName,
            errors: test.failureMessages.map((message: string) => message.slice(0, 1000)),
          })),
      ) ?? [];
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Tag routing Workbench regressions failed: ${JSON.stringify({
        passed: result?.numPassedTests,
        failed: result?.numFailedTests,
        pending: result?.numPendingTests,
        failures,
      }).slice(0, 18000)}\n${(failure.stdout ?? "").slice(-8000)}\n${(failure.stderr ?? failure.message).slice(-5000)}`,
    );
  }
});

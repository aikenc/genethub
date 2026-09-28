import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.project-approval-recovery",
  title: "Durable project approval has no answer deadline and retains current fact checks",
  oracle: "The current plan contains no answer deadline, remains approvable after restart, and rejection, fact drift or a different action cannot obtain mutation authority",
  catches: ["elapsed waiting invalidates an unchanged plan", "changed project facts gain mutation authority", "replayed approval repeats a mutation"],
  tags: ["contract", "core", "durable-approval", "approval-recovery"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon-project-control", "session-human-continuation"],
  productInterfaces: ["session.respondPermission", "project-control-plan"],
}, async (t) => {
  const run = promisify(execFile);
  for (const filter of [
    "project_control::tests::an_unanswered_plan_retains_its_authority_after_restart",
    "project_control::tests::rejection_and_fact_drift_never_create_a_spendable_grant",
    "project_control::tests::approval_is_single_session_single_plan_and_single_action",
    "workflow::recovery::tests::human_exit_classifier_covers_budget_route_failure_and_acceptance",
  ]) {
    const { stdout } = await run("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", filter, "--", "--exact", "--nocapture",
    ], {
      cwd: t.openRoot,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      timeout: 170_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const passed = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(Boolean(passed), `approval recovery property did not run successfully: ${filter}\n${stdout.slice(-3000)}`);
    t.note(`${filter} passed=${passed![1]}`);
  }
  const workbench = join(t.openRoot, "packages/workbench");
  const { stdout } = await run(process.execPath, [
    join(workbench, "node_modules/vitest/vitest.mjs"), "run", "src/session/timeline.test.ts",
  ], {
    cwd: workbench,
    env: process.env,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  t.assertions.assert(/Tests\s+[1-9]\d* passed/.test(stdout), `timeline approval status did not pass: ${stdout.slice(-3000)}`);
  t.note(stdout.split("\n").filter((line) => /Tests\s|Test Files/.test(line)).join("\n"));
});

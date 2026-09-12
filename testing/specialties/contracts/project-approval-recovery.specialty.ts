import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.project-approval-recovery",
  title: "Expired project approval cards recover without granting stale authority",
  oracle: "The daemon retires an expired challenge, never spends it, and resumes the PM only to prepare a fresh Human-confirmed plan",
  catches: ["expired confirmation card retries forever", "expired plan gains mutation authority", "PM reuses an expired action id"],
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
    "project_control::tests::an_expired_challenge_is_retired_without_becoming_approved",
    "session::manager::tests::an_expired_plan_approval_resumes_only_to_request_a_fresh_plan",
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

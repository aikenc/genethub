import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.project-approval-recovery",
  title: "Expired Human plan cards request a fresh plan without applying the expired one",
  oracle: "A Human plan timeout resumes only to request a fresh plan; the session timeline retains the correct expired-card state",
  catches: ["expired card retries forever", "expired plan is applied", "timeline hides the expired interaction"],
  tags: ["contract", "core", "durable-approval", "approval-recovery"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["session-human-continuation", "workbench"],
  productInterfaces: ["session.respondPermission", "planApproval"],
}, async (t) => {
  const run = promisify(execFile);
  for (const filter of [
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

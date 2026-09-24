import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.request-writer-lock",
  title: "Workflow request ownership and local recovery",
  oracle: "the OS file lock excludes a second channel; request state survives stale Run snapshots; patrol isolates corrupt requests and reads through a damaged locator without modifying it",
  catches: ["two channels concurrently mutate one request", "a released request remains pinned", "one damaged locator or request blocks unrelated patrol"],
  tags: ["contract", "workflow", "storage", "native-intrinsic"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem"],
  productInterfaces: ["Workflow request writer file lock", "Workflow PM request record"],
}, async t => {
  for (const test of [
    "workflow::tests::request_writer_is_exclusive_across_channel_data_roots",
    "workflow::tests::request_record_owns_budget_across_run_snapshot_reads",
    "workflow::tests::recovery_completion_keeps_request_writer_until_business_success",
    "workflow::tests::human_acceptance_settles_business_and_recovery_once",
    "workflow::tests::patrol_reads_each_request_without_project_locator_dependency",
  ]) {
    const { stdout } = await promisify(execFile)("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
      "--", "--exact", "--nocapture",
    ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
      `${test} did not pass: ${stdout.slice(-2000)}`);
  }
});

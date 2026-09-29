import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";
const runNative = async (file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => {
  try { return await promisify(execFile)(file, args, { ...options, encoding: "utf8" }); }
  catch (error) {
    const failure = error as Error & { code?: string | number; signal?: string; killed?: boolean; stderr?: string; stdout?: string };
    throw new Error(`native execution failed: code=${failure.code} signal=${failure.signal} killed=${failure.killed}; ${failure.stderr?.slice(-12000) ?? failure.message}; ${failure.stdout?.slice(-2000) ?? ""}`);
  }
};


defineSpecialty({
  id: "specialty.workflow.request-writer-lock",
  title: "Workflow request ownership and local recovery",
  oracle: "the OS file lock excludes a second channel; request state survives stale Run snapshots; patrol isolates corrupt requests and reads through a damaged locator without modifying it",
  catches: ["two channels concurrently mutate one request", "a released request remains pinned", "one damaged locator or request blocks unrelated patrol"],
  tags: ["contract", "workflow", "storage", "native-intrinsic"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 720_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem"],
  productInterfaces: ["Workflow request writer file lock", "Workflow PM request record"],
}, async t => {
  for (const test of [
    "workflow::tests::request_writer_is_exclusive_across_channel_data_roots",
    "workflow::tests::request_record_owns_budget_across_run_snapshot_reads",
    "workflow::tests::recovery_completion_keeps_request_writer_until_business_success",
    "workflow::tests::human_acceptance_preserves_business_and_recovery_results",
    "workflow::tests::patrol_reads_each_request_without_project_locator_dependency",
    "workflow::tests::request_quiescence_uses_retirement_not_business_success",
    "workflow::tests::settled_request_skips_patrol_but_remains_in_history",
  ]) {
    const { stdout } = await runNative("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
      "--", "--exact", "--nocapture",
    ], { cwd: t.openRoot, timeout: 660_000, maxBuffer: 4 * 1024 * 1024 });
    t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
      `${test} did not pass: ${stdout.slice(-2000)}`);
  }
});

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
  id: "specialty.workflow.recovery-manifest",
  title: "Workflow recovery selection is validated and pinned",
  oracle: "frontmatter selects a validated recovery flow as an ordinary structured report without granting PM control authority; Candidate identity changes with the selector, and recovery summaries remain bounded and retain custom repair evidence",
  catches: ["recovery selector escapes the package", "custom recovery is absent from Candidate identity", "missing recovery flow activates", "invalid built-in recovery graph", "recovery archive grows without bound or duplicates a replay", "custom recovery evidence disappears when its node is not named repair"],
  tags: ["contract", "workflow", "recovery", "native-intrinsic"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem"],
  productInterfaces: ["workflow.md frontmatter", "Workflow Candidate snapshot"],
}, async t => {
  for (const test of [
    "workflow::package::tests::frontmatter_accepts_only_description_dev_and_recovery",
    "workflow::tests::recovery_selector_is_pinned_and_requires_a_package_flow",
    "workflow::tests::recovery_reset_uses_activation_override_without_editing_source",
    "workflow::tests::recovery_activation_question_binds_candidate_and_revision",
    "workflow::tests::recovery_flow_limits_are_checked_before_candidate_activation",
    "workflow::tests::custom_recovery_is_an_ordinary_structured_report",
    "workflow::tests::recovery_runs_share_request_execution_allowance",
    "workflow::tests::builtin_recovery_flow_is_valid_and_budgeted",
    "workflow::recovery::tests::archive_rotates_at_one_mib_and_replay_does_not_duplicate",
    "workflow::recovery::tests::invalid_archived_line_is_ignored_as_untrusted_data",
    "workflow::recovery::tests::custom_node_name_keeps_submitted_repair_evidence",
    "workflow::recovery::tests::human_exit_classifier_covers_budget_route_failure_and_acceptance",
    "session::manager::tests::workflow_human_question_is_durable_and_idempotent",
  ]) {
    const { stdout } = await runNative("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
      "--", "--exact", "--nocapture",
    ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
      `${test} did not pass: ${stdout.slice(-2000)}`);
  }
});

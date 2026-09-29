import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-manifest",
  title: "Workflow recovery and retained storage regressions preserve validated bindings",
  oracle: "Retained native fault pins prove recovery selection, bounded activation history, project-owned snapshots, canonical package/carrier paths and isolated carrier occupancy; independent public specialties prove source-loss restart and dispatch",
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
    "workflow::package::tests::a_collection_root_is_the_nearest_ancestor_without_a_manifest",
    "workflow::package::tests::logical_references_resolve_to_space_relative_paths",
    "workflow::build::tests::an_authorized_build_registers_the_package_team",
    "workspace::tests::one_plan_registers_the_project_root_and_its_package_team",
    "workflow::tests::recovery_selector_is_pinned_and_requires_a_package_flow",
    "workflow::tests::recovery_reset_uses_activation_override_without_editing_source",
    "workflow::tests::missing_candidate_source_does_not_disable_the_active_snapshot",
    "workflow::tests::broken_candidate_source_does_not_disable_the_active_snapshot",
    "workflow::tests::a_role_may_declare_fields_only_its_workflow_reads",
    "workflow::tests::oversized_activation_history_is_rejected_before_use",
    "workflow::tests::a_full_activation_history_rotates_instead_of_locking_the_project",
    "workflow::tests::a_carrier_is_only_reported_busy_while_its_run_is_still_running",
    "workflow::tests::project_local_runtime_never_enters_the_trusted_control_plane",
    "workflow::tests::trusted_runtime_survives_project_local_runtime_replacement",
    "workflow::tests::recovery_activation_question_binds_candidate_and_revision",
    "workflow::tests::recovery_flow_limits_are_checked_before_candidate_activation",
    "workflow::tests::custom_recovery_requires_a_human_and_only_controlled_exits",
    "workflow::tests::recovery_runs_do_not_spend_business_run_allowance",
    "workflow::tests::builtin_recovery_flow_is_valid_and_budgeted",
    "workflow::recovery::tests::archive_rotates_at_one_mib_and_replay_does_not_duplicate",
    "workflow::recovery::tests::invalid_archived_line_is_ignored_as_untrusted_data",
    "workflow::recovery::tests::custom_node_name_keeps_submitted_repair_evidence",
    "workflow::recovery::tests::human_exit_classifier_covers_budget_route_failure_and_acceptance",
    "session::manager::tests::workflow_human_question_is_durable_and_idempotent",
  ]) {
    const { stdout } = await promisify(execFile)("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
      "--", "--exact", "--nocapture",
    ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
      `${test} did not pass: ${stdout.slice(-2000)}`);
  }
});

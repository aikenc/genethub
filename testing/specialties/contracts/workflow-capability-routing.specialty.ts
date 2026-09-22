import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

const TESTS = [
  "state::machine_state_tests::tag_settings_enforce_profile_identity_and_tag_bounds",
  "agent_routing::tests::portable_history_adds_image_and_video_requirements",
  "agent_routing::tests::routed_request_tags_are_bounded_and_media_vocabulary_is_closed",
  "dataplane::endpoint::tests::routed_session_operations_are_scoped_to_the_destination_workspace",
  "session::manager::tests::migration_history_excludes_inputs_that_still_need_delivery",
  "session::manager::tests::migration_seed_target_distinguishes_an_explicit_default_model",
  "session::manager::tests::routing_metadata_change_keeps_the_same_agent_context",
  "session::manager::tests::cross_agent_migration_keeps_session_and_replays_history_once",
  "workflow::tests::role_v3_declares_only_builtin_tags",
  "workflow::tests::tag_routes_use_live_cost_and_and_matching",
  "workflow::tests::tag_route_failure_is_human_actionable",
] as const;

defineSpecialty({
  id: "specialty.contracts.workflow-capability-routing",
  title: "Workflow roles resolve machine-global tag routes at dispatch",
  oracle:
    "Role v3 accepts only built-in tags; dispatch selects the lowest-cost all-tag match and fails human-actionably when none is usable",
  catches: [
    "workflow package pins a concrete Agent or model",
    "route selection treats tags as OR rather than AND",
    "missing tag route disappears as a generic launch failure",
  ],
  tags: ["contract", "workflow", "tag-routing"],
  llm: { default: "none" },
  expectedDurationMs: 45_000,
  timeoutMs: 300_000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "workflow"],
  productInterfaces: ["workflow role schema", "settings.agentPreferences"],
}, async t => {
  for (const test of TESTS) {
    try {
      const { stdout } = await promisify(execFile)(
        "cargo",
        [
          "test",
          "--profile",
          "iterate",
          "-p",
          "genet-daemon",
          "--lib",
          test,
          "--",
          "--exact",
          "--nocapture",
        ],
        {
          cwd: t.openRoot,
          env: process.env,
          timeout: 280_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      t.assertions.assert(
        stdout.includes("test result: ok. 1 passed; 0 failed"),
      `Workflow tag regression did not execute: ${test}\n${stdout.slice(-3000)}`,
      );
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `Workflow tag regression failed: ${test}\n${(failure.stdout ?? "").slice(-4000)}\n${(failure.stderr ?? failure.message).slice(-3000)}`,
      );
    }
  }
  t.note(`Workflow tag routing regressions passed=${TESTS.length}`);
});

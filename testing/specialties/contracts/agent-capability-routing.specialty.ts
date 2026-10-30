import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

// The removed request_workspace ACL projection has no runtime consumer.
// Real destination placement for create/fork/import is covered through the
// public hosted connection in specialty.authorization.hosted-cross-project.
const TESTS = [
  "state::machine_state_tests::tag_settings_enforce_profile_identity_and_tag_bounds",
  "state::machine_state_tests::tag_settings_enforce_builtin_and_custom_group_exclusivity",
  "agent_routing::tests::only_first_three_non_auto_models_are_default_until_an_exact_model_is_configured",
  "agent_routing::tests::portable_history_adds_image_and_video_requirements",
  "agent_routing::tests::routed_request_tags_are_bounded_and_media_vocabulary_is_closed",
  "agent_routing::tests::a_failed_exact_route_falls_through_to_the_next_live_cost_match",
  "session::manager::tests::migration_history_excludes_inputs_that_still_need_delivery",
  "session::manager::tests::migration_seed_target_distinguishes_an_explicit_default_model",
  "session::manager::tests::routing_metadata_change_keeps_the_same_agent_context",
  "session::manager::tests::cross_agent_migration_keeps_session_and_replays_history_once",
  "session::manager::tests::same_agent_model_switch_replays_accepted_history_once",
] as const;

defineSpecialty({
  id: "specialty.contracts.agent-capability-routing",
  title: "Agent routing preserves machine-global tag selection and portable context",
  oracle:
    "Existing machine-global tag validation, route selection and session migration properties execute independently of the removed Workflow engine",
  catches: [
    "routed Session pins an obsolete Agent or model",
    "route selection treats tags as OR rather than AND",
    "portable context is replayed more than once",
  ],
  tags: ["contract", "tag-routing"],
  llm: { default: "none" },
  expectedDurationMs: 45_000,
  timeoutMs: 300_000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "session"],
  productInterfaces: ["settings.agentPreferences", "session.switchAgent"],
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
      `Agent tag regression did not execute: ${test}\n${stdout.slice(-3000)}`,
      );
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `Agent tag regression failed: ${test}\n${(failure.stdout ?? "").slice(-4000)}\n${(failure.stderr ?? failure.message).slice(-3000)}`,
      );
    }
  }
  t.note(`Agent tag routing regressions passed=${TESTS.length}`);
});

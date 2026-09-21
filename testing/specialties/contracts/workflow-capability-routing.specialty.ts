import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

const TESTS = [
  "state::machine_state_tests::capability_settings_enforce_ordered_list_bounds_and_unique_routes",
  "workflow::tests::role_v2_declares_only_a_capability_direction",
  "workflow::tests::capability_routes_use_order_then_machine_runtime_defaults",
  "workflow::tests::capability_route_failure_is_human_actionable",
] as const;

defineSpecialty({
  id: "specialty.contracts.workflow-capability-routing",
  title: "Workflow roles resolve machine-global capability routes at dispatch",
  oracle:
    "Role v2 accepts only a capability direction; dispatch selects the first usable exact route and fails human-actionably when none is usable",
  catches: [
    "workflow package pins a concrete Agent or model",
    "unavailable preferred Agent prevents ordered fallback",
    "missing capability route disappears as a generic launch failure",
  ],
  tags: ["contract", "workflow", "capability-routing"],
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
        `Workflow capability regression did not execute: ${test}\n${stdout.slice(-3000)}`,
      );
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `Workflow capability regression failed: ${test}\n${(failure.stdout ?? "").slice(-4000)}\n${(failure.stderr ?? failure.message).slice(-3000)}`,
      );
    }
  }
  t.note(`Workflow capability routing regressions passed=${TESTS.length}`);
});

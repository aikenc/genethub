import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-manifest",
  title: "Workflow recovery selection is validated and pinned",
  oracle: "frontmatter accepts builtin or a package flow, rejects unsafe paths, and changes Candidate identity when the recovery selector changes",
  catches: ["recovery selector escapes the package", "custom recovery is absent from Candidate identity", "missing recovery flow activates"],
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
    "workflow::tests::recovery_flow_limits_are_checked_before_candidate_activation",
  ]) {
    const { stdout } = await promisify(execFile)("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
      "--", "--exact", "--nocapture",
    ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
      `${test} did not pass: ${stdout.slice(-2000)}`);
  }
});

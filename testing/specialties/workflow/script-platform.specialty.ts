import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.script-platform",
  title: "Retained Workflow platform faults execute real interpreters and preserve PM paths",
  oracle: "Existing native regression pins execute real Node and Bash, publish real files, enforce the deadline, and compare PM paths and kernel dependencies independently of OS separators and checkout line endings",
  catches: ["a canonical script path fails in the interpreter", "Windows selects the WSL launcher instead of the required local shell", "stdin, environment or cwd is lost", "a hanging process is left running", "a CRLF checkout scans the test code as production"],
  tags: ["contract", "workflow", "native-intrinsic", "script-platform"],
  llm: { default: "none" },
  expectedDurationMs: 15_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem", "process"],
  productInterfaces: ["pack.script interpreter/stdin/stdout contract", "Workflow PM request snapshot"],
}, async t => {
  for (const test of [
    "workflow::script::tests::a_shipped_file_wins_and_anything_else_is_left_to_the_os",
    "workflow::script::tests::a_package_names_its_own_interpreter_including_a_shell",
    "workflow::script::tests::a_script_receives_its_declared_environment_and_is_not_confined",
    "workflow::script::tests::a_script_reads_its_input_and_reports_through_stdout",
    "workflow::script::tests::the_reference_implementation_needs_no_repository_tooling",
    "workflow::script::tests::a_script_that_never_finishes_is_stopped",
    "workflow::script::tests::a_failing_interpreter_is_reported_rather_than_parsed",
    "workflow::script::tests::stdout_must_be_one_bounded_json_object",
    "workflow::tests::new_run_snapshot_follows_its_pm_request",
    "workflow::tests::the_workflow_kernel_names_no_git_concept_it_depends_on",
  ]) {
    const { stdout } = await promisify(execFile)("cargo", [
      "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
      "--", "--exact", "--nocapture",
    ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
      `${test} did not pass: ${stdout.slice(-2000)}`);
  }
});

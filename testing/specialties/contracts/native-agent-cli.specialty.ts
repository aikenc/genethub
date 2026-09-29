import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

// Retain the existing native process-argv regression nail at its owning boundary.
// Real installed CLI/public catalog behavior is covered by claude-catalog cases.
defineSpecialty({
  id: "specialty.contracts.native-agent-cli-boundary",
  title: "Claude-protocol CLIs keep distinct identities and valid subprocess arguments",
  oracle: "Existing native regressions observe actual child-process argv, wrapper separator and distinct history identity",
  catches: ["merge loses wrapper separator during permission fallback", "agent identities or history paths cross", "CodeBuddy receives a launch flag its parser rejects", "CodeBuddy model fields are ignored"],
  tags: ["contract", "claude-catalog", "native-agent-cli"], llm: { default: "none" },
  expectedDurationMs: 30000, timeoutMs: 300000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["native-subprocess", "os-process"],
}, async t => {
  try {
    const { stdout } = await promisify(execFile)("cargo", ["test", "--profile", "iterate", "-p", "genet-daemon", "--lib", "adapter::claude::tests::", "--", "--nocapture"], {
      cwd: t.openRoot, env: process.env, timeout: 280000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(!!result && Number(result[1]) >= 4, "Native TClaude regressions did not execute: " + stdout.slice(-3000));
    t.assertions.assert(stdout.includes("codebuddy_models_use_id_name_and_current_model_id ... ok"), "CodeBuddy model-field regression did not execute");
    if (process.platform !== "win32") {
      t.assertions.assert(stdout.includes("tclaude_asks_upstream_help_through_the_wrapper_separator ... ok"), "Native subprocess argv regression did not execute");
      t.assertions.assert(stdout.includes("codebuddy_launch_omits_the_flag_its_parser_rejects ... ok"), "CodeBuddy launch argv regression did not execute");
    }
    t.note(`Native Claude-protocol regressions passed=${result![1]}; platform=${process.platform}`);
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`Native CLI boundary failed: ${(e.stdout ?? "").slice(-4000)}\n${(e.stderr ?? e.message).slice(-3000)}`);
  }
});

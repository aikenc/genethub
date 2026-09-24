import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.request-writer-lock",
  title: "Workflow request writer belongs to one daemon data root",
  oracle: "the OS file lock excludes a second channel and becomes claimable after release",
  catches: ["two channels concurrently mutate one request", "a released request remains pinned"],
  tags: ["contract", "workflow", "storage", "native-intrinsic"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem"],
  productInterfaces: ["Workflow request writer file lock"],
}, async t => {
  const test = "workflow::tests::request_writer_is_exclusive_across_channel_data_roots";
  const { stdout } = await promisify(execFile)("cargo", [
    "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
    "--", "--exact", "--nocapture",
  ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
  t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
    `request writer test did not pass: ${stdout.slice(-2000)}`);
});

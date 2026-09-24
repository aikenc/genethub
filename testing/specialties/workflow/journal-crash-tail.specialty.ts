import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.journal-crash-tail",
  title: "Workflow journal discards an uncommitted crash tail",
  oracle: "only bytes named by the committed Run snapshot survive the next append",
  catches: ["a crash tail appears as committed history", "retry duplicates a journal sequence"],
  tags: ["contract", "workflow", "storage", "native-intrinsic"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem"],
  productInterfaces: ["Workflow Run snapshot and journal"],
}, async t => {
  const test = "workflow::journal::tests::crash_tail_is_discarded_before_the_next_commit";
  const { stdout } = await promisify(execFile)("cargo", [
    "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
    "--", "--exact", "--nocapture",
  ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
  t.assertions.assert(stdout.includes("test result: ok. 1 passed; 0 failed"),
    `journal crash boundary test did not pass: ${stdout.slice(-2000)}`);
  const generated = await mkdtemp(join(t.env.root, "workflow-journal-proto-"));
  const binding = await promisify(execFile)("cargo", [
    "test", "--profile", "iterate", "-p", "genehub-proto", "--lib", "export_bindings",
  ], { cwd: t.openRoot, env: { ...process.env, TS_RS_EXPORT_DIR: generated }, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
  t.assertions.assert(binding.stdout.includes("test result: ok."), "protocol binding generation failed");
  const actual = await readFile(join(generated, "index.ts"), "utf8");
  const checkedIn = await readFile(join(t.openRoot, "packages/proto/bindings/index.ts"), "utf8");
  let mismatch = 0;
  while (mismatch < actual.length && actual[mismatch] === checkedIn[mismatch]) mismatch++;
  t.assertions.assert(actual === checkedIn,
    `Workflow journal RPC bindings drifted at ${mismatch}: generated=${JSON.stringify(actual.slice(mismatch, mismatch + 180))}; checked-in=${JSON.stringify(checkedIn.slice(mismatch, mismatch + 180))}`);
});

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.journal-crash-tail",
  title: "Workflow journal discards crash tails and retains seven UTC days",
  oracle: "only committed bytes survive a crash and day rotation prunes segments outside the seven-day window",
  catches: ["a crash tail appears as committed history", "retry duplicates a journal sequence", "old journal segments remain after rotation"],
  tags: ["contract", "workflow", "storage", "native-intrinsic"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem"],
  productInterfaces: ["Workflow Run snapshot and journal"],
}, async t => {
  const test = "workflow::journal::tests";
  const { stdout } = await promisify(execFile)("cargo", [
    "test", "--profile", "iterate", "-p", "genet-daemon", "--lib", test,
    "--", "--nocapture",
  ], { cwd: t.openRoot, timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
  t.assertions.assert(stdout.includes("test result: ok. 6 passed; 0 failed"),
    `journal crash and retention tests did not pass: ${stdout.slice(-2000)}`);
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

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.workbench-typecheck",
  title: "Workbench public embedding builds against its protocol types",
  oracle: "The owning package TypeScript compiler accepts the complete Workbench without emitting assets",
  catches: ["Workbench changes fail the production build's typecheck"],
  tags: ["contract", "workbench-typecheck"], llm: { default: "none" }, requiredArtifacts: [],
  expectedDurationMs: 10_000, timeoutMs: 60_000,
  resources: { environments: 1, cpu: 1, memoryMb: 1024 }, surfaces: ["workbench-ui"],
}, async t => {
  const cwd = path.join(t.openRoot, "packages/workbench");
  try {
    await promisify(execFile)(process.execPath, [path.join(cwd, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"], { cwd, timeout: 55_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const cause = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${cause.stdout ?? ""}\n${cause.stderr ?? cause.message}`);
  }
  t.note("Owning Workbench package typecheck passed");
});

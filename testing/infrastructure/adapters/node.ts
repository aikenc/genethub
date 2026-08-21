import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

import type { UnitResult, WorkUnit } from "../types.ts";
import { createLease, releaseLease } from "../environment/lease.ts";
import { killProcessGroup } from "../environment/cleanup.ts";
import { spawnGroup } from "../process/group.ts";
import { waitForExit } from "../process/wait.ts";
import { collectFailureDiagnostic } from "../evidence/failure-diagnostic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(HERE, "../../framework/worker.ts");

export async function runNodeUnit(unit: WorkUnit, extraEnv: Record<string, string>): Promise<UnitResult> {
  const lease = createLease();
  const resultDir = mkdtempSync(path.join(tmpdir(), "testctl-result-"));
  const resultPath = path.join(resultDir, "result.json");
  const tsx = path.join(path.dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
  const child = spawnGroup(process.execPath, [tsx, WORKER], {
    env: {
      ...process.env,
      ...lease.env,
      ...extraEnv,
      TESTCTL_UNIT_ID: unit.id,
      TESTCTL_CASE_ID: unit.caseId,
      TESTCTL_VARIANT: unit.variant,
      TESTCTL_CASE_FILE: unit.meta.file,
      TESTCTL_RESULT_PATH: resultPath,
      TESTCTL_LEASE_ROOT: lease.root,
    },
  });
  try {
    await waitForExit(child, unit.meta.timeoutMs);
    const raw = readFileSync(resultPath, "utf8");
    const result = JSON.parse(raw) as UnitResult;
    if (result.status !== "passed" && result.status !== "not-applicable") {
      result.diagnostic = collectFailureDiagnostic(lease);
    }
    return result;
  } catch (error) {
    if (child.pid) killProcessGroup(child.pid);
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: message.includes("exceeded") ? "interrupted" : "failed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      message,
      diagnostic: collectFailureDiagnostic(lease),
    };
  } finally {
    if (child.pid) killProcessGroup(child.pid);
    releaseLease(lease);
    rmSync(resultDir, { recursive: true, force: true });
  }
}

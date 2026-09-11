import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

import type { UnitResult, WorkUnit } from "../types.ts";
import { createLease, releaseLease } from "../environment/lease.ts";
import { trackResources } from "../environment/resource-census.ts";
import { killProcessGroup } from "../environment/cleanup.ts";
import { spawnGroup } from "../process/group.ts";
import { waitForExit } from "../process/wait.ts";
import { redactText } from "../evidence/redact.ts";
import { collectFailureDiagnostic } from "../evidence/failure-diagnostic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(HERE, "../../framework/worker.ts");

export async function runNodeUnit(unit: WorkUnit, extraEnv: Record<string, string>): Promise<UnitResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
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
      TESTCTL_STAGES_PATH: path.join(resultDir, "stages.json"),
      TESTCTL_LEASE_ROOT: lease.root,
      TESTCTL_RESOURCE_OWNER: lease.id,
    },
  });
  const resources = trackResources(lease.id, child.pid ?? -1);
  let result: UnitResult | undefined;
  let stderrTail = "";
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-8192); });
  try {
    await waitForExit(child, unit.meta.timeoutMs);
    const raw = readFileSync(resultPath, "utf8");
    result = JSON.parse(raw) as UnitResult;
    if (result.status !== "passed" && result.status !== "not-applicable") {
      result.diagnostic = collectFailureDiagnostic(lease);
    }
    return result;
  } catch (error) {
    if (child.pid) killProcessGroup(child.pid);
    const message = error instanceof Error ? error.message : String(error);
    result = {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: message.includes("exceeded") ? "interrupted" : "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message: message + `; worker exit=${child.exitCode} signal=${child.signalCode}; ` + stderrTail.split("\n").filter(line => /^\s+at /.test(line)).slice(-8).map(line => redactText(line)).join(" | "),
      diagnostic: collectFailureDiagnostic(lease),
    };
    return result;
  } finally {
    const cleanup = await resources.finish();
    if (result) {
      const stagesPath = path.join(resultDir, "stages.json");
      if (existsSync(stagesPath)) result.stages = JSON.parse(readFileSync(stagesPath, "utf8"));
      if (result.status === "passed" && result.stages?.some(s => s.status !== "passed")) { result.status = "failed"; result.message = "declared stages not completed"; }
      result.cleanup = cleanup;
      if ((cleanup.before.processes ?? 0) > 0 || (cleanup.before.ports ?? 0) > 0) {
        if (result.status === "passed") result.status = "failed";
        result.message = (result.message ?? "") + "; leaked resources before forced cleanup: " + JSON.stringify(cleanup.before);
      }
    }
    if (child.pid) killProcessGroup(child.pid);
    releaseLease(lease);
    rmSync(resultDir, { recursive: true, force: true });
  }
}

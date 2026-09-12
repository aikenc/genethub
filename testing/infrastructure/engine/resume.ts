import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunManifest, UnitResult, WorkUnit } from "../types.ts";
import { POLICY_VERSION, RUNNER_VERSION } from "../types.ts";

export function reusableResults(runDir: string, binding: NonNullable<RunManifest["resumeBinding"]>, units: WorkUnit[]) {
  const manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8")) as RunManifest;
  if (manifest.schema !== "genehub.test-run.v1" || manifest.runnerVersion !== RUNNER_VERSION ||
      manifest.qualification?.policyVersion !== POLICY_VERSION || !manifest.resumeBinding ||
      manifest.inputDrift !== false || !manifest.inputObservation?.complete) {
    throw new Error("resume requires finalized v2 evidence with complete, unchanged input observation; start a fresh run");
  }
  if (manifest.resumeBinding.common !== binding.common) {
    throw new Error("resume inputs differ (source, artifacts, environment, policy or selection); start a fresh run");
  }
  const results = readFileSync(path.join(runDir, "results.ndjson"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as UnitResult);
  const expected = new Set(units.map(unit => unit.id));
  if (results.length !== units.length || new Set(results.map(r => r.id)).size !== results.length ||
      results.some(r => !expected.has(r.id) || !units.some(u => u.id === r.id && u.caseId === r.caseId && u.variant === r.variant)) ||
      manifest.counts.total !== results.length) throw new Error("resume evidence has missing, duplicate or unexpected results");
  if (manifest.status === "failed" || manifest.status === "unstable" || results.some(r => r.status === "failed" || r.status === "unstable" || (r.status === "interrupted" && r.durationMs > 0))) {
    throw new Error("failed, unstable or timed-out evidence cannot be retried into a green run; diagnose it and start a fresh run retaining the failure reference");
  }
  const reusable = results.filter(result => result.status === "passed" &&
    binding.cases[result.caseId] === manifest.resumeBinding!.cases[result.caseId] &&
    result.cleanup?.before.processes === 0 && result.cleanup.before.ports === 0 &&
    result.cleanup.after.processes === 0 && result.cleanup.after.ports === 0);
  return { runId: manifest.runId, results: reusable.map(result => ({ ...result, reusedFrom: { runId: manifest.runId, unitId: result.id } })) };
}

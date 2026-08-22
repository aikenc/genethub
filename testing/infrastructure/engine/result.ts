import type { CaseStatus, RunStatus, UnitResult } from "../types.ts";

export function emptyCounts(): Record<CaseStatus | "total", number> {
  return {
    passed: 0,
    failed: 0,
    blocked: 0,
    unstable: 0,
    interrupted: 0,
    "not-applicable": 0,
    total: 0,
  };
}

export function addResult(
  counts: Record<CaseStatus | "total", number>,
  result: UnitResult,
): void {
  counts[result.status] += 1;
  counts.total += 1;
}

export function rollupStatus(results: UnitResult[]): RunStatus {
  if (results.some((item) => item.status === "interrupted")) return "interrupted";
  if (results.some((item) => item.status === "unstable")) return "unstable";
  if (results.some((item) => item.status === "failed")) return "failed";
  if (results.some((item) => item.status === "blocked")) return "blocked";
  return "passed";
}

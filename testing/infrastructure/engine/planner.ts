import type { CaseMeta, GateName, WorkUnit } from "../types.ts";
import { selectForGate } from "../../policies/gates.ts";

export interface Plan {
  gate: GateName;
  units: WorkUnit[];
  skipped: Array<{ id: string; reason: string }>;
  estimatedMs: number;
}

export function planCases(cases: CaseMeta[], gate: GateName, tags: string[] = [], ids: string[] = [], reason = ""): Plan {
  if (gate === "dev-feedback" && (!(tags.length || ids.length) || !reason.trim())) {
    throw new Error("dev-feedback requires --case/--tags and --reason explaining the affected behavior and remaining verification; it cannot qualify a full release gate");
  }
  const unknown = ids.filter(id => !cases.some(item => item.id === id));
  if (unknown.length) throw new Error(`unknown case IDs: ${unknown.join(", ")}`);
  const selected: CaseMeta[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const item of cases) {
    if (ids.length && !ids.includes(item.id)) {
      skipped.push({ id: item.id, reason: "case filter" });
      continue;
    }
    const decision = selectForGate(item, gate, tags);
    if (decision.include) selected.push(item);
    else skipped.push({ id: item.id, reason: decision.reason });
  }
  if (selected.length === 0) throw new Error("selection contains no test cases; check gate, case IDs and tags");
  const units = selected
    .map((meta) => ({
      id: `${meta.id}::default`,
      caseId: meta.id,
      variant: "default",
      meta,
    }))
    .sort((a, b) => b.meta.expectedDurationMs - a.meta.expectedDurationMs);
  return {
    gate,
    units,
    skipped,
    estimatedMs: units.reduce((sum, unit) => sum + unit.meta.expectedDurationMs, 0),
  };
}

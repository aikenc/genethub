import type { CaseMeta, GateName, WorkUnit } from "../types.ts";
import { selectForGate } from "../../policies/gates.ts";

export interface Plan {
  gate: GateName;
  units: WorkUnit[];
  skipped: Array<{ id: string; reason: string }>;
  estimatedMs: number;
}

export function planCases(cases: CaseMeta[], gate: GateName, tags: string[] = []): Plan {
  const selected: CaseMeta[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const item of cases) {
    const decision = selectForGate(item, gate, tags);
    if (decision.include) selected.push(item);
    else skipped.push({ id: item.id, reason: decision.reason });
  }
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

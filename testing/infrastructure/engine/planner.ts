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
    .sort((a, b) => {
      const left = a.meta.sequence;
      const right = b.meta.sequence;
      if (left && right) {
        const bySequence = left.id.localeCompare(right.id);
        return bySequence || left.order - right.order;
      }
      // Sequence groups run before ordinary scheduler work. Preserve that
      // execution order in `plan` output so a shared-project journey never
      // appears to promise a different evolution than `run` performs.
      if (left) return -1;
      if (right) return 1;
      return b.meta.expectedDurationMs - a.meta.expectedDurationMs;
    });
  return {
    gate,
    units,
    skipped,
    estimatedMs: units.reduce((sum, unit) => sum + unit.meta.expectedDurationMs, 0),
  };
}

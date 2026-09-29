/** Read-only platform measurements. Quality and dependency semantics belong to the pack. */
export type WorkflowObservation = {
  parallelism?: number;
  peakWorkers?: number;
  executionMs?: number;
  budgetPercent?: number;
  callBudgetPercent?: number;
  timeBudgetPercent?: number;
  estimatedMilliCny?: number;
  recovering?: number;
  additionalIterationRounds?: number;
  iterations?: Array<{runId: string; frameId: number; rounds: number}>;
  requestBudget?: {observedLlmRounds: number; executionMs: number; remainingRuns: number;
    budget: {maxLlmRounds: number; deadlineMs: number}};
};

export function workflowObservation(value: unknown): WorkflowObservation | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as WorkflowObservation : undefined;
}

export function observationLabel(value: unknown): string {
  const observation = workflowObservation(value);
  if (!observation) return "";
  return `${observation.recovering ? "恢复中 · " : ""}并行 ${(observation.parallelism ?? 0).toFixed(1)} 人 · 预算 ${Math.round(observation.budgetPercent ?? 0)}%`;
}

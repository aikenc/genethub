import { defineSpecialty } from "../../framework/public.ts";
import { claimNext, completeUnit, createScheduler, defaultBudget, hasClaimable } from "../../framework/public.ts";

type WorkUnit = Parameters<typeof createScheduler>[0][number];

defineSpecialty({
  id: "specialty.contracts.scheduler-exclusive",
  title: "Exclusive benchmarks run alone while ordinary cases retain parallel scheduling",
  oracle: "An exclusive case both waits for running work and prevents further claims; completing it restores the exact token budget",
  catches: ["exclusive pool is permanently unschedulable", "parallel load contaminates a sequential benchmark", "exclusive execution leaks scheduler tokens"],
  tags: ["contract", "scheduler-exclusive"], llm: { default: "none" },
  expectedDurationMs: 200, timeoutMs: 10000, surfaces: ["testctl-scheduler"],
}, async (t) => {
  const unit = (id: string, pool: "standard" | "exclusive", duration: number): WorkUnit => ({
    id, caseId: id, variant: "default",
    meta: { id, title: id, kind: "specialty", runner: "node", oracle: "scheduler fixture", catches: [], tags: [],
      llm: { default: "none" }, expectedDurationMs: duration, timeoutMs: 1000, surfaces: ["scheduler"], file: "fixture.ts",
      resources: { environments: 1, cpu: 2, memoryMb: 128, io: 1, browser: 0, pool } },
  });
  const budget = defaultBudget(16);
  const exclusive = unit("exclusive", "exclusive", 300);
  const a = unit("a", "standard", 200), b = unit("b", "standard", 100);
  const scheduler = createScheduler([a, exclusive, b], budget);
  t.assertions.assert(claimNext(scheduler)?.id === exclusive.id, "Exclusive case did not fit a normal budget");
  t.assertions.assert(!hasClaimable(scheduler) && claimNext(scheduler) === undefined, "Work overlapped an exclusive case");
  completeUnit(scheduler, exclusive, 300);
  t.assertions.assert(claimNext(scheduler)?.id === a.id && claimNext(scheduler)?.id === b.id, "Ordinary cases lost parallel execution");
  const waiting = unit("waiting-exclusive", "exclusive", 400);
  scheduler.pending.push(waiting);
  t.assertions.assert(!hasClaimable(scheduler) && claimNext(scheduler) === undefined, "Exclusive case started alongside ordinary work");
  completeUnit(scheduler, a, 200);
  t.assertions.assert(claimNext(scheduler) === undefined, "Exclusive case did not wait for the final running case");
  completeUnit(scheduler, b, 100);
  t.assertions.assert(claimNext(scheduler)?.id === waiting.id, "Waiting exclusive case never became claimable");
  completeUnit(scheduler, waiting, 400);
  t.assertions.assert(JSON.stringify(scheduler.available) === JSON.stringify(budget), "Scheduler token budget was not restored");
  const oversized = unit("oversized", "exclusive", 100);
  oversized.meta.resources.memoryMb = budget.memoryMb + 1;
  const limited = createScheduler([oversized], budget);
  t.assertions.assert(!hasClaimable(limited) && claimNext(limited) === undefined, "Exclusive pool bypassed actual resource limits");
});

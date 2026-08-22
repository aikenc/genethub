import type { ResourcePool, WorkUnit } from "../types.ts";

export interface TokenBudget {
  environments: number;
  cpu: number;
  memoryMb: number;
  io: number;
  browser: number;
}

export interface SchedulerState {
  pending: WorkUnit[];
  running: Map<string, WorkUnit>;
  available: TokenBudget;
  history: Map<string, number>;
  stragglers: string[];
}

const POOL_WEIGHT: Record<ResourcePool, Partial<TokenBudget>> = {
  standard: {},
  browser: {},
  heavy: { cpu: 4 },
  exclusive: { environments: 99 },
  "real-llm": {},
};

export function defaultBudget(environments: number): TokenBudget {
  return {
    environments,
    cpu: Math.max(environments, 8),
    memoryMb: Math.max(environments * 768, 2048),
    io: environments,
    browser: Math.min(4, Math.max(1, Math.floor(environments / 4))),
  };
}

export function createScheduler(units: WorkUnit[], budget: TokenBudget): SchedulerState {
  return {
    pending: [...units],
    running: new Map(),
    available: { ...budget },
    history: new Map(),
    stragglers: [],
  };
}

function cost(unit: WorkUnit): TokenBudget {
  const extra = POOL_WEIGHT[unit.meta.resources.pool];
  return {
    environments: unit.meta.resources.environments + (extra.environments ?? 0),
    cpu: Math.max(unit.meta.resources.cpu, extra.cpu ?? 0),
    memoryMb: unit.meta.resources.memoryMb + (extra.memoryMb ?? 0),
    io: unit.meta.resources.io + (extra.io ?? 0),
    browser: unit.meta.resources.browser + (extra.browser ?? 0),
  };
}

function fits(available: TokenBudget, need: TokenBudget): boolean {
  return (
    available.environments >= need.environments &&
    available.cpu >= need.cpu &&
    available.memoryMb >= need.memoryMb &&
    available.io >= need.io &&
    available.browser >= need.browser
  );
}

function take(available: TokenBudget, need: TokenBudget): void {
  available.environments -= need.environments;
  available.cpu -= need.cpu;
  available.memoryMb -= need.memoryMb;
  available.io -= need.io;
  available.browser -= need.browser;
}

function give(available: TokenBudget, need: TokenBudget): void {
  available.environments += need.environments;
  available.cpu += need.cpu;
  available.memoryMb += need.memoryMb;
  available.io += need.io;
  available.browser += need.browser;
}

export function hasClaimable(state: SchedulerState): boolean {
  return state.pending.some((unit) => fits(state.available, cost(unit)));
}

export function claimNext(state: SchedulerState): WorkUnit | undefined {
  let index = -1;
  let longest = -1;
  for (let i = 0; i < state.pending.length; i += 1) {
    const unit = state.pending[i];
    if (!unit || !fits(state.available, cost(unit))) continue;
    const expected = state.history.get(unit.caseId) ?? unit.meta.expectedDurationMs;
    if (expected > longest) {
      longest = expected;
      index = i;
    }
  }
  if (index < 0) return undefined;
  const [unit] = state.pending.splice(index, 1);
  if (!unit) return undefined;
  take(state.available, cost(unit));
  state.running.set(unit.id, unit);
  return unit;
}

export function completeUnit(state: SchedulerState, unit: WorkUnit, durationMs: number): void {
  if (!state.running.delete(unit.id)) return;
  give(state.available, cost(unit));
  const expected = state.history.get(unit.caseId) ?? unit.meta.expectedDurationMs;
  if (durationMs > expected * 2) state.stragglers.push(unit.caseId);
  state.history.set(unit.caseId, durationMs);
}

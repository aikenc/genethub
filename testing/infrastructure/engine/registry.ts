import {
  DEFAULT_RESOURCES,
  type CaseDefinition,
  type CaseKind,
  type CaseMeta,
  type CaseResources,
  type LlmOptions,
  type RunnerKind,
} from "../types.ts";

const cases = new Map<string, CaseDefinition>();

export interface DefineInput {
  id: string;
  title: string;
  oracle: string;
  catches: string[];
  tags: string[];
  runner?: RunnerKind;
  llm?: LlmOptions;
  resources?: Partial<CaseResources>;
  expectedDurationMs: number;
  timeoutMs: number;
  surfaces: string[];
  productInterfaces?: string[];
  requiredArtifacts?: string[];
  doubleExceptions?: CaseMeta["doubleExceptions"];
  retention?: boolean;
  sequence?: CaseMeta["sequence"];
}

function register(kind: CaseKind, input: DefineInput, run: CaseDefinition["run"], file: string): void {
  if (cases.has(input.id)) {
    throw new Error(`duplicate case id ${input.id}`);
  }
  const meta: CaseMeta = {
    id: input.id,
    title: input.title,
    kind,
    oracle: input.oracle,
    catches: input.catches,
    tags: input.tags,
    runner: input.runner ?? "node",
    llm: input.llm ?? { default: "none" },
    resources: { ...DEFAULT_RESOURCES, ...input.resources },
    expectedDurationMs: input.expectedDurationMs,
    timeoutMs: input.timeoutMs,
    surfaces: input.surfaces,
    productInterfaces: input.productInterfaces,
    requiredArtifacts: input.requiredArtifacts,
    doubleExceptions: input.doubleExceptions,
    retention: input.retention,
    sequence: input.sequence,
    file,
  };
  cases.set(input.id, { ...meta, run });
}

export function defineJourney(input: DefineInput, run: CaseDefinition["run"], file: string): void {
  register("journey", input, run, file);
}

export function defineSpecialty(input: DefineInput, run: CaseDefinition["run"], file: string): void {
  register("specialty", input, run, file);
}

export function defineE2e(input: DefineInput, run: CaseDefinition["run"], file: string): void {
  register("e2e", input, run, file);
}

export function getRegisteredCase(id: string): CaseDefinition | undefined {
  return cases.get(id);
}

export function listRegisteredCases(): CaseDefinition[] {
  return [...cases.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resetRegistry(): void {
  cases.clear();
}

export function assignFile(ids: Set<string>, file: string): void {
  for (const item of cases.values()) {
    if (ids.has(item.id)) item.file = file;
  }
}

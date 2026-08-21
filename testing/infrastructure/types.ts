export type CaseKind = "journey" | "specialty" | "e2e";
export type RunnerKind = "node" | "playwright" | "rust-legacy";
export type CaseStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "unstable"
  | "interrupted"
  | "not-applicable";
export type RunStatus = "passed" | "failed" | "blocked" | "unstable" | "interrupted";
export type ResourcePool = "standard" | "browser" | "heavy" | "exclusive" | "real-llm";
export type GateName =
  | "change"
  | "merge"
  | "dev"
  | "beta"
  | "official"
  | "infra-compact"
  | "infra-parallel"
  | "specialty:page-experience"
  | "specialty:contracts";

export interface CaseResources {
  environments: number;
  cpu: number;
  memoryMb: number;
  io: number;
  browser: number;
  pool: ResourcePool;
}

export interface DoubleException {
  component: string;
  reason: string;
  canary: string;
  expiresWhen: string;
}

export interface LlmOptions {
  default: "mock" | "real" | "none";
  realEligible?: boolean;
}

export interface CaseMeta {
  id: string;
  title: string;
  kind: CaseKind;
  oracle: string;
  catches: string[];
  tags: string[];
  runner: RunnerKind;
  llm: LlmOptions;
  resources: CaseResources;
  expectedDurationMs: number;
  timeoutMs: number;
  surfaces: string[];
  productInterfaces?: string[];
  requiredArtifacts?: string[];
  doubleExceptions?: DoubleException[];
  retention?: boolean;
  file: string;
}

export interface CaseDefinition extends CaseMeta {
  run: (ctx: unknown) => Promise<void>;
}

export interface WorkUnit {
  id: string;
  caseId: string;
  variant: string;
  meta: CaseMeta;
}

export interface UnitResult {
  id: string;
  caseId: string;
  variant: string;
  status: CaseStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  message?: string;
  blockedReason?: string;
  /** Bounded failure-only evidence. Kept out of results.ndjson and redacted by the run store. */
  diagnostic?: string;
}

export interface RepoIdentity {
  path: string;
  sha: string;
  branch: string;
  dirty: boolean;
  dirtyDigest: string;
}

export interface ArtifactIdentity {
  path: string | null;
  hash: string | null;
  kind: string;
}

export interface RunQualification {
  gate: GateName;
  policyVersion: string;
  qualified: boolean;
  reasons: string[];
}

export interface RunManifest {
  schema: "genehub.test-run.v1";
  runId: string;
  topic: string;
  gate: GateName;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  localTime: string;
  rfc3339: string;
  utc: string;
  trigger: string;
  runnerVersion: string;
  open: RepoIdentity;
  cloud: RepoIdentity;
  artifact: ArtifactIdentity;
  catalogDigest: string;
  selected: string[];
  notExecuted: Array<{ id: string; reason: string }>;
  counts: Record<CaseStatus | "total", number>;
  qualification: RunQualification;
  governanceDigest?: string;
  environments: number;
  resultsPath: string;
  leak: { processes: number; ports: number };
}

export interface CliOptions {
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export class BlockedError extends Error {
  readonly blockedReason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "BlockedError";
    this.blockedReason = reason;
  }
}

export class UnstableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnstableError";
  }
}

export const DEFAULT_RESOURCES: CaseResources = {
  environments: 1,
  cpu: 1,
  memoryMb: 256,
  io: 1,
  browser: 0,
  pool: "standard",
};

export const RUNNER_VERSION = "testctl.v1";
export const POLICY_VERSION = "gates.v1";

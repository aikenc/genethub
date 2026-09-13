import type { WorkUnit } from "../types.ts";
import {
  DAEMON_COMPONENT,
  GENET,
  ensureRuntimeArtifacts,
  isRuntimeArtifact,
} from "./artifacts.ts";

export interface PreflightInput {
  units: WorkUnit[];
  openRoot: string;
  cloudRoot?: string;
  /** False when the caller states the build is already prepared. */
  build: boolean;
}

export interface PreflightReport {
  /** Reasons the run must not start at all. */
  refusals: string[];
  /** Artifacts whose currency this run did not prove. */
  unprovenArtifacts: string[];
}

/**
 * Answers "can this plan honestly run here" before the first unit starts.
 *
 * Both checks exist because the alternative was discovering the answer at the
 * end: a gate without `--cloud` spent its whole runtime and then reported one
 * case blocked and the whole run unqualified, and a plan whose product binary
 * predated the change under test passed every case against code nobody had
 * compiled.
 */
export function preflightRun(input: PreflightInput): PreflightReport {
  const refusals: string[] = [];

  const needsCloud = input.units.filter((unit) => unit.meta.requiredRepos?.includes("cloud"));
  if (needsCloud.length > 0 && !input.cloudRoot) {
    const ids = [...new Set(needsCloud.map((unit) => unit.caseId))].sort();
    refusals.push(
      `${ids.length} planned case(s) boot the real Cloud control plane and need --cloud <path to the cloud worktree>:\n` +
        ids.map((id) => `  ${id}`).join("\n") +
        "\nRerun with --cloud, or narrow the plan with --tags so those cases are not selected.",
    );
  }

  // Nothing below is worth a compile if the plan already cannot run.
  if (refusals.length > 0) return { refusals, unprovenArtifacts: [] };

  const needed = requiredArtifacts(input.units);
  const problems = ensureRuntimeArtifacts(input.openRoot, needed, { build: input.build });
  if (problems.length > 0) {
    refusals.push(
      "the product build this plan tests is not usable:\n" +
        problems.map((problem) => `  ${problem.name}: ${problem.detail}`).join("\n") +
        "\nBuild it with:\n" +
        [...new Set(problems.map((problem) => `  ${problem.buildCommand}`))].join("\n"),
    );
  }
  return {
    refusals,
    unprovenArtifacts: input.build ? [] : needed,
  };
}

/**
 * Which build outputs this plan cannot be trusted without.
 *
 * `openWorkspace` is the framework's only door into the product and it
 * resolves the launcher and the daemon component for every case that walks
 * through it, so any plan with a case running in-process needs both. Anything
 * a case names in `requiredArtifacts` is added on top — those declarations
 * were previously read by nothing at all.
 */
function requiredArtifacts(units: WorkUnit[]): string[] {
  const needed = new Set<string>();
  for (const unit of units) {
    if (unit.meta.runner !== "rust-legacy" && unit.meta.requiredArtifacts?.length !== 0) {
      needed.add(GENET);
      needed.add(DAEMON_COMPONENT);
    }
    for (const declared of unit.meta.requiredArtifacts ?? []) {
      // An explicit empty list denotes a case that does not start the product.
      // A case may name a fixture that is not a build output; only artifacts
      // this module knows how to locate can be checked.
      if (isRuntimeArtifact(declared)) needed.add(declared);
    }
  }
  return [...needed].sort();
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import type { CaseMeta } from "../types.ts";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface Preflight {
  issues: Array<{ caseId: string; reason: string }>;
  checked: number;
  environment: { common: string; cases: Record<string, string> };
}

/** Read-only, bounded probes. Requirements are owned by case metadata, never case IDs. */
export async function preflight(cases: CaseMeta[], environment: NodeJS.ProcessEnv = process.env): Promise<Preflight> {
  const keys = new Set(cases.flatMap(item => (item.requirements ?? []).map(req => req.env)));
  const common = digest(Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !keys.has(key) && !["_", "PWD", "OLDPWD", "SHLVL"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))));
  const issues: Preflight["issues"] = [];
  const fingerprints: Record<string, string> = {};
  const probes = new Map<string, { ok: boolean; identity: string; reason: string }>();
  for (const item of cases) {
    const identities: string[] = [];
    for (const req of item.requirements ?? []) {
      if (req.kind !== "python" || !/^[A-Z][A-Z0-9_]*$/.test(req.env) ||
          req.minVersion.length !== 2 || !req.minVersion.every(n => Number.isInteger(n) && n >= 0) ||
          req.modules.some(m => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(m))) {
        throw new Error(`invalid requirement metadata: ${item.id}`);
      }
      const executable = environment[req.env] ?? "";
      const key = digest([req, executable]);
      let probe = probes.get(key);
      if (!probe) {
        const reason = `${req.env} requires an absolute Python ${req.minVersion.join(".")}+ executable with ${req.modules.join(", ") || "standard library"}`;
        if (!path.isAbsolute(executable)) probe = { ok: false, identity: key, reason };
        else {
          // Do not print subprocess output: module imports can emit local paths or credentials.
          const script = "import sys,json,importlib,importlib.metadata as m; mods=json.loads(sys.argv[1]); v=tuple(json.loads(sys.argv[2])); assert sys.version_info[:2]>=v; loaded=[importlib.import_module(x) for x in mods]; print(json.dumps({'executable':sys.executable,'version':sys.version,'modules':[(x.__name__,getattr(x,'__version__',None),getattr(x,'__file__',None)) for x in loaded]}))";
          const output = await new Promise<string | null>(resolve => execFile(executable,
            ["-c", script, JSON.stringify(req.modules), JSON.stringify(req.minVersion)],
            { env: environment, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
            (error, stdout) => resolve(error ? null : stdout)));
          let identity: unknown;
          try { identity = output ? JSON.parse(output) : null; } catch { identity = null; }
          probe = { ok: identity !== null, identity: digest([key, identity]), reason };
        }
        probes.set(key, probe);
      }
      identities.push(probe.identity);
      if (!probe.ok) issues.push({ caseId: item.id, reason: probe.reason });
    }
    // Common environment is bound separately. Only explicitly declared dependencies may vary per case.
    fingerprints[item.id] = digest(identities);
  }
  return { issues, checked: probes.size, environment: { common, cases: fingerprints } };
}

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
    if (unit.meta.runner !== "rust-legacy") {
      needed.add(GENET);
      needed.add(DAEMON_COMPONENT);
    }
    for (const declared of unit.meta.requiredArtifacts ?? []) {
      // A case may name a fixture that is not a build output; only artifacts
      // this module knows how to locate can be checked.
      if (isRuntimeArtifact(declared)) needed.add(declared);
    }
  }
  return [...needed].sort();
}

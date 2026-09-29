import type { CaseMeta, GateName } from "../infrastructure/types.ts";

export function parseGate(value: string): GateName {
  const names: GateName[] = ["change", "merge", "dev", "dev-feedback", "beta", "stable"];
  if (!names.includes(value as GateName)) throw new Error(`unknown gate: ${value}`);
  return value as GateName;
}

export function selectForGate(
  item: CaseMeta,
  gate: GateName,
  tags: string[] = [],
): { include: boolean; reason: string } {
  if (tags.length > 0 && !tags.some((tag) => item.tags.includes(tag))) {
    return { include: false, reason: "tag filter" };
  }
  if (gate === "dev-feedback") return { include: true, reason: "explicit feedback scope; not a complete release gate" };
  if (item.llm.default === "real" && gate !== "beta" && gate !== "stable") {
    return { include: false, reason: "real LLM canary is release-only" };
  }
  if (item.runner === "playwright") {
    return gate === "beta" || gate === "stable"
      ? { include: true, reason: "release browser matrix" }
      : { include: false, reason: "playwright not in this gate" };
  }
  if (item.kind === "e2e") {
    return gate === "beta" || gate === "stable"
      ? { include: true, reason: "release platform matrix" }
      : { include: false, reason: "e2e platform matrix not in this gate" };
  }
  if (item.tags.includes("infra-compact") && tags.length === 0) {
    return { include: false, reason: "infra-compact only" };
  }
  if (item.tags.includes("product-journey")) {
    return { include: true, reason: "core product journey" };
  }
  if (item.tags.includes("infra")) {
    return gate === "change" || gate === "merge"
      ? { include: true, reason: "infra proof in local gates" }
      : { include: false, reason: "infra proof not a release case" };
  }
  if (gate === "change") {
    return item.tags.includes("core") || item.tags.includes("contract")
      ? { include: true, reason: "change core/contract" }
      : { include: false, reason: "outside change set" };
  }
  return { include: true, reason: "gate default include" };
}

export function qualificationReasons(input: {
  gate: GateName;
  dirty: boolean;
  artifactHash: string | null;
  blocked: number;
  failed: number;
  unstable: number;
  interrupted: number;
  openSha?: string;
  cloudSha?: string;
  requiredOpenSha?: string;
  requiredCloudSha?: string;
  requiredArtifactHash?: string;
  requiredNotExecuted?: string[];
  unprovenArtifacts?: string[];
  leakedProcessGroups?: number;
}): string[] {
  const reasons: string[] = [];
  if (input.failed > 0) reasons.push("failed cases present");
  if (input.blocked > 0) reasons.push("required cases blocked");
  if (input.unstable > 0) reasons.push("run marked unstable");
  if (input.interrupted > 0) reasons.push("run interrupted");
  if ((input.gate === "dev" || input.gate === "beta" || input.gate === "stable") && input.dirty) {
    reasons.push("dirty worktree cannot qualify a release gate");
  }
  if ((input.gate === "dev" || input.gate === "beta" || input.gate === "stable") && !input.artifactHash) {
    reasons.push("release gate requires an immutable artifact hash");
  }
  if (input.requiredOpenSha && input.openSha && input.requiredOpenSha !== input.openSha) {
    reasons.push("open SHA does not match required identity");
  }
  if (input.requiredCloudSha && input.cloudSha && input.requiredCloudSha !== input.cloudSha) {
    reasons.push("cloud SHA does not match required identity");
  }
  if (input.requiredArtifactHash && !input.artifactHash) {
    reasons.push("required artifact hash present but artifact missing");
  }
  if (input.requiredArtifactHash && input.artifactHash && input.requiredArtifactHash !== input.artifactHash) {
    reasons.push("artifact hash does not match required identity; rebuild or wrong binary");
  }
  if (input.requiredNotExecuted && input.requiredNotExecuted.length > 0) {
    reasons.push(`required cases not executed: ${input.requiredNotExecuted.join(",")}`);
  }
  if (
    (input.gate === "dev" || input.gate === "beta" || input.gate === "stable") &&
    input.unprovenArtifacts &&
    input.unprovenArtifacts.length > 0
  ) {
    reasons.push(
      `release gate cannot accept an unproven build: ${input.unprovenArtifacts.join(",")}`,
    );
  }
  if (input.leakedProcessGroups && input.leakedProcessGroups > 0) {
    reasons.push(`${input.leakedProcessGroups} unit process group(s) survived the run`);
  }
  return reasons;
}

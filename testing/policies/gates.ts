import type { CaseMeta, GateName } from "../infrastructure/types.ts";

export function selectForGate(
  item: CaseMeta,
  gate: GateName,
  tags: string[] = [],
): { include: boolean; reason: string } {
  if (tags.length > 0 && !tags.some((tag) => item.tags.includes(tag))) {
    return { include: false, reason: "tag filter" };
  }
  if (item.resources.pool === "real-llm" && tags.length === 0) {
    return { include: false, reason: "real LLM qualification requires an explicit tag" };
  }
  if (gate === "infra-compact") {
    return item.tags.includes("infra-compact")
      ? { include: true, reason: "infra compact" }
      : { include: false, reason: "not infra-compact" };
  }
  if (gate === "infra-parallel") {
    return item.tags.includes("infra-parallel")
      ? { include: true, reason: "infra parallel" }
      : { include: false, reason: "not infra-parallel" };
  }
  if (gate === "specialty:page-experience") {
    return item.tags.includes("page-experience")
      ? { include: true, reason: "page specialty" }
      : { include: false, reason: "not page-experience" };
  }
  if (gate === "specialty:contracts") {
    return item.tags.includes("contract")
      ? { include: true, reason: "contract specialty" }
      : { include: false, reason: "not contract" };
  }
  if (item.runner === "playwright") {
    return gate === "beta" || gate === "stable"
      ? { include: true, reason: "release browser matrix" }
      : { include: false, reason: "playwright not in this gate" };
  }
  if (item.runner === "rust-legacy") {
    return { include: false, reason: "frozen crate retained, rust-legacy not in required gates" };
  }
  if (item.tags.includes("v1-wasm")) {
    return { include: false, reason: "v1 signed-wasm role, not on this tree" };
  }
  if (item.tags.includes("agent-unconfined")) {
    return { include: false, reason: "builtin agent tools are not a process sandbox on this tree" };
  }
  if (item.tags.includes("infra-compact")) {
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
  return reasons;
}

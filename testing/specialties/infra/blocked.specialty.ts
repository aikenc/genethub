import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.infra.blocked",
    title: "Missing required artifact is blocked, not skipped",
    oracle: "status blocked",
    catches: ["silent skip"],
    tags: ["infra", "infra-compact"],
    requiredArtifacts: ["missing-on-purpose"],
    expectedDurationMs: 200,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async () => {
    throw new Error("blocked case must not run");
  },
);

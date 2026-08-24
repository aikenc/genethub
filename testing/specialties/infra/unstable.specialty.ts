import { defineSpecialty, UnstableError } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.infra.unstable",
    title: "UnstableError finalizes as unstable without failing the worker process",
    oracle: "status is unstable",
    catches: ["unstable mapped to failed"],
    tags: ["infra", "infra-compact"],
    expectedDurationMs: 200,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async () => {
    throw new UnstableError("intentional compact-run unstable");
  },
);

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.infra.slow",
    title: "Longer isolated unit for longest-first scheduling",
    oracle: "completes after a short wait without sharing home",
    catches: ["shared home", "fixed port"],
    tags: ["infra", "infra-parallel"],
    expectedDurationMs: 800,
    timeoutMs: 15_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    t.assertions.assert(t.env.home.includes("genehub-env-"), "lease is isolated");
  },
);

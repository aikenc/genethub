import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.infra.timeout",
    title: "Case timeout finalizes as interrupted",
    oracle: "status is interrupted when the worker exceeds timeoutMs",
    catches: ["timeout mapped to failed"],
    tags: ["infra", "infra-compact"],
    expectedDurationMs: 200,
    timeoutMs: 400,
    surfaces: ["testctl"],
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  },
);

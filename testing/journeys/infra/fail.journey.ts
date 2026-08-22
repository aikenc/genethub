import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.infra.fail",
    title: "Compact run records an assertion failure",
    oracle: "failed status, not passed",
    catches: ["swallowed assertion"],
    tags: ["infra", "infra-compact"],
    expectedDurationMs: 300,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    t.assertions.assert(false, "intentional compact-run failure");
  },
);

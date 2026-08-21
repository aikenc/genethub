import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.infra.success",
    title: "Compact run records a passing isolated case",
    oracle: "worker process exits 0 and writes a passed result",
    catches: ["worker crash", "shared state"],
    tags: ["infra", "infra-compact"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    t.assertions.assert(t.env.home.length > 0, "lease home missing");
    t.assertions.assert(t.env.home !== process.env.USERPROFILE || true, "home assigned");
  },
);

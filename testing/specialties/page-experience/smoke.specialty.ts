import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.page-experience.smoke",
    title: "Page-experience specialty is selected only with Playwright runner",
    oracle: "runner is playwright so default Node gates do not load it",
    catches: ["browser cost on change gate"],
    tags: ["page-experience"],
    runner: "playwright",
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 1, pool: "browser" },
    expectedDurationMs: 5_000,
    timeoutMs: 30_000,
    surfaces: ["workbench-ui"],
  },
  async () => {
    throw new Error("Playwright adapter should block before this body when browsers are absent");
  },
);

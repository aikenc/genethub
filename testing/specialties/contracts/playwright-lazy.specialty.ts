import { readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.playwright-lazy",
    title: "Default Node coordinator does not statically import Playwright",
    oracle: "testctl only dynamic-imports the Playwright adapter when a browser unit is selected",
    catches: ["static playwright import", "browser download on change gate"],
    tags: ["core", "contract"],
    expectedDurationMs: 300,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    const source = readFileSync(path.join(t.openRoot, "testing/bin/testctl.ts"), "utf8");
    t.assertions.assert(
      !/from\s+["'][^"']*adapters\/playwright\.ts["']/.test(source),
      "testctl statically imports the Playwright adapter",
    );
    t.assertions.assert(
      source.includes("adapters/playwright.ts") && source.includes("await import("),
      "testctl lost the lazy Playwright adapter import",
    );
    t.assertions.assert(!source.includes("playwright install"), "testctl downloads browsers");
  },
);

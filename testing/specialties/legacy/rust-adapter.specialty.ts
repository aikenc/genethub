import { existsSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.rust-legacy-adapter-kept",
    title: "The TypeScript rust-legacy adapter remains available for required frozen cases",
    oracle: "testing/infrastructure/adapters/rust-legacy.ts exists so required frozen cases use the TypeScript process adapter",
    catches: ["adapter deleted while crate is retained"],
    tags: ["core", "contract"],
    expectedDurationMs: 200,
    timeoutMs: 10_000,
    surfaces: ["legacy-rust"],
  },
  async (t) => {
    t.assertions.assert(
      existsSync(path.join(t.openRoot, "testing/infrastructure/adapters/rust-legacy.ts")),
      "rust-legacy adapter source missing",
    );
  },
);

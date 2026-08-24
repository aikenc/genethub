import { existsSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.rust-legacy-adapter-kept",
    title: "The TypeScript rust-legacy adapter remains as unused process code",
    oracle: "testing/infrastructure/adapters/rust-legacy.ts exists so the frozen crate can be invoked manually, but required gates do not call cargo test",
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

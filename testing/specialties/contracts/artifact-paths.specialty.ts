import { statSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, locateGenet, tryLocateWasm } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.artifact-paths-absolute",
    title: "Product artifact paths remain valid after a child changes directory",
    oracle: "the located genet executable is an absolute regular file; signed Wasm is optional on this tree",
    catches: [
      "relative Wasm works for daemon but fails in workspace-scoped Agent child",
      "relative genet path depends on testctl launch directory",
      "artifact locator accepts a directory",
    ],
    tags: ["core", "contracts", "artifact-paths"],
    llm: { default: "none" },
    expectedDurationMs: 500,
    timeoutMs: 10_000,
    resources: { environments: 1, cpu: 1, memoryMb: 128, io: 1, browser: 0, pool: "standard" },
    surfaces: ["testctl", "genet-cli", "agent"],
    productInterfaces: ["genet-cli"],
  },
  async (t) => {
    const genet = locateGenet(t.openRoot);
    t.assertions.assert(path.isAbsolute(genet), `genet path is relative: ${genet}`);
    t.assertions.assert(statSync(genet).isFile(), `genet artifact is not a file: ${genet}`);
    const wasm = tryLocateWasm(t.openRoot);
    if (wasm) {
      t.assertions.assert(path.isAbsolute(wasm), `Wasm path is relative: ${wasm}`);
      t.assertions.assert(statSync(wasm).isFile(), `Wasm artifact is not a file: ${wasm}`);
    }
  },
);

import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.client-node",
    title: "Canonical Client is imported from @genehub/workbench/client",
    oracle: "package export and Client constructor exist without loading App",
    catches: ["private src import", "UI entry side effects"],
    tags: ["core", "contract"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const pkgPath = path.join(t.openRoot, "packages/workbench/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, string> };
    t.assertions.assert(pkg.exports?.["./client"] === "./src/client.ts", "missing ./client export");
    t.assertions.assert(typeof Client === "function", "Client is not exported");
    const source = readFileSync(path.join(t.openRoot, "packages/workbench/src/client.ts"), "utf8");
    t.assertions.assert(!source.includes("./App"), "client entry loads UI");
  },
);

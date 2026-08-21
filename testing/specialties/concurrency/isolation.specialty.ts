import { writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.concurrency.isolation",
    title: "One case cannot see another case writable paths",
    oracle: "lease home, data, and workspace are unique and marker files stay inside the lease",
    catches: ["shared home", "global GENEHUB_DATA_DIR", "process leak from prior case"],
    tags: ["core", "concurrency"],
    expectedDurationMs: 800,
    timeoutMs: 15_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    t.assertions.assert(t.env.root.length > 0, "lease missing");
    t.assertions.assert(t.env.home.startsWith(t.env.root), "home escaped the lease");
    t.assertions.assert(t.env.data.startsWith(t.env.root), "data escaped the lease");
    t.assertions.assert(t.env.workspace.startsWith(t.env.root), "workspace escaped the lease");
    t.assertions.assert(process.env.HOME === t.env.home, "HOME is not the lease home");
    t.assertions.assert(
      process.env.GENEHUB_DEV_DATA_DIR === t.env.data,
      "daemon data dir is not the lease data",
    );
    const marker = path.join(t.env.home, "isolation-marker");
    writeFileSync(marker, t.env.id);
    t.assertions.assert(
      t.flows.branches.leftoverProcesses(t.env) === 0,
      "found leftover processes for this lease",
    );
  },
);

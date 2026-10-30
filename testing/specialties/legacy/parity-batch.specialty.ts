import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.rust-crate-retained",
    title: "Frozen Rust cases are required, retired with evidence, or suspended",
    oracle: "Every rust-parity row is required, retired with traceable parity evidence, or suspended under L13; active suites remain in the frozen crate",
    catches: ["crate deleted without retiring active rows", "legacy case silently removed from required execution"],
    tags: ["core", "contract"],
    expectedDurationMs: 6000,
    timeoutMs: 30000,
    surfaces: ["legacy-rust"],
  },
  async (t) => {
    const crate = path.join(t.openRoot, "testing/deprecated/rust");
    const parity = JSON.parse(readFileSync(path.join(t.openRoot, "testing/migration/rust-parity.json"), "utf8")) as {
      cases: Array<{ oldId: string; suite: string; legacyExecution?: string; archive?: { path?: string; record?: string } }>;
    };
    const stopped = parity.cases.filter(item =>
      item.legacyExecution !== "required" && item.legacyExecution !== "suspended"
      && item.legacyExecution !== "retired" && item.legacyExecution !== "release-only");
    t.assertions.assert(stopped.length === 0, "legacy cases stopped without required/suspended/retired/release-only state");
    const crateExists = existsSync(path.join(crate, "Cargo.toml"));
    const activeSuites = new Set(
      parity.cases
        .filter(item => item.legacyExecution === "required" || (item.legacyExecution === "suspended" && !item.archive))
        .map(item => `${item.suite}.rs`),
    );
    if (crateExists) {
      for (const suite of activeSuites) {
        t.assertions.assert(existsSync(path.join(crate, "tests", suite)), `${suite} missing from frozen crate`);
      }
    } else {
      t.assertions.assert(
        parity.cases.every(item => item.legacyExecution !== "required"),
        "frozen crate is gone while required legacy rows remain",
      );
    }
    const tsx = path.join(t.openRoot, "testing/node_modules/tsx/dist/cli.mjs");
    for (const gate of ["change", "merge", "dev", "beta", "stable"]) {
      const output = execFileSync(process.execPath, [tsx, path.join(t.openRoot, "testing/bin/testctl.ts"), "plan", "--open", t.openRoot,
        "--cloud", process.env.TESTCTL_CLOUD_ROOT!, "--gate", gate], { encoding: "utf8", timeout: 10000 });
      const plan = JSON.parse(output) as { units: Array<{ id: string }>; skipped: Array<{ id: string; reason: string }> };
      const planned = new Set(plan.units.map(u => u.id));
      for (const row of parity.cases) {
        if (row.legacyExecution === "suspended") {
          t.assertions.assert(!planned.has(row.oldId + "::default"), gate + " ran suspended legacy " + row.oldId);
          t.assertions.assert(plan.skipped.some(s => s.id === row.oldId && s.reason.startsWith("L13 suspended")), gate + " hid suspended legacy " + row.oldId);
        } else if (row.legacyExecution === "retired") {
          t.assertions.assert(!planned.has(row.oldId + "::default"), gate + " ran retired legacy " + row.oldId);
          t.assertions.assert(plan.skipped.some(s => s.id === row.oldId && s.reason.startsWith("L13 retired")), gate + " did not record retired legacy " + row.oldId);
        } else if (row.legacyExecution === "release-only") {
          t.assertions.assert(!planned.has(row.oldId + "::default"), gate + " ran release-only legacy " + row.oldId);
          t.assertions.assert(plan.skipped.some(s => s.id === row.oldId && s.reason.startsWith("L13 release-only")), gate + " did not record release-only legacy " + row.oldId);
        } else {
          t.assertions.assert(planned.has(row.oldId + "::default"), gate + " omitted required legacy " + row.oldId);
        }
      }
    }
    if (crateExists) {
      const cargoToml = readFileSync(path.join(t.openRoot, "Cargo.toml"), "utf8");
      t.assertions.assert(
        cargoToml.includes('"testing/deprecated/rust"'),
        "frozen crate dropped from workspace members",
      );
      const defaultMembers = cargoToml.match(/default-members\s*=\s*\[[^\]]*\]/s)?.[0] ?? "";
      t.assertions.assert(defaultMembers.length > 0, "workspace default-members missing");
      t.assertions.assert(
        !defaultMembers.includes("testing/deprecated/rust"),
        "frozen crate is still a default cargo test member",
      );
      const ci = readFileSync(path.join(t.openRoot, ".github/workflows/ci.yml"), "utf8");
      t.assertions.assert(
        ci.includes("cargo test --workspace --exclude genehub-testing"),
        "CI still runs cargo test --workspace without excluding genehub-testing",
      );
    }
  },
);

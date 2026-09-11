import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.rust-crate-retained",
    title: "Frozen Rust cases remain required until per-case parity is established",
    oracle: "testing/deprecated/rust still has Cargo.toml and suite files; rust-parity rows remain required and are registered for testctl",
    catches: ["crate deleted", "legacy cases silently removed from required execution"],
    tags: ["core", "contract"],
    expectedDurationMs: 6000,
    timeoutMs: 30000,
    surfaces: ["legacy-rust"],
  },
  async (t) => {
    const crate = path.join(t.openRoot, "testing/deprecated/rust");
    t.assertions.assert(existsSync(path.join(crate, "Cargo.toml")), "frozen crate Cargo.toml missing");
    for (const suite of [
      "journeys.rs",
      "concurrency.rs",
      "command.rs",
      "authorization.rs",
      "claude.rs",
      "cursor.rs",
      "opencode.rs",
      "install.rs",
      "supply_chain.rs",
    ]) {
      t.assertions.assert(existsSync(path.join(crate, "tests", suite)), `${suite} missing from frozen crate`);
    }
    const parity = JSON.parse(readFileSync(path.join(t.openRoot, "testing/migration/rust-parity.json"), "utf8")) as {
      cases: Array<{ oldId: string; legacyExecution?: string }>;
    };
    const stopped = parity.cases.filter(item => item.legacyExecution !== "required");
    t.assertions.assert(stopped.length === 0, "legacy cases stopped without verified per-case retirement");
    const tsx = path.join(t.openRoot, "testing/node_modules/tsx/dist/cli.mjs");
    for (const gate of ["change", "merge", "dev", "beta", "stable"]) {
      const output = execFileSync(process.execPath, [tsx, path.join(t.openRoot, "testing/bin/testctl.ts"), "plan", "--open", t.openRoot,
        "--cloud", process.env.TESTCTL_CLOUD_ROOT!, "--gate", gate], { encoding: "utf8", timeout: 10000 });
      const planned = new Set((JSON.parse(output) as { units: Array<{ id: string }> }).units.map(u => u.id));
      for (const row of parity.cases) t.assertions.assert(planned.has(row.oldId + "::default"), gate + " omitted required legacy " + row.oldId);
    }
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
  },
);

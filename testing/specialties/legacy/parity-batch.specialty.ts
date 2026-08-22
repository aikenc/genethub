import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

defineSpecialty(
  {
    id: "specialty.contracts.rust-crate-retained",
    title: "Frozen Rust crate stays on disk and is not executed by testctl",
    oracle: "testing/deprecated/rust still has Cargo.toml and suite files; rust-parity rows are all legacyExecution stopped; cargo test --workspace excludes genehub-testing",
    catches: ["crate deleted", "rust-legacy cases re-registered without L13 evidence", "CI still runs frozen crate"],
    tags: ["core", "contract"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["legacy-rust"],
  },
  async (t) => {
    const crate = path.join(t.openRoot, "testing/deprecated/rust");
    t.assertions.assert(existsSync(path.join(crate, "Cargo.toml")), "frozen crate Cargo.toml missing");
    for (const suite of [
      "journeys.rs",
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
    const stillRequired = parity.cases.filter((item) => item.legacyExecution !== "stopped");
    t.assertions.assert(
      stillRequired.length === 0,
      `legacyExecution still required: ${stillRequired.map((item) => item.oldId).join(",")}`,
    );
    const reregistered = walkTs(path.join(t.openRoot, "testing"))
      .filter((file) => file.includes("/journeys/") || file.includes("/specialties/"))
      .filter((file) => /runner:\s*["']rust-legacy["']/.test(readFileSync(file, "utf8")));
    t.assertions.assert(
      reregistered.length === 0,
      `rust-legacy runner re-registered: ${reregistered.join(",")}`,
    );
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

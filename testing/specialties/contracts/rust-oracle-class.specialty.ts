import { readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.rust-oracle-class",
    title: "Every frozen Rust case has an oracle class and no test-only export",
    oracle: "rust-parity.json has zero pending-classification rows",
    catches: ["unclassified probe", "test-only diagnostics.snapshot export"],
    tags: ["core", "contract"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["legacy-rust"],
  },
  async (t) => {
    const parityPath = path.join(t.openRoot, "testing/migration/rust-parity.json");
    const probesPath = path.join(t.openRoot, "testing/migration/rust-probes.json");
    const parity = JSON.parse(readFileSync(parityPath, "utf8")) as {
      parityEvidence?: { tsCore?: string; rustLegacy?: string; openSha?: string; artifact?: string };
      cases: Array<{
        oldId: string;
        oracleClass: string;
        status: string;
        assertionDelta?: string;
        tsId?: string | null;
        legacyExecution?: string;
      }>;
    };
    const probes = JSON.parse(readFileSync(probesPath, "utf8")) as {
      probes: Array<{ name: string; disposition: string }>;
    };
    const pending = parity.cases.filter((item) => item.oracleClass === "pending-classification");
    t.assertions.assert(pending.length === 0, `unclassified: ${pending.map((item) => item.oldId).join(",")}`);
    t.assertions.assert(
      parity.cases.every((item) =>
        ["public-behavior", "os-fact", "production-support", "native-intrinsic"].includes(item.oracleClass),
      ),
      "oracleClass outside the four allowed buckets",
    );
    t.assertions.assert(
      probes.probes.some((item) => item.name === "diagnostics.snapshot" && item.disposition === "use-as-is"),
      "diagnostics.snapshot gap is not registered",
    );
    t.assertions.assert(
      !probes.probes.some((item) => item.disposition === "export-for-tests"),
      "test-only probe export is registered",
    );
    const missingDelta = parity.cases.filter((item) => !item.assertionDelta?.trim());
    t.assertions.assert(
      missingDelta.length === 0,
      `assertionDelta missing: ${missingDelta.map((item) => item.oldId).join(",")}`,
    );
    const allowedStatus = new Set(["ts-owned", "source-retained"]);
    t.assertions.assert(
      parity.cases.every((item) => allowedStatus.has(item.status)),
      `unexpected status: ${parity.cases.filter((item) => !allowedStatus.has(item.status)).map((item) => `${item.oldId}:${item.status}`).join(",")}`,
    );
    const owned = parity.cases.filter((item) => item.status === "ts-owned");
    t.assertions.assert(
      owned.every((item) => Boolean(item.tsId)),
      "ts-owned row without tsId",
    );
    t.assertions.assert(
      parity.cases.every((item) => item.legacyExecution === "stopped"),
      "rust-legacy execution is still required for some rows",
    );
    t.assertions.assert(
      Boolean(parity.parityEvidence?.tsCore && parity.parityEvidence.rustLegacy && parity.parityEvidence.openSha && parity.parityEvidence.artifact),
      "top-level parityEvidence is incomplete",
    );
  },
);

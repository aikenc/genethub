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
        suspension?: { approvedBy?: string; approvedAt?: string; reason?: string; resumeWhen?: string };
        retirement?: {
          type?: string; tsId?: string; tsRunId?: string; rustRunId?: string;
          openSha?: string; cloudSha?: string; artifactSha?: string;
          tsInputs?: unknown; rustInputs?: unknown; reviewedIn?: string;
          deletedDependency?: string; reason?: string;
        };
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
    const suspended = parity.cases.filter((item) => item.legacyExecution === "suspended");
    t.assertions.assert(
      parity.cases.every((item) => item.legacyExecution === "required" || item.legacyExecution === "suspended" || item.legacyExecution === "retired"),
      "frozen legacy execution must remain required pending verified parity, be retired with evidence, or be suspended under L13",
    );
    t.assertions.assert(
      suspended.every((item) => item.status === "source-retained" && !item.tsId
        && Boolean(item.suspension?.approvedBy?.trim() && item.suspension.approvedAt?.trim()
          && item.suspension.reason?.trim() && item.suspension.resumeWhen?.trim())),
      `suspended row without retained source or a complete suspension record: ${suspended.filter((item) => item.status !== "source-retained" || !item.suspension?.resumeWhen).map((item) => item.oldId).join(",")}`,
    );
    const retired = parity.cases.filter((item) => item.legacyExecution === "retired");
    t.assertions.assert(
      retired.every((item) => {
        const r = item.retirement;
        if (!r?.type?.trim() || !r.openSha?.trim() || !r.cloudSha?.trim()
          || !r.artifactSha?.trim() || !r.reviewedIn?.trim()) return false;
        if (r.type === "delete-with-harness") {
          return Boolean(r.deletedDependency?.trim() && r.reason?.trim());
        }
        return item.status === "ts-owned" && Boolean(item.tsId)
          && r.tsId === item.tsId && Boolean(r.tsRunId?.trim() && r.rustRunId?.trim())
          && r.tsInputs !== undefined && r.rustInputs !== undefined;
      }),
      `retired row without traceable parity evidence: ${retired.filter((item) => {
        const r = item.retirement;
        return !r?.type?.trim() || !r.openSha?.trim() || !r.cloudSha?.trim()
          || !r.artifactSha?.trim() || !r.reviewedIn?.trim();
      }).map((item) => item.oldId).join(",")}`,
    );
    t.assertions.assert(
      parity.cases.every((item) => !(item.legacyExecution === "retired" && item.suspension)),
      "retired row still carries a suspension record",
    );
    t.assertions.assert(
      Boolean(parity.parityEvidence?.tsCore && parity.parityEvidence.rustLegacy && parity.parityEvidence.openSha && parity.parityEvidence.artifact),
      "top-level parityEvidence is incomplete",
    );
  },
);

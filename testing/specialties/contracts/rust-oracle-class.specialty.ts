import { execFileSync } from "node:child_process";
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

defineSpecialty(
  {
    id: "specialty.contracts.no-new-source-rust-tests",
    title: "Product changes do not recreate a source-near Rust test layer",
    oracle:
      "the complete candidate diff from its main merge-base contains no new Rust test marker or added assertion inside an existing source-near #[cfg(test)] region; business and contract behavior stays owned by TypeScript testctl cases",
    catches: [
      "a product implementation adds a convenient Rust business test instead of a TypeScript production-boundary oracle",
      "a new source-local Rust harness silently recreates the retired default Rust test layer",
    ],
    tags: ["core", "contract", "parity"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["source-governance"],
  },
  async (t) => {
    const base = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: t.openRoot,
      encoding: "utf8",
    }).trim();
    const trackedRust = execFileSync("git", ["diff", "--name-only", base, "--", "*.rs"], {
      cwd: t.openRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const trackedAdditions = trackedRust.flatMap((relative) => {
      const source = readFileSync(path.join(t.openRoot, relative), "utf8").split("\n");
      const testRegions = rustTestRegions(source);
      const patch = execFileSync("git", ["diff", "--unified=0", base, "--", relative], {
        cwd: t.openRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      let newLine = 0;
      const violations: string[] = [];
      for (const line of patch.split("\n")) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
          newLine = Number(hunk[1]);
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const body = line.slice(1);
          if (
            /^\s*#\[(?:(?:tokio::)?test|cfg\(test\))\]/.test(body) ||
            (testRegions.some(([start, end]) => newLine >= start && newLine <= end) &&
              /^\s*(?:debug_)?assert(?:_eq|_ne|_matches)?!/.test(body))
          ) {
            violations.push(`${relative}:${newLine}:${body.trim()}`);
          }
          newLine += 1;
        } else if (line.startsWith(" ")) {
          newLine += 1;
        }
      }
      return violations;
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: t.openRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((relative) => relative.endsWith(".rs"));
    const untrackedAdditions = untracked.flatMap((relative) =>
      readFileSync(path.join(t.openRoot, relative), "utf8")
        .split("\n")
        .filter((line) => /^\s*#\[(?:(?:tokio::)?test|cfg\(test\))\]/.test(line))
        .map((line) => `${relative}:${line.trim()}`),
    );
    const additions = [...trackedAdditions, ...untrackedAdditions];
    t.assertions.assert(
      additions.length === 0,
      `candidate adds source-near Rust tests: ${additions.join(" | ")}`,
    );
  },
);

function rustTestRegions(source: string[]): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!/^\s*#\[cfg\(test\)\]/.test(source[index] ?? "")) continue;
    const start = index + 1;
    let opened = false;
    let end = start;
    for (let item = index + 1; item < source.length; item += 1) {
      const line = source[item] ?? "";
      end = item + 1;
      if (!opened) {
        if (line.includes("{")) {
          opened = true;
          if (line.trim() === "{}") break;
        } else if (line.trimEnd().endsWith(";")) {
          break;
        }
      } else if (line === "}") {
        break;
      }
    }
    regions.push([start, end]);
  }
  return regions;
}

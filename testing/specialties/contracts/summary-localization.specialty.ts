import { defineSpecialty, parseSummaryLanguage, renderRunSummary, type RunManifest, type UnitResult } from "../../framework/public.ts";

const manifest: RunManifest = {
  schema: "genehub.test-run.v1",
  runId: "localization-proof",
  topic: "summary",
  gate: "change",
  status: "failed",
  startedAt: "2026-08-20T00:00:00.000Z",
  endedAt: "2026-08-20T00:00:01.000Z",
  localTime: "fixed",
  rfc3339: "2026-08-20T00:00:00.000Z",
  utc: "2026-08-20T00:00:00.000Z",
  trigger: "testctl",
  runnerVersion: "testctl.v1",
  open: { path: "/open", sha: "open-sha", branch: "dev", dirty: true, dirtyDigest: "dirty" },
  cloud: { path: "/cloud", sha: "cloud-sha", branch: "dev", dirty: false, dirtyDigest: "clean" },
  artifact: { path: "/artifact", hash: "artifact-hash", kind: "genet-local" },
  catalogDigest: "catalog",
  selected: ["case.failed"],
  notExecuted: [],
  counts: { passed: 0, failed: 1, blocked: 0, unstable: 0, interrupted: 0, "not-applicable": 0, total: 1 },
  qualification: { gate: "change", policyVersion: "gates.v1", qualified: false, reasons: ["failed cases present"] },
  environments: 1,
  resultsPath: "/run/results.ndjson",
  leak: { processes: 0, ports: 0 },
};

const failure: UnitResult = {
  id: "case.failed",
  caseId: "case.failed",
  variant: "default",
  status: "failed",
  startedAt: manifest.startedAt,
  endedAt: manifest.endedAt,
  durationMs: 1000,
  message: "evidence remains visible",
};

defineSpecialty(
  {
    id: "specialty.contracts.summary-localization",
    title: "Run summaries localize human labels without changing evidence",
    oracle: "explicit zh-CN renders Chinese labels while default English and failure identifiers remain stable",
    catches: ["locale changes qualification", "translation hides failures", "default output breaks consumers"],
    tags: ["core", "contract"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    const english = renderRunSummary({ manifest, failed: [failure], slowest: [failure], runDir: "/run" });
    const chinese = renderRunSummary({ manifest, failed: [failure], slowest: [failure], runDir: "/run", language: parseSummaryLanguage("zh-CN") });
    t.assertions.assert(english.startsWith("# FAILED · change") && english.includes("- problems:"), "default English summary changed");
    t.assertions.assert(chinese.startsWith("# 失败 · 变更门禁") && chinese.includes("- 发现问题："), "Chinese labels missing");
    for (const evidence of ["case.failed", "evidence remains visible", "artifact-hash", "testctl inspect --run /run"]) {
      t.assertions.assert(english.includes(evidence) && chinese.includes(evidence), `localized summary lost ${evidence}`);
    }
    let rejected = false;
    try { parseSummaryLanguage("automatic"); } catch { rejected = true; }
    t.assertions.assert(rejected, "unknown summary language was silently accepted");
  },
);

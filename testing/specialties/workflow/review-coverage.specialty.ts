import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.review-coverage",
  title: "Reviewer report coverage preserves acceptance and discloses unverified evidence",
  oracle: "The shipped report command rejects omissions, duplicates and stale artifact/acceptance identities, delivers negative reports, and never attests execution from declared references",
  catches: ["missing checklist items pass", "repair changes acceptance silently", "format validation claims actual verification", "negative reports cannot be completed"],
  tags: ["core", "workflow", "workflow-trials"], llm: { default: "none" },
  expectedDurationMs: 2000, timeoutMs: 15000,
  resources: { environments: 1, cpu: 1, memoryMb: 128, io: 1, browser: 0, pool: "standard" },
  surfaces: ["bootstrap-pack", "filesystem"], productInterfaces: ["game-reviewer/scripts/check-review.mjs"],
}, async t => {
  const script = path.join(t.openRoot, "apps/daemon/bootstrap-packs/game-delivery-v1/spaces/reviewer/skills/game-reviewer/scripts/check-review.mjs");
  const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const contractFile = path.join(t.env.workspace, "contract.json"), reportFile = path.join(t.env.workspace, "report.json");
  const previousFile = path.join(t.env.workspace, "previous.json");
  const original = { schema: "genehub.review-contract.v1", requirementRevision: "user-1", checklistVersion: "acceptance-1", artifactRevision: "commit-a",
    items: [{ id: "start", criterion: "Start enters play" }, { id: "save", criterion: "Previous saves survive" }] };
  writeFileSync(previousFile, JSON.stringify(original));
  for (const scenario of ["approved", "unverifiable", "missing", "duplicate", "unknown", "status", "no-evidence", "no-reason", "artifact", "contract-digest", "changed-acceptance", "repaired-artifact"] as const) {
    const contract = structuredClone(original);
    if (scenario === "changed-acceptance") contract.items[1]!.criterion = "Old saves may be discarded";
    if (scenario === "repaired-artifact") contract.artifactRevision = "commit-b";
    writeFileSync(contractFile, JSON.stringify(contract));
    const report = { schema: "genehub.review-report.v1", requirementRevision: contract.requirementRevision, checklistVersion: contract.checklistVersion,
      artifactRevision: scenario === "artifact" ? "stale-commit" : contract.artifactRevision,
      contractDigest: scenario === "contract-digest" ? "sha256:stale" : digest(readFileSync(contractFile)),
      items: contract.items.map((item) => ({ id: item.id, status: "met", reason: "", evidence: [{ ref: `checks/${item.id}.json`, observation: "The pinned artifact satisfied the criterion" }] })),
    };
    if (scenario === "unverifiable") Object.assign(report.items[0]!, { status: "unverifiable", reason: "No browser observer is available", evidence: [] });
    if (scenario === "missing") report.items.pop();
    if (scenario === "duplicate") report.items.push(structuredClone(report.items[0]!));
    if (scenario === "unknown") report.items[0]!.id = "undeclared";
    if (scenario === "status") report.items[0]!.status = "looks-good";
    if (scenario === "no-evidence") report.items[0]!.evidence = [];
    if (scenario === "no-reason") report.items[0]!.status = "notApplicable";
    writeFileSync(reportFile, JSON.stringify(report));
    const result = spawnSync(process.execPath, [script, contractFile, reportFile, previousFile], { cwd: t.env.workspace, encoding: "utf8", timeout: 5000 });
    const checked = JSON.parse(result.stdout) as { valid: boolean; verdict: string; errors: string[]; evidenceExecutionVerified: boolean };
    const valid = ["approved", "unverifiable", "repaired-artifact"].includes(scenario);
    t.assertions.assert((result.status === 0) === valid && checked.valid === valid, `${scenario}: ${result.stderr || result.stdout}`);
    t.assertions.assert(checked.verdict === (valid ? scenario === "unverifiable" ? "changesRequested" : "approved" : "invalid"), `wrong report verdict for ${scenario}`);
    t.assertions.assert(checked.evidenceExecutionVerified === false, "declared references were treated as proof of executed checks");
    if (!valid) t.assertions.assert(checked.errors.length > 0, "invalid report has no actionable reason");
  }
});

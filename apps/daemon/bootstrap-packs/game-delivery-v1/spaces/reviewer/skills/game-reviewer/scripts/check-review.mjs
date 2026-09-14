// Validates report coverage and declared versions. It does not attest that a
// referenced check was executed; the reviewer and WR must inspect that evidence.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [contractPath, reportPath, previousContractPath] = process.argv.slice(2);
if (!contractPath || !reportPath || process.argv.length > 5) {
  throw new Error("Usage: node check-review.mjs <contract.json> <report.json> [previous-contract.json]");
}
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const bytes = readFileSync(contractPath);
const contract = JSON.parse(bytes);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const errors = [];
const text = (value) => typeof value === "string" && value.trim().length > 0;
const acceptanceDigest = (value) => digest(JSON.stringify({
  requirementRevision: value.requirementRevision, checklistVersion: value.checklistVersion, items: value.items,
}));
if (contract.schema !== "genehub.review-contract.v1" || report.schema !== "genehub.review-report.v1") errors.push("unsupported contract/report schema");
for (const key of ["requirementRevision", "checklistVersion", "artifactRevision"]) {
  if (!text(contract[key]) || report[key] !== contract[key]) errors.push(`missing or mismatched ${key}`);
}
if (report.contractDigest !== digest(bytes)) errors.push("contractDigest mismatch");
if (previousContractPath) {
  const previous = JSON.parse(readFileSync(previousContractPath, "utf8"));
  if (acceptanceDigest(previous) !== acceptanceDigest(contract)) errors.push("acceptance changed between review and re-review");
}
const expected = new Set();
if (!Array.isArray(contract.items) || !contract.items.length) errors.push("contract needs a finite nonempty checklist");
for (const item of Array.isArray(contract.items) ? contract.items : []) {
  if (!text(item.id) || !text(item.criterion) || expected.has(item.id)) errors.push(`invalid or duplicate contract item: ${item.id}`);
  expected.add(item.id);
}
const covered = new Set();
const statuses = new Set(["met", "partial", "unmet", "unverifiable", "notApplicable"]);
let approved = true;
if (!Array.isArray(report.items)) errors.push("report.items must be an array");
for (const item of Array.isArray(report.items) ? report.items : []) {
  if (!expected.has(item.id) || covered.has(item.id)) errors.push(`unknown or duplicate report item: ${item.id}`);
  covered.add(item.id);
  if (!statuses.has(item.status)) errors.push(`invalid status for ${item.id}`);
  const evidence = Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.every((entry) => text(entry.ref) && text(entry.observation));
  if (item.status === "met" && !evidence) errors.push(`met item lacks evidence: ${item.id}`);
  if (item.status !== "met" && !text(item.reason)) errors.push(`non-met item lacks reason: ${item.id}`);
  if (!["met", "notApplicable"].includes(item.status)) approved = false;
}
for (const id of expected) if (!covered.has(id)) errors.push(`missing checklist item: ${id}`);
const result = {
  schema: "genehub.review-coverage.v1", valid: errors.length === 0,
  verdict: errors.length ? "invalid" : approved ? "approved" : "changesRequested",
  contractDigest: digest(bytes), reportDigest: digest(readFileSync(reportPath)),
  acceptanceDigest: acceptanceDigest(contract), artifactRevision: contract.artifactRevision,
  checkedItems: covered.size, errors, evidenceExecutionVerified: false,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length) process.exitCode = 1;

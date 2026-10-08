import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { lintLayers } from "./layers.ts";

export interface GovernanceReport {
  digest: string;
  findings: Array<{ rule: string; file: string; message: string }>;
  mechanical: Array<{ id: string; result: "ok" | "fail" | "n/a"; note: string }>;
}

export function governanceDigest(cloudRoot: string | undefined): string {
  const files = [
    cloudRoot ? path.join(cloudRoot, "docs", "testing", "engineering-principles.md") : "",
    cloudRoot ? path.join(cloudRoot, "docs", "testing", "engineering-laws.md") : "",
  ].filter((file) => file && existsSync(file));
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return files.length !== 2 ? "missing-governance-docs" : hash.digest("hex");
}

export function checkGovernance(openRoot: string, cloudRoot?: string): GovernanceReport {
  const findings: GovernanceReport["findings"] = lintLayers(openRoot, cloudRoot).map((item) => ({
    rule: item.rule,
    file: item.file,
    message: item.message,
  }));
  const parityPath = path.join(openRoot, "testing", "migration", "rust-parity.json");
  let pending = 0;
  if (existsSync(parityPath)) {
    const parity = JSON.parse(readFileSync(parityPath, "utf8")) as {
      cases?: Array<{
        oracleClass?: string; oldId?: string; legacyExecution?: string;
        suspension?: { approvedBy?: string; approvedAt?: string; reason?: string; resumeWhen?: string };
      }>;
    };
    const recorded = (value?: string) => Boolean(value?.trim());
    const suspended = (item: NonNullable<typeof parity.cases>[number]) => item.legacyExecution === "suspended"
      && recorded(item.suspension?.approvedBy) && /^\d{4}-\d{2}-\d{2}$/.test(item.suspension?.approvedAt ?? "")
      && recorded(item.suspension?.reason) && recorded(item.suspension?.resumeWhen);
    const stopped = (parity.cases ?? []).filter(item => item.legacyExecution !== "required" && !suspended(item));
    if (stopped.length) findings.push({ rule: "L13", file: parityPath, message: stopped.length + " legacy rows are neither required nor suspended with approver, date, reason and resume condition" });
    const stray = (parity.cases ?? []).filter(item => item.legacyExecution === "required" && item.suspension);
    if (stray.length) findings.push({ rule: "L13", file: parityPath, message: stray.length + " required legacy rows still carry a suspension record" });
    pending = (parity.cases ?? []).filter((item) => item.oracleClass === "pending-classification").length;
    if (pending > 0) {
      findings.push({
        rule: "oracle-class",
        file: parityPath,
        message: `${pending} rust-parity cases still pending-classification`,
      });
    }
  }
  return {
    digest: governanceDigest(cloudRoot),
    findings,
    mechanical: [
      { id: "L03", result: findings.some((item) => item.rule === "L03") ? "fail" : "ok", note: "business import boundaries" },
      { id: "L04", result: findings.some((item) => item.rule === "L04") ? "fail" : "ok", note: "layer direction" },
      { id: "L16", result: findings.some((item) => item.rule === "L16") ? "fail" : "ok", note: "no private product source imports" },
      { id: "P06", result: findings.some((item) => item.rule === "L03" || item.rule === "L04") ? "fail" : "ok", note: "three-layer dependency" },
      { id: "L13", result: findings.some(item => item.rule === "L13") ? "fail" : "ok", note: "legacy required metadata; parity retirement is not automatically certified" },
      { id: "P01", result: pending > 0 ? "fail" : "ok", note: "legacy rust oracle classification" },
    ],
  };
}

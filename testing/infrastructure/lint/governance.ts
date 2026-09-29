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
  return {
    digest: governanceDigest(cloudRoot),
    findings,
    mechanical: [
      { id: "L03", result: findings.some((item) => item.rule === "L03") ? "fail" : "ok", note: "business import boundaries" },
      { id: "L04", result: findings.some((item) => item.rule === "L04") ? "fail" : "ok", note: "layer direction" },
      { id: "L16", result: findings.some((item) => item.rule === "L16") ? "fail" : "ok", note: "no private product source imports" },
      { id: "P06", result: findings.some((item) => item.rule === "L03" || item.rule === "L04") ? "fail" : "ok", note: "three-layer dependency" },
    ],
  };
}

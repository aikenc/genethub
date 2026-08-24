import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { walkCaseFiles } from "../engine/catalog.ts";

const IMPORT = /from\s+["']([^"']+)["']/g;

export interface LintFinding {
  file: string;
  rule: "L03" | "L04" | "L16";
  message: string;
}

function layerOf(file: string, openRoot: string): "infrastructure" | "framework" | "business" | "other" {
  const rel = path.relative(path.join(openRoot, "testing"), file).replaceAll("\\", "/");
  if (rel.startsWith("infrastructure/")) return "infrastructure";
  if (rel.startsWith("framework/")) return "framework";
  if (rel.startsWith("journeys/") || rel.startsWith("specialties/") || rel.startsWith("e2e/")) {
    return "business";
  }
  return "other";
}

function businessKind(file: string): "journeys" | "specialties" | "e2e" | null {
  const name = file.replaceAll("\\", "/");
  if (name.includes("/journeys/")) return "journeys";
  if (name.includes("/specialties/")) return "specialties";
  if (name.includes("/e2e/")) return "e2e";
  return null;
}

export function lintLayers(openRoot: string, extraRoot?: string): LintFinding[] {
  const files = [
    ...walkSource(path.join(openRoot, "testing")),
    ...(extraRoot ? walkSource(path.join(extraRoot, "testing")) : []),
  ];
  const caseFiles = new Set([
    ...walkCaseFiles(openRoot),
    ...(extraRoot ? walkCaseFiles(extraRoot) : []),
  ]);
  const findings: LintFinding[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const layer = layerOf(file, openRoot);
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? "";
      if (layer === "infrastructure" && (spec.includes("/framework/") || spec.includes("journeys/") || spec.includes("specialties/") || spec.includes("/e2e/"))) {
        findings.push({ file, rule: "L04", message: `infrastructure imports ${spec}` });
      }
      if (layer === "framework" && spec.includes("/infrastructure/") && !spec.endsWith("/public.ts")) {
        findings.push({ file, rule: "L04", message: `framework imports infrastructure internal ${spec}` });
      }
      if (layer === "business" && spec.includes("/infrastructure/")) {
        findings.push({ file, rule: "L04", message: `business imports infrastructure ${spec}` });
      }
      const fromKind = businessKind(file);
      const toKind = businessKind(spec);
      if (fromKind && toKind && fromKind !== toKind) {
        findings.push({ file, rule: "L03", message: `${fromKind} imports ${toKind}` });
      }
      if (caseFiles.has(path.resolve(path.dirname(file), spec)) && !file.includes("/engine/") && !file.includes("/adapters/") && !file.endsWith("framework/worker.ts")) {
        findings.push({ file, rule: "L03", message: `imports registered case ${spec}` });
      }
      if (layer === "business" && spec.includes("packages/workbench/src/") && !spec.includes("@genehub/workbench/client")) {
        findings.push({ file, rule: "L16", message: `business case imports private product source ${spec}` });
      }
    }
  }
  return findings;
}

function walkSource(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, String(entry.name));
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "deprecated") continue;
        visit(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  visit(root);
  return out;
}

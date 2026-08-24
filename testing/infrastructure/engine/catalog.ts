import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CaseMeta } from "../types.ts";
import { assignFile, listRegisteredCases, resetRegistry } from "./registry.ts";

const CASE_SUFFIX = [".journey.ts", ".specialty.ts", ".e2e.ts"];

export interface CatalogRoots {
  openRoot: string;
  cloudRoot?: string;
}

export function caseKindFromPath(file: string): "journey" | "specialty" | "e2e" | null {
  if (file.endsWith(".journey.ts")) return "journey";
  if (file.endsWith(".specialty.ts")) return "specialty";
  if (file.endsWith(".e2e.ts")) return "e2e";
  return null;
}

export function walkCaseFiles(root: string): string[] {
  const files: string[] = [];
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
        if (entry.name === "deprecated" || entry.name === "node_modules" || entry.name === "infrastructure") {
          continue;
        }
        visit(full);
        continue;
      }
      if (CASE_SUFFIX.some((suffix) => entry.name.endsWith(suffix))) files.push(full);
    }
  };
  visit(path.join(root, "testing"));
  return files.sort();
}

export async function loadCatalog(roots: CatalogRoots): Promise<CaseMeta[]> {
  resetRegistry();
  const files = [
    ...walkCaseFiles(roots.openRoot),
    ...(roots.cloudRoot ? walkCaseFiles(roots.cloudRoot) : []),
  ];
  for (const file of files) {
    const before = new Set(listRegisteredCases().map((item) => item.id));
    await import(pathToFileURL(file).href);
    const added = new Set(
      listRegisteredCases().filter((item) => !before.has(item.id)).map((item) => item.id),
    );
    assignFile(added, file);
  }
  return listRegisteredCases().map(({ run: _run, ...meta }) => meta);
}

export function catalogDigest(cases: CaseMeta[]): string {
  const payload = cases.map((item) => ({ id: item.id, file: item.file, runner: item.runner }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

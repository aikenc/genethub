import { existsSync, readdirSync } from "node:fs";

export function visibleEntries(runDir: string): string[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((name) => !name.startsWith("."));
}

export function defaultVisibleOk(runDir: string, hasFailures: boolean, hasArtifacts: boolean): boolean {
  const names = new Set(visibleEntries(runDir));
  const required = ["summary.md", "manifest.json", "results.ndjson"];
  if (!required.every((name) => names.has(name))) return false;
  if (!hasFailures && names.has("failures")) return false;
  if (!hasArtifacts && names.has("artifacts")) return false;
  return true;
}

export function runDirName(topic: string, runId: string): string {
  const slug = topic.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 32);
  const now = new Date();
  const stamp = [
    String(now.getFullYear()).slice(2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  return `${stamp}-${slug}-${runId.slice(0, 4)}`;
}

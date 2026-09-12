import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { RunManifest, RunProgress, UnitResult } from "../types.ts";
import { redactText } from "./redact.ts";
import { runDirName } from "./validate.ts";

export interface RunStore {
  dir: string;
  writeProgress(progress: RunProgress): void;
  writeResult(result: UnitResult): void;
  writeFailure(result: UnitResult, diagnostic: string): void;
  writeReport(result: UnitResult): void;
  finalize(manifest: RunManifest, summary: string): void;
}

export function createRunStore(spaceRoot: string, topic: string): RunStore {
  const runId = randomUUID().replace(/-/g, "");
  const dir = path.join(spaceRoot, "runs", runDirName(topic, runId));
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, ".internal"), { recursive: true });
  writeFileSync(path.join(dir, "results.ndjson"), "");
  return {
    dir,
    writeProgress(progress) {
      const file = path.join(dir, "progress.json");
      writeFileSync(`${file}.tmp`, `${JSON.stringify(progress, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    },
    writeResult(result) {
      const { diagnostic: _diagnostic, ...publicResult } = result;
      if (publicResult.message) publicResult.message = redactText(publicResult.message);
      if (publicResult.blockedReason) publicResult.blockedReason = redactText(publicResult.blockedReason);
      appendFileSync(path.join(dir, "results.ndjson"), `${JSON.stringify(publicResult)}\n`);
    },
    writeFailure(result, diagnostic) {
      const folder = path.join(dir, "failures", result.caseId.replace(/[^\w.-]+/g, "_"));
      mkdirSync(path.join(folder, "logs"), { recursive: true });
      writeFileSync(path.join(folder, "diagnostic.md"), redactText(diagnostic));
    },
    writeReport(result) {
      const folder = path.join(dir, "reports");
      mkdirSync(folder, { recursive: true });
      const name = `${result.caseId.replace(/[^\w.-]+/g, "_")}.md`;
      writeFileSync(path.join(folder, name), redactText(result.message ?? ""));
    },
    finalize(manifest, summary) {
      writeFileSync(path.join(dir, "summary.md"), redactText(summary));
      const file = path.join(dir, "manifest.json");
      writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      if (manifest.status === "passed") {
        rmSync(path.join(dir, ".internal"), { recursive: true, force: true });
      }
    },
  };
}

/** Ignore only an unfinished final append while a coordinator is writing. */
export function readRunResults(dir: string): UnitResult[] {
  const raw = readFileSync(path.join(dir, "results.ndjson"), "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n") && !existsSync(path.join(dir, "manifest.json"))) lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line) as UnitResult);
}

export function ensureRunsIgnored(spaceRoot: string): void {
  if (!existsSync(path.join(spaceRoot, ".git")) && !existsSync(path.join(spaceRoot, "..", "..", ".git"))) {
    // Space may be nested; check-ignore still works from git root via cwd.
  }
}

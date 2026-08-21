import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { RunManifest, UnitResult } from "../types.ts";
import { redactText } from "./redact.ts";
import { runDirName } from "./validate.ts";

export interface RunStore {
  dir: string;
  writeResult(result: UnitResult): void;
  writeFailure(result: UnitResult, diagnostic: string): void;
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
    writeResult(result) {
      const { diagnostic: _diagnostic, ...publicResult } = result;
      appendFileSync(path.join(dir, "results.ndjson"), `${JSON.stringify(publicResult)}\n`);
    },
    writeFailure(result, diagnostic) {
      const folder = path.join(dir, "failures", result.caseId.replace(/[^\w.-]+/g, "_"));
      mkdirSync(path.join(folder, "logs"), { recursive: true });
      writeFileSync(path.join(folder, "diagnostic.md"), redactText(diagnostic));
    },
    finalize(manifest, summary) {
      writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(path.join(dir, "summary.md"), summary);
      if (manifest.status === "passed") {
        rmSync(path.join(dir, ".internal"), { recursive: true, force: true });
      }
    },
  };
}

export function ensureRunsIgnored(spaceRoot: string): void {
  if (!existsSync(path.join(spaceRoot, ".git")) && !existsSync(path.join(spaceRoot, "..", "..", ".git"))) {
    // Space may be nested; check-ignore still works from git root via cwd.
  }
}

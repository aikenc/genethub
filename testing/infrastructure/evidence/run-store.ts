import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { RunManifest, UnitResult } from "../types.ts";
import { redactText } from "./redact.ts";
import { runDirName } from "./validate.ts";

export interface RunStore {
  dir: string;
  writeResult(result: UnitResult): void;
  writeFailure(result: UnitResult, diagnostic: string): void;
  writeReport(result: UnitResult): void;
  writeRetentionArtifacts(result: UnitResult): void;
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
      const {
        diagnostic: _diagnostic,
        failureArtifacts: _failureArtifacts,
        retentionArtifacts: _retentionArtifacts,
        ...publicResult
      } = result;
      appendFileSync(path.join(dir, "results.ndjson"), `${JSON.stringify(publicResult)}\n`);
    },
    writeFailure(result, diagnostic) {
      const folder = path.join(dir, "failures", result.caseId.replace(/[^\w.-]+/g, "_"));
      mkdirSync(path.join(folder, "logs"), { recursive: true });
      writeFileSync(path.join(folder, "diagnostic.md"), redactText(diagnostic));
      if (result.failureArtifacts) {
        const staging = path.resolve(result.failureArtifacts);
        const internal = path.resolve(dir, ".internal");
        if (staging !== internal && staging.startsWith(`${internal}${path.sep}`) && existsSync(staging)) {
          const unit = result.id.replace(/[^\w.-]+/g, "_");
          const destination = path.join(folder, "evidence", unit);
          rmSync(destination, { recursive: true, force: true });
          mkdirSync(path.dirname(destination), { recursive: true });
          cpSync(staging, destination, { recursive: true, force: true });
          rmSync(staging, { recursive: true, force: true });
        } else {
          appendFileSync(
            path.join(folder, "diagnostic.md"),
            "\n\n## artifact collection\n\nThe failure bundle staging path was outside this run and was rejected.\n",
          );
        }
      }
    },
    writeReport(result) {
      const folder = path.join(dir, "reports");
      mkdirSync(folder, { recursive: true });
      const name = `${result.caseId.replace(/[^\w.-]+/g, "_")}.md`;
      writeFileSync(path.join(folder, name), redactText(result.message ?? ""));
    },
    writeRetentionArtifacts(result) {
      if (!result.retentionArtifacts) return;
      const staging = path.resolve(result.retentionArtifacts);
      const internal = path.resolve(dir, ".internal");
      if (staging === internal || !staging.startsWith(`${internal}${path.sep}`) || !existsSync(staging)) {
        throw new Error("retained evidence staging path was outside this run");
      }
      const caseFolder = path.join(
        dir,
        "reports",
        result.caseId.replace(/[^\w.-]+/g, "_"),
        "evidence",
      );
      const unit = result.id.replace(/[^\w.-]+/g, "_");
      const destination = path.join(caseFolder, unit);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(staging, destination, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    },
    finalize(manifest, summary) {
      writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(path.join(dir, "summary.md"), summary);
      // Retained bundles have already moved to failures/. Internal staging is
      // never a public evidence surface and must not leave duplicate material.
      rmSync(path.join(dir, ".internal"), { recursive: true, force: true });
    },
  };
}

export function ensureRunsIgnored(spaceRoot: string): void {
  if (!existsSync(path.join(spaceRoot, ".git")) && !existsSync(path.join(spaceRoot, "..", "..", ".git"))) {
    // Space may be nested; check-ignore still works from git root via cwd.
  }
}

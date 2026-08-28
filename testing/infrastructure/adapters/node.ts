import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

import type { UnitResult, WorkUnit } from "../types.ts";
import { createLease, releaseLease, type EnvironmentLease } from "../environment/lease.ts";
import { killProcessGroup } from "../environment/cleanup.ts";
import { spawnGroup } from "../process/group.ts";
import { waitForExit } from "../process/wait.ts";
import { collectFailureDiagnostic } from "../evidence/failure-diagnostic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(HERE, "../../framework/worker.ts");

export async function runNodeUnit(unit: WorkUnit, extraEnv: Record<string, string>): Promise<UnitResult> {
  const lease = createLease();
  try {
    return await runNodeUnitInLease(unit, extraEnv, lease);
  } finally {
    releaseLease(lease);
  }
}

/** Runs an ordered project evolution in one path-stable isolated machine. */
export async function runNodeSequence(
  units: WorkUnit[],
  extraEnv: Record<string, string>,
  deadline = Number.POSITIVE_INFINITY,
): Promise<UnitResult[]> {
  const lease = createLease("genehub-sequence-");
  const checkpointRoot = mkdtempSync(path.join(tmpdir(), "genehub-sequence-checkpoint-"));
  const results: UnitResult[] = [];
  let predecessorPassed = true;
  let predecessorCheckpoint: { path: string; digest: string } | undefined;
  try {
    for (const unit of units) {
      if (!predecessorPassed || Date.now() > deadline) {
        const reason = predecessorPassed
          ? "run reached --max-run-ms before sequence member"
          : "an earlier sequence journey did not pass";
        results.push({
          id: unit.id,
          caseId: unit.caseId,
          variant: unit.variant,
          status: predecessorPassed ? "interrupted" : "blocked",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          message: reason,
          ...(predecessorPassed ? {} : { blockedReason: reason }),
        });
        predecessorPassed = false;
        continue;
      }
      if (predecessorCheckpoint) {
        restoreCheckpoint(lease, predecessorCheckpoint.path);
        const restored = digestTree(lease.root);
        if (restored !== predecessorCheckpoint.digest) {
          results.push({
            id: unit.id,
            caseId: unit.caseId,
            variant: unit.variant,
            status: "failed",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: 0,
            message: "sequence checkpoint failed identity verification after restore",
          });
          predecessorPassed = false;
          continue;
        }
      }
      const result = await runNodeUnitInLease(
        unit,
        {
          ...extraEnv,
          TESTCTL_SEQUENCE_ID: unit.meta.sequence?.id ?? "",
          TESTCTL_SEQUENCE_ORDER: String(unit.meta.sequence?.order ?? ""),
          TESTCTL_SEQUENCE_CHECKPOINT_SHA256: predecessorCheckpoint?.digest ?? "",
        },
        lease,
      );
      results.push(result);
      predecessorPassed = result.status === "passed";
      if (predecessorPassed) {
        const checkpoint = path.join(checkpointRoot, `after-${unit.meta.sequence?.order ?? results.length}`);
        cpSync(lease.root, checkpoint, {
          recursive: true,
          force: true,
          preserveTimestamps: true,
          // Dependency installs are reproducible cache, not delivery identity.
          // Keeping them would turn a 50k-line project checkpoint into a
          // multi-gigabyte mutable runtime snapshot.
          filter: (source) =>
            !["node_modules", ".pnpm-store", ".test-runtime"].includes(path.basename(source)),
        });
        predecessorCheckpoint = { path: checkpoint, digest: digestTree(checkpoint) };
      }
    }
    return results;
  } finally {
    releaseLease(lease);
    rmSync(checkpointRoot, { recursive: true, force: true });
  }
}

function restoreCheckpoint(lease: EnvironmentLease, checkpoint: string): void {
  rmSync(lease.root, { recursive: true, force: true });
  mkdirSync(lease.root, { recursive: true });
  for (const entry of readdirSync(checkpoint)) {
    cpSync(path.join(checkpoint, entry), path.join(lease.root, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }
}

/** Content identity for an isolated machine snapshot; secrets are hashed, never emitted. */
function digestTree(root: string): string {
  const digest = createHash("sha256");
  const visit = (current: string, relative: string) => {
    const stat = lstatSync(current);
    const normalized = relative.split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      digest.update(`link\0${normalized}\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      digest.update(`dir\0${normalized}\0`);
      for (const entry of readdirSync(current).sort()) {
        visit(path.join(current, entry), path.join(relative, entry));
      }
      return;
    }
    digest.update(`file\0${normalized}\0${stat.mode & 0o777}\0`);
    digest.update(readFileSync(current));
    digest.update("\0");
  };
  visit(root, ".");
  return digest.digest("hex");
}

async function runNodeUnitInLease(
  unit: WorkUnit,
  extraEnv: Record<string, string>,
  lease: EnvironmentLease,
): Promise<UnitResult> {
  const resultDir = mkdtempSync(path.join(tmpdir(), "testctl-result-"));
  const resultPath = path.join(resultDir, "result.json");
  const tsx = path.join(path.dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
  const child = spawnGroup(process.execPath, [tsx, WORKER], {
    env: {
      ...process.env,
      ...lease.env,
      ...extraEnv,
      TESTCTL_UNIT_ID: unit.id,
      TESTCTL_CASE_ID: unit.caseId,
      TESTCTL_VARIANT: unit.variant,
      TESTCTL_CASE_FILE: unit.meta.file,
      TESTCTL_RESULT_PATH: resultPath,
      TESTCTL_LEASE_ROOT: lease.root,
    },
  });
  try {
    await waitForExit(child, unit.meta.timeoutMs);
    const raw = readFileSync(resultPath, "utf8");
    const result = JSON.parse(raw) as UnitResult;
    if (result.status !== "passed" && result.status !== "not-applicable") {
      result.diagnostic = collectFailureDiagnostic(lease);
    }
    return result;
  } catch (error) {
    if (child.pid) killProcessGroup(child.pid);
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: message.includes("exceeded") ? "interrupted" : "failed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      message,
      diagnostic: collectFailureDiagnostic(lease),
    };
  } finally {
    if (child.pid) killProcessGroup(child.pid);
    rmSync(resultDir, { recursive: true, force: true });
  }
}

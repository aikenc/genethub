import { existsSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";

import type { UnitResult, WorkUnit } from "../types.ts";
import { spawnGroup } from "../process/group.ts";
import { createLease, releaseLease } from "../environment/lease.ts";
import { trackResources } from "../environment/resource-census.ts";
import { collectOutput, waitForExit } from "../process/wait.ts";

export function rustCrateManifest(openRoot: string): string | null {
  const preferred = path.join(openRoot, "testing", "deprecated", "rust", "Cargo.toml");
  if (existsSync(preferred)) return preferred;
  return null;
}

function locateSignedWasm(openRoot: string): string | null {
  const override = process.env.GENET_APP_WASM?.trim();
  if (override) return override;
  const candidate = path.join(openRoot, "target", "genehub-app.wasm");
  return existsSync(candidate) ? candidate : null;
}

function failureExcerpt(stdout: string, stderr: string): string {
  const combined = `${stderr.slice(-1500)}\n${stdout}`.trim();
  const marker = combined.indexOf("\nfailures:");
  const slice = marker >= 0 ? combined.slice(marker) : combined;
  return slice.slice(-2500);
}

export async function runRustLegacyUnit(
  unit: WorkUnit,
  openRoot: string,
): Promise<UnitResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const manifest = rustCrateManifest(openRoot);
  if (!manifest) {
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "blocked",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message: "frozen Rust crate is not at testing/deprecated/rust",
      blockedReason: "legacy rust crate missing",
    };
  }
  const wasm = locateSignedWasm(openRoot);
  const testName = unit.meta.id.split(".").at(-1) ?? unit.meta.id;
  const suite = unit.meta.id.split(".").at(-2)!;
  if (!existsSync(path.join(path.dirname(manifest), "tests", suite + ".rs"))) {
    return { id: unit.id, caseId: unit.caseId, variant: unit.variant, status: "blocked", startedAt,
      endedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
      blockedReason: "required frozen suite missing", message: "Required frozen suite is absent: " + suite };
  }
  const lease = createLease("genehub-legacy-");
  const child = spawnGroup("cargo", ["test", "--manifest-path", manifest, "--test", suite, "--", testName, "--exact", "--include-ignored", "--show-output"], {
    cwd: openRoot,
    env: {
      ...process.env,
      ...lease.env,
      TESTCTL_RESOURCE_OWNER: lease.id,
      TESTCTL_HOST_HOME: userInfo().homedir,
      JOURNEY_LLM: unit.meta.llm.default === "real" ? "real" : "mock",
      CARGO_TERM_COLOR: "never",
      RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || "1.95.0",
      ...(wasm ? { GENET_APP_WASM: wasm } : {}),
    },
  });
  const resources = trackResources(lease.id, child.pid ?? -1);
  let result: UnitResult | undefined;
  const output = collectOutput(child);
  try {
    const code = await waitForExit(child, unit.meta.timeoutMs);
    const executed = [...output.stdout.matchAll(/test result: ok\. (\d+) passed/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    const unmet = output.stdout.match(/^TESTCTL_BLOCKED: (.+)$/m)?.[1];
    const passed = code === 0 && executed > 0 && !unmet;
    result = {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: passed ? "passed" : code === 0 && (executed === 0 || unmet) ? "blocked" : "failed",
      blockedReason: unmet ?? (code === 0 && executed === 0 ? "required frozen case missing from compiled test target" : undefined),
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message: passed ? undefined : code === 0 ? unmet ?? "legacy filter executed zero tests" : failureExcerpt(output.stdout, output.stderr),
    };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: message.includes("exceeded") ? "interrupted" : "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message,
    };
    return result;
  } finally {
    const cleanup = await resources.finish();
    if (result) {
      result.cleanup = cleanup;
      if ((cleanup.before.processes ?? 0) > 0 || (cleanup.before.ports ?? 0) > 0) {
        if (result.status === "passed") result.status = "failed";
        result.message = (result.message ?? "") + "; leaked resources: " + JSON.stringify(cleanup.before);
      }
    }
    releaseLease(lease);
  }
}

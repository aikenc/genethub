import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";

import type { UnitResult, WorkUnit } from "../types.ts";
import { spawnGroup } from "../process/group.ts";
import { createLease, releaseLease } from "../environment/lease.ts";
import { registerLeaseWorker } from "../environment/ownership.ts";
import { trackResources } from "../environment/resource-census.ts";
import { collectOutput, waitForExit } from "../process/wait.ts";
import { pinnedPythonRuntimeCache } from "../environment/pinned-runtime.ts";
import { BlockedError } from "../types.ts";

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

let agentBuild: Promise<string | null> | undefined;

/**
 * `cargo test` compiles the Agent as a test harness and never refreshes its
 * executable, so a frozen case that starts the daemon would run whatever
 * `genet-agent-local` an earlier build left behind: a stale one made a restart
 * case lose its history while the code under test was fine. Ask cargo once per
 * run; an up-to-date tree costs about a second. Resolves to a failure text.
 */
function ensureAgentBinary(openRoot: string): Promise<string | null> {
  agentBuild ??= new Promise((resolve) => {
    execFile(
      process.env.CARGO?.trim() || "cargo",
      ["build", "--manifest-path", path.join(openRoot, "Cargo.toml"), "-p", "genet-agent", "--bin", "genet-agent-local"],
      { cwd: openRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GENEHUB_NETWORK_CALLER_ENV: undefined, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || "1.95.0" } },
      (error, stdout, stderr) => resolve(error ? `${stderr}${stdout}`.trim().split("\n").slice(-12).join("\n") || error.message : null),
    );
  });
  return agentBuild;
}

/** The cached platform Python the installer would have put on a real machine; none when cold and offline. */
function pythonRuntimeEnv(openRoot: string): Record<string, string> {
  try {
    return { TESTCTL_PYTHON_RUNTIME_TREE: pinnedPythonRuntimeCache(openRoot).tree };
  } catch (error) {
    if (error instanceof BlockedError) return {};
    throw error;
  }
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
  const agentFailure = await ensureAgentBinary(openRoot);
  if (agentFailure !== null) {
    return { id: unit.id, caseId: unit.caseId, variant: unit.variant, status: "failed", startedAt,
      endedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
      message: `building the Agent binary the frozen cases start failed:\n${agentFailure}` };
  }
  const lease = createLease("genehub-legacy-");
  const child = spawnGroup("cargo", ["test", "--manifest-path", manifest, "--test", suite, "--", testName, "--exact", "--include-ignored", "--show-output"], {
    cwd: openRoot,
    env: {
      ...process.env, GENEHUB_NETWORK_CALLER_ENV: undefined,
      ...lease.env,
      TESTCTL_RESOURCE_OWNER: lease.id,
      TESTCTL_HOST_HOME: userInfo().homedir,
      JOURNEY_LLM: unit.meta.llm.default === "real" ? "real" : "mock",
      CARGO_TERM_COLOR: "never",
      RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || "1.95.0",
      // The frozen harness embeds the full daemon inside libtest's worker
      // thread. Its default stack is smaller than the standalone daemon's;
      // keep a bounded test-only budget as protocol and workflow types grow.
      RUST_MIN_STACK: process.env.RUST_MIN_STACK || String(16 * 1024 * 1024),
      ...(wasm ? { GENET_APP_WASM: wasm } : {}),
      ...pythonRuntimeEnv(openRoot),
    },
  });
  if (child.pid) registerLeaseWorker(lease.root, child.pid);
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
    if (cleanup.after.processes === 0) releaseLease(lease);
  }
}

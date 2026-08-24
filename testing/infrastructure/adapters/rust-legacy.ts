import { existsSync } from "node:fs";
import path from "node:path";

import type { UnitResult, WorkUnit } from "../types.ts";
import { spawnProcess } from "../process/spawn.ts";
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
  const combined = `${stdout}\n${stderr}`.trim();
  const marker = combined.lastIndexOf("\nfailures:");
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
  const child = spawnProcess("cargo", ["test", "--manifest-path", manifest, "--", testName, "--exact"], {
    cwd: openRoot,
    env: {
      ...process.env,
      CARGO_TERM_COLOR: "never",
      RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || "1.95.0",
      ...(wasm ? { GENET_APP_WASM: wasm } : {}),
    },
  });
  const output = collectOutput(child);
  try {
    const code = await waitForExit(child, unit.meta.timeoutMs);
    const passed = code === 0;
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: passed ? "passed" : "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message: passed ? undefined : failureExcerpt(output.stdout, output.stderr),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: message.includes("exceeded") ? "interrupted" : "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message,
    };
  }
}

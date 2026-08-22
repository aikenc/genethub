import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BlockedError, type UnitResult, type WorkUnit } from "../types.ts";

let playwrightModule: { chromium?: { launch: () => Promise<PlaywrightBrowser> } } | null | undefined;

interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  tracing: {
    start(options: { screenshots: boolean; snapshots: boolean }): Promise<void>;
    stop(options?: { path?: string }): Promise<void>;
  };
  newPage(): Promise<{ goto(url: string): Promise<unknown> }>;
  close(): Promise<void>;
}

export async function loadPlaywright(): Promise<NonNullable<typeof playwrightModule>> {
  if (playwrightModule) return playwrightModule;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    require.resolve("playwright");
    const spec = "playwright";
    playwrightModule = (await import(spec)) as NonNullable<typeof playwrightModule>;
    return playwrightModule;
  } catch {
    playwrightModule = null;
    throw new BlockedError("Playwright is not installed; browser cases cannot run");
  }
}

export function playwrightImported(): boolean {
  return playwrightModule != null;
}

function writeFailureArtifacts(dir: string | undefined, message: string): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "error.md"), `${message}\n`);
}

export async function runPlaywrightUnit(
  unit: WorkUnit,
  extraEnv: Record<string, string> = {},
): Promise<UnitResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const artifacts = extraEnv.TESTCTL_BROWSER_ARTIFACTS || process.env.TESTCTL_BROWSER_ARTIFACTS;
  let loaded: NonNullable<typeof playwrightModule>;
  try {
    loaded = await loadPlaywright();
  } catch (error) {
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "blocked",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message: error instanceof Error ? error.message : String(error),
      blockedReason: error instanceof BlockedError ? error.blockedReason : "playwright unavailable",
    };
  }
  if (!loaded.chromium) {
    const message = "browser case selected but Playwright chromium is unavailable";
    writeFailureArtifacts(artifacts, message);
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "blocked",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message,
      blockedReason: "page fixture not installed for this run",
    };
  }
  const tracePath = artifacts ? path.join(artifacts, "trace.zip") : undefined;
  try {
    const browser = await loaded.chromium.launch();
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    await page.goto("about:blank");
    await context.tracing.stop(tracePath ? { path: tracePath } : undefined);
    await context.close();
    await browser.close();
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "passed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFailureArtifacts(artifacts, message);
    return {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      message,
    };
  }
}

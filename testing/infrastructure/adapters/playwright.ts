
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

/** Execute the selected definition in the same isolated worker/lease as Node.
 * Browser acquisition belongs to its context; launch alone is never a case pass. */
export async function runPlaywrightUnit(unit: WorkUnit, extraEnv: Record<string,string> = {}): Promise<UnitResult> {
  const { runNodeUnit } = await import('./node.ts');
  return runNodeUnit(unit,{...extraEnv,TESTCTL_BROWSER_REQUIRED:'1'});
}

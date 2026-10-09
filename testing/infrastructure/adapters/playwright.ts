
import { BlockedError, type UnitResult, type WorkUnit } from "../types.ts";
import { userInfo } from "node:os";
import path from "node:path";

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
  // Browser executables are a host dependency, while cookies, profile and
  // product HOME stay isolated. Resolve the cache before changing HOME.
  const home = userInfo().homedir;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === "darwin"
    ? path.join(home, "Library", "Caches", "ms-playwright")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright")
      : path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright"));
  return runNodeUnit(unit,{PLAYWRIGHT_BROWSERS_PATH:cache,...extraEnv,TESTCTL_BROWSER_REQUIRED:'1',TESTCTL_BROWSER_SELECTED:'1'});
}

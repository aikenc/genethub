import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { BlockedError, type EnvironmentLease } from "../../infrastructure/public.ts";
import { hideHostAgentClis } from "./script-agent.ts";

/** Cursor's official installer, as the built-in cursor script runs it
 * (`builtin-agents/agents/cursor/lifecycle.py` INSTALL_LINE). */
export const CURSOR_INSTALL_URL = "https://cursor.com/install";
const INSTALL_LINE = `curl ${CURSOR_INSTALL_URL} -fsS | bash`;
const INSTALL_BUDGET_MS = 15 * 60_000;

/**
 * Presents the daemon a user without Cursor: no `cursor-agent` on PATH or
 * where the official installer puts it, and none of the `CURSOR_*` variables
 * this harness may have inherited from a Cursor session (`CURSOR_API_KEY`
 * alone counts as logged in). The variables are removed from this case's own
 * process too, because the daemon driver starts from `process.env`; the case
 * process belongs to this case only. Must run before the daemon starts.
 */
export function isolateFromHostCursor(lease: EnvironmentLease): void {
  hideHostAgentClis(lease);
  for (const env of [lease.env, process.env]) {
    for (const name of Object.keys(env)) if (name.startsWith("CURSOR_")) delete env[name];
  }
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin"]) {
    if (existsSync(path.join(dir, "cursor-agent"))) {
      throw new BlockedError(`${dir}/cursor-agent is installed machine-wide and cannot be hidden from a lease`);
    }
  }
  for (const tool of ["curl", "bash"]) {
    const found = (lease.env.PATH ?? "").split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, tool)));
    if (!found) throw new BlockedError(`${tool} is not on the lease PATH; Cursor's official installer needs it`);
  }
}

/** What the official installer leaves in a home: the `~/.local/bin` link and
 * the version directories it points into. */
export interface CursorInstall {
  bin: string;
  /** Resolved target of `bin`, or null when there is no link. */
  target: string | null;
  versions: string[];
}

export function cursorInstall(lease: EnvironmentLease): CursorInstall {
  const bin = path.join(lease.home, ".local", "bin", "cursor-agent");
  let target: string | null = null;
  try {
    target = realpathSync(bin);
  } catch {
    target = null;
  }
  const versionsDir = path.join(lease.home, ".local", "share", "cursor-agent", "versions");
  const versions = existsSync(versionsDir) ? readdirSync(versionsDir).sort() : [];
  return { bin, target, versions };
}

/** `<data>/agents/state/cursor/state.json`, which the built-in script keeps. */
export function cursorScriptState(lease: EnvironmentLease): Record<string, unknown> {
  const file = path.join(lease.data, "agents", "state", "cursor", "state.json");
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Installs Cursor into the lease home the way a user does by hand, by running
 * the official installer line in a shell with the lease's HOME and PATH. A
 * failing download blocks: the case is about what GeneHub does afterwards.
 */
export async function installCursorAsUser(lease: EnvironmentLease): Promise<CursorInstall> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...lease.env, HOME: lease.home };
  for (const name of Object.keys(env)) if (name.startsWith("CURSOR_")) delete env[name];
  const result = await new Promise<{ code: number | null; tail: string }>((resolve) => {
    const child = spawn("sh", ["-c", INSTALL_LINE], { env, cwd: lease.home, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let tail = "";
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-2000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, INSTALL_BUDGET_MS);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, tail: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, tail }); });
  });
  const installed = cursorInstall(lease);
  if (result.code !== 0 || !installed.target) {
    throw new BlockedError(`Cursor's official installer did not install into the lease home (exit ${result.code}): ${result.tail.slice(-300)}`);
  }
  return installed;
}

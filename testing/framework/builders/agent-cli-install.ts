import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";

import { BlockedError, type EnvironmentLease } from "../../infrastructure/public.ts";
import { HOST_AGENT_CLIS, pathWithout } from "./script-agent.ts";

/** What a user's machine needs before an npm-distributed Agent CLI can be installed. */
export const NODE_CLIS = ["node", "npm", "npx"];

/** Directories a lease cannot drop from PATH without losing the basic tools
 * every script (and the runtime install script) relies on. */
const SYSTEM_DIRS = ["/bin", "/usr/bin"];

/** Machine-wide directories the built-in scripts search beyond PATH; a CLI or
 * Node.js there cannot be hidden from a lease. */
const SEARCHED_MACHINE_DIRS = ["/usr/local/bin", "/opt/homebrew/bin"];

export interface HostNode {
  /** `v22.19.0`, the name nvm gives the version directory. */
  version: string;
  /** The real `bin` directory holding node, npm and npx. */
  bin: string;
}

/** The Node.js this harness itself runs on, a complete real installation. */
export function hostNode(): HostNode {
  const bin = path.dirname(realpathSync(process.execPath));
  const missing = NODE_CLIS.filter((name) => !existsSync(path.join(bin, name)));
  if (missing.length > 0) throw new BlockedError(`the harness Node.js at ${bin} has no ${missing.join(", ")} beside it`);
  return { version: process.version, bin };
}

/**
 * Presents the daemon a user who has neither Node.js nor any Agent CLI: none
 * on PATH, and no login shell to ask (`SHELL` empty, as for a daemon started
 * by a desktop launcher). The machine's own login profile would otherwise
 * report its Node.js. Must run before the daemon starts.
 */
export function withoutNodeOrAgentClis(lease: EnvironmentLease): void {
  const names = [...HOST_AGENT_CLIS, ...NODE_CLIS];
  const current = lease.env.PATH ?? process.env.PATH ?? "";
  const kept = pathWithout(names, current);
  const dropped = current.split(path.delimiter).filter((dir) => dir && !kept.split(path.delimiter).includes(dir));
  const system = dropped.filter((dir) => SYSTEM_DIRS.includes(path.resolve(dir)));
  if (system.length > 0) {
    throw new BlockedError(`${system.join(", ")} holds Node.js or an Agent CLI; this machine cannot present a user without them`);
  }
  for (const dir of SEARCHED_MACHINE_DIRS) {
    const found = names.filter((name) => existsSync(path.join(dir, name)));
    if (found.length > 0) throw new BlockedError(`${dir} holds ${found.join(", ")}, which the built-in scripts find outside PATH`);
  }
  lease.env.PATH = kept;
  lease.env.SHELL = "";
}

/**
 * What an Agent the user asked to "install Node.js" leaves behind with nvm:
 * `~/.nvm/versions/node/<version>/bin/{node,npm,npx}` in the lease home,
 * linking to a real installation. PATH of the running daemon is untouched.
 */
export function installNodeLikeNvm(lease: EnvironmentLease, node: HostNode = hostNode()): string {
  const bin = path.join(lease.home, ".nvm", "versions", "node", node.version, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of NODE_CLIS) symlinkSync(path.join(node.bin, name), path.join(bin, name));
  return bin;
}

/**
 * The version the npm registry reports for `pkg`, asked with the real npm
 * from a scratch home inside the lease (so the lease home stays as the user
 * left it). An unreachable registry blocks the case: installing is its fact.
 */
export async function requireNpmPackage(lease: EnvironmentLease, pkg: string, node: HostNode = hostNode()): Promise<string> {
  const home = path.join(lease.root, "npm-probe-home");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, PATH: node.bin + path.delimiter + (process.env.PATH ?? ""), HOME: home };
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(path.join(node.bin, "npm"), ["view", pkg, "version"], { env, cwd: home, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
  });
  const version = /\d+\.\d+\.\d+\S*/.exec(result.stdout)?.[0];
  if (result.code !== 0 || !version) {
    throw new BlockedError(`npm registry did not answer \`npm view ${pkg} version\` (exit ${result.code})`);
  }
  return version;
}

/** Blocks unless an HTTPS service a real CLI will talk to answers at all. */
export async function requireHttpsReachable(url: string): Promise<void> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
  } catch (error) {
    throw new BlockedError(`${new URL(url).host} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface LeaseProcess {
  pid: number;
  cmd: string;
}

/**
 * Live processes that belong to this lease: running from, started with, or
 * carrying the lease's home or data directory. Linux only (`/proc`).
 */
export function leaseProcesses(lease: EnvironmentLease): LeaseProcess[] {
  if (process.platform !== "linux") throw new BlockedError("lease process census needs /proc");
  const roots = [...new Set([lease.root, safeRealpath(lease.root)])];
  const marks = roots.flatMap((root) => [`HOME=${path.join(root, "home")}`, `GENEHUB_DATA_DIR=${path.join(root, "data")}`]);
  const under = (value: string) => roots.some((root) => value === root || value.startsWith(root + path.sep));
  const found: LeaseProcess[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) continue;
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      let cwd = "";
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* exited or not ours */ }
      if (roots.some((root) => cmd.includes(root)) || under(cwd) || environ.some((entry) => marks.includes(entry))) {
        found.push({ pid, cmd: cmd.slice(0, 200) });
      }
    } catch {
      // Exited during the scan, or another user's process.
    }
  }
  return found;
}

function safeRealpath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

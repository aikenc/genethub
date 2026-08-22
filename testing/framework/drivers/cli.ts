import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { BlockedError } from "../../infrastructure/public.ts";

function locateOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.resolve(candidate);
  }
  return undefined;
}

export function locateGenet(openRoot: string): string {
  const override = process.env.GENET_E2E_DAEMON?.trim();
  if (override) return existsSync(override) && statSync(override).isFile() ? path.resolve(override) : override;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const names = ["genet-dev", "genet-beta", "genet-alpha", "genet"];
  for (const name of names) {
    const candidate = path.resolve(openRoot, "target", "debug", `${name}${suffix}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const name of names) {
    const fromPath = locateOnPath(`${name}${suffix}`);
    if (fromPath) return fromPath;
  }
  throw new BlockedError("genet artifact is missing");
}

const AGENT_NAMES = ["genet-agent-dev", "genet-agent-beta", "genet-agent-alpha", "genet-agent"];

function firstExistingFile(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.resolve(candidate);
  }
  return undefined;
}

export function tryLocateAgentBeside(genet: string): string | undefined {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return firstExistingFile(AGENT_NAMES.map((name) => path.join(path.dirname(genet), `${name}${suffix}`)));
}

export function tryLocateAgent(openRoot: string): string | undefined {
  const override =
    process.env.GENET_AGENT_DEV_COMMAND?.trim() ||
    process.env.GENET_AGENT_BETA_COMMAND?.trim() ||
    process.env.GENET_AGENT_BINARY?.trim();
  if (override) {
    return existsSync(override) && statSync(override).isFile() ? path.resolve(override) : override;
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    const beside = tryLocateAgentBeside(locateGenet(openRoot));
    if (beside) return beside;
  } catch {
    // genet itself may be missing in artifact-locator cases
  }
  return firstExistingFile(AGENT_NAMES.map((name) => path.resolve(openRoot, "target", "debug", `${name}${suffix}`)));
}

export function tryLocateWasm(openRoot: string): string | undefined {
  const override = process.env.GENET_APP_WASM?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) return undefined;
    return resolved;
  }
  const candidate = path.resolve(openRoot, "target", "genehub-app.wasm");
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  return candidate;
}

export function tryLocateHost(openRoot: string): string | undefined {
  const override = process.env.GENEHUB_HOST?.trim();
  if (override) {
    return existsSync(override) && statSync(override).isFile() ? path.resolve(override) : override;
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  return firstExistingFile([
    path.resolve(openRoot, "target", "debug", `genehub-host-dev${suffix}`),
    path.resolve(openRoot, "target", "release", `genehub-host-dev${suffix}`),
  ]);
}

export function tryLocateDaemonComponent(openRoot: string): string | undefined {
  const override =
    process.env.GENEHUB_DEV_COMPONENT?.trim() || process.env.GENEHUB_DEV_DAEMON_COMPONENT?.trim();
  if (override) {
    return existsSync(override) && statSync(override).isFile() ? path.resolve(override) : override;
  }
  return firstExistingFile([
    path.resolve(openRoot, "target", "wasm32-wasip2", "release", "genehub_guest.wasm"),
    path.resolve(openRoot, "target", "wasm32-wasip2", "debug", "genehub_guest.wasm"),
  ]);
}

export function tryLocateAgentComponent(openRoot: string): string | undefined {
  // v2: the agent is the `agent-run` entry of the same component. There is no
  // second artifact to locate.
  return tryLocateDaemonComponent(openRoot);
}

export function procCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

export function procEnviron(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", "\n");
  } catch {
    return "";
  }
}

export function agentHostProcesses(): Array<{ pid: number; cmd: string; environ: string }> {
  return processesMatching("genehub-host-dev")
    .filter((row) => row.cmd.includes("--entry agent"))
    .map((row) => ({ ...row, environ: procEnviron(row.pid) }));
}

export function processesMatching(needle: string): Array<{ pid: number; cmd: string }> {
  const found: Array<{ pid: number; cmd: string }> = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const cmd = procCmdline(pid);
    if (cmd.includes(needle)) found.push({ pid, cmd });
  }
  return found;
}

export function tryLocateGuestProbe(openRoot: string): string | undefined {
  const override = process.env.GENEHUB_GUEST_PROBE?.trim();
  if (override) {
    return existsSync(override) && statSync(override).isFile() ? path.resolve(override) : override;
  }
  return firstExistingFile([
    path.resolve(openRoot, "target", "wasm32-wasip2", "debug", "genehub-guest-probe.wasm"),
    path.resolve(openRoot, "target", "wasm32-wasip2", "release", "genehub-guest-probe.wasm"),
  ]);
}

export function locateWasm(openRoot: string): string {
  const found = tryLocateWasm(openRoot);
  if (!found) {
    throw new BlockedError("signed Wasm artifact is not a regular file");
  }
  return found;
}

export function genetEnv(openRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const wasm = tryLocateWasm(openRoot);
  return {
    ...process.env,
    ...extra,
    ...(wasm ? { GENET_APP_WASM: wasm } : {}),
  };
}

export function runGenet(
  genet: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(genet, args, { env, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runGenetAsync(
  genet: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(genet, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function parseJson(stdout: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("CLI produced no JSON");
  return JSON.parse(line) as Record<string, unknown>;
}

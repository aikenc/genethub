import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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

export function locateWasm(openRoot: string): string {
  const found = tryLocateWasm(openRoot);
  if (!found) {
    throw new BlockedError("signed Wasm artifact is not a regular file");
  }
  return found;
}

export function genetEnv(openRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const wasm = tryLocateWasm(openRoot);
  const agent = tryLocateAgent(openRoot);
  return {
    ...process.env,
    ...extra,
    ...(wasm ? { GENET_APP_WASM: wasm } : {}),
    ...(agent ? { GENET_AGENT_DEV_COMMAND: agent } : {}),
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

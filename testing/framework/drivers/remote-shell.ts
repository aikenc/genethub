import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

/** Transport the existing caller identity unchanged. The environment snapshot
 * is supplied in memory by the launching shell, never saved in evidence. No
 * identity/CLI fallback on denial. The lease's own daemon is not the caller. */
export async function runBoundRemoteCli(args: string[]) {
  const raw = process.env.GENEHUB_NETWORK_CALLER_ENV;
  if (!raw) throw new Error("remote network test requires the existing caller environment snapshot");
  const env = JSON.parse(raw) as NodeJS.ProcessEnv;
  const cli = env.GENEHUB_CLI;
  if (!cli || !isAbsolute(cli)) throw new Error("remote network test requires the original caller's absolute GENEHUB_CLI");
  const child = spawn(cli, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const records: Array<{ type?: string; data?: Record<string, unknown>; error?: { code?: string } }> = [];
  let pending = "", stderrBytes = 0;
  child.stdout.on("data", (data: Buffer) => {
    pending += data.toString();
    const lines = pending.split("\n"); pending = lines.pop()!;
    for (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  });
  child.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; });
  const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", value => resolve(value ?? -1)); });
  return { code, records, stderrBytes };
}

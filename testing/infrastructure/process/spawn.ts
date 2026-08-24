import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

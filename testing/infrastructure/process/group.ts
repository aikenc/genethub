import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function spawnGroup(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

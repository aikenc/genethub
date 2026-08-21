import { execFileSync } from "node:child_process";

export function remainingChildren(pid: number): number[] {
  try {
    const output = execFileSync("ps", ["-o", "pid=,ppid=", "-ax"], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).map(Number))
      .filter(([, ppid]) => ppid === pid)
      .map(([child]) => child)
      .filter((child): child is number => Number.isFinite(child));
  } catch {
    return [];
  }
}

export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

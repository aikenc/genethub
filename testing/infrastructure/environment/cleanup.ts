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

/** Process groups that survived both signals, keyed by the leader's pid. */
const unreaped = new Set<number>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends one unit's process group and confirms it is gone.
 *
 * SIGTERM alone was a request, not a result. A daemon that ignored it kept
 * running with the run's inherited stdout still open, which is how a finished
 * run could leave its own pipeline waiting for an end-of-file that never came
 * — the run had written its summary hours earlier. Escalate, then record what
 * still would not die so the run can say so instead of reporting zero leaks.
 */
export function killProcessGroup(pid: number): void {
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-pid, name);
      return;
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // already gone
      }
    }
  };

  signal("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) {
      unreaped.delete(pid);
      return;
    }
    // A short synchronous wait: callers are in a `finally` that must not hand
    // the next unit a machine still running the previous one's daemon.
    try {
      execFileSync("sleep", ["0.05"]);
    } catch {
      break;
    }
  }
  signal("SIGKILL");
  if (groupAlive(pid)) unreaped.add(pid);
  else unreaped.delete(pid);
}

/**
 * How many unit process groups this run could not reap. Measured, not
 * assumed: a run that leaks a daemon must not describe itself as clean.
 */
export function unreapedProcessGroups(): number {
  for (const pid of [...unreaped]) {
    if (!groupAlive(pid)) unreaped.delete(pid);
  }
  return unreaped.size;
}

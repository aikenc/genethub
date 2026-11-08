import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { BlockedError } from "../../infrastructure/public.ts";

/** Independent Linux observation or an explicitly declared OS storage fault. */
export async function observeFileOpens(executable: string, pid: number, output: string, trace: "openat" | "openat,openat2" | "%file" = "openat", delay?: { milliseconds: number }) {
  if (process.platform !== "linux") throw new BlockedError("file-open observation requires Linux ptrace");
  const child = spawn(executable, ["-f", "-yy", "-ttT", "-s", "4096", "-e", `trace=${trace}`,
    ...(delay ? ["-e", `inject=openat,openat2:delay_enter=${delay.milliseconds}ms`] : []),
    "-o", output, "-p", String(pid)], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = "", spawnError = "";
  child.stderr.on("data", b => { diagnostic = (diagnostic + String(b)).slice(-4096); });
  child.on("error", e => { spawnError = e.message; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT"); await closed; };
  const deadline = Date.now() + 5000;
  while (!diagnostic.includes("attached")) {
    if (spawnError || child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new BlockedError(`ptrace attach unavailable: ${spawnError || diagnostic}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return {
    stop,
    lines() {
      if (statSync(output).size > 8 * 1024 * 1024) throw new Error("file-open observation exceeded 8 MiB budget");
      return readFileSync(output, "utf8").split("\n").filter(Boolean);
    },
  };
}

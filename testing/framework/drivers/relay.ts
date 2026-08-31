import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { BlockedError } from "../../infrastructure/public.ts";

export interface RelayHandle {
  origin: string;
  joinToken: string;
  process: ChildProcess;
  /** Bounded tail of the relay's stdout/stderr for failure diagnostics. */
  logTail(): string;
  stop(): void;
}

/**
 * Starts the real Relay product (`apps/relay` build output) in rendezvous
 * mode on a dynamic loopback port. A missing bundle blocks the case rather
 * than silently substituting anything else for the forwarding layer.
 */
export async function startRelay(input: { openRoot: string }): Promise<RelayHandle> {
  const bundle = path.join(input.openRoot, "apps", "relay", "dist", "main.js");
  if (!existsSync(bundle)) {
    throw new BlockedError(`relay bundle missing at ${bundle}; build it with: npm --prefix apps/relay run build`);
  }
  // Rendezvous joins tokens are validated at 32-256 chars even on loopback.
  const joinToken = `testctl-${randomBytes(24).toString("hex")}`;
  const child = spawn(process.execPath, [bundle], {
    env: {
      ...process.env,
      RELAY_MODE: "rendezvous",
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: "0",
      RELAY_JOIN_TOKEN: joinToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const LOG_TAIL_BUDGET = 64 * 1024;
  let logTail = "";
  const remember = (chunk: Buffer) => {
    logTail = (logTail + chunk.toString()).slice(-LOG_TAIL_BUDGET);
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the relay never said where it was")), 15_000);
    const read = (chunk: Buffer) => {
      const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (!found) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${found[1]}`);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the relay exited before listening (${code})`));
    });
  }).catch((error: unknown) => {
    child.kill("SIGKILL");
    throw error;
  });
  return {
    origin,
    joinToken,
    process: child,
    logTail: () => logTail,
    stop() {
      child.kill("SIGKILL");
    },
  };
}

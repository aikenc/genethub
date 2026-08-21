import { spawnSync } from "node:child_process";

import { BlockedError } from "../../infrastructure/public.ts";
import type { EnvironmentLease } from "../../infrastructure/public.ts";
import { parseJson, runGenet } from "./cli.ts";

export interface DaemonHandle {
  genet: string;
  env: NodeJS.ProcessEnv;
  stop(): void;
}

export interface DaemonEndpoint {
  url: string;
  localServerProof: {
    proof: string;
    challenge: string;
    pid: number;
    machineId: string;
    fingerprint: string;
    expiresAt: number;
  };
}

export function startDaemon(input: {
  genet: string;
  wasm?: string;
  lease: EnvironmentLease;
}): DaemonHandle {
  const env = {
    ...process.env,
    ...input.lease.env,
    ...(input.wasm ? { GENET_APP_WASM: input.wasm } : {}),
  };
  const started = runGenet(input.genet, ["daemon", "start"], env);
  if (started.code !== 0) {
    throw new BlockedError(`genet daemon start failed: ${started.stderr || started.stdout}`);
  }
  return {
    genet: input.genet,
    env,
    stop() {
      spawnSync(input.genet, ["daemon", "stop"], { env, encoding: "utf8" });
    },
  };
}

export function daemonEndpoint(handle: DaemonHandle): DaemonEndpoint {
  const result = runGenet(handle.genet, ["daemon", "endpoint"], handle.env);
  if (result.code !== 0) {
    throw new BlockedError(`genet daemon endpoint failed: ${result.stderr || result.stdout}`);
  }
  const json = parseJson(result.stdout);
  const url = json.wsUrl;
  const proof = json.serverProof;
  const admission = json.admission as Record<string, unknown> | undefined;
  if (typeof url !== "string" || typeof proof !== "string" || !admission) {
    throw new BlockedError("genet daemon endpoint did not return admission");
  }
  return {
    url,
    localServerProof: {
      proof,
      challenge: String(admission.challenge ?? ""),
      pid: Number(admission.pid ?? 0),
      machineId: String(admission.machineId ?? ""),
      fingerprint: String(admission.fingerprint ?? ""),
      expiresAt: Number(admission.expiresAt ?? 0),
    },
  };
}

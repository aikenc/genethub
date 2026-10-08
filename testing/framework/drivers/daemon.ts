import { BlockedError } from "../../infrastructure/public.ts";
import type { EnvironmentLease } from "../../infrastructure/public.ts";
import { seedScriptAgentRuntimeByDefault } from "../builders/script-agent.ts";
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
  /** Names to remove from the inherited environment outright: a case that
   * exercises a fallback path cannot just delete the key from the lease,
   * because the merge with `process.env` would resurrect it. */
  dropEnv?: string[];
  /** What the launcher's own environment carried, given to `daemon start`
   * only: a case can start a daemon the way one is restarted from inside an
   * Agent Session without later CLI calls speaking for that session. */
  launchEnv?: NodeJS.ProcessEnv;
}): DaemonHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.lease.env,
    ...(input.wasm ? { GENEHUB_LOCAL_COMPONENT: input.wasm } : {}),
  };
  // A test lease is a fresh local user. The harness may itself run inside a
  // managed Agent Session, whose controller identity must not cross into it.
  delete env.GENEHUB_SESSION_ID;
  delete env.GENEHUB_CONTROLLER_TOKEN;
  // Foreign Agent contexts and credential roots must not cross a lease.
  // A case may opt in through its own env/launchEnv; no host value is printed.
  for (const key of ["CODEX_HOME", "CURSOR_AGENT", "CURSOR_CONVERSATION_ID", "CURSOR_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "npm_config_prefix"]) {
    if (!(key in input.lease.env)) delete env[key];
  }
  for (const key of input.dropEnv ?? []) delete env[key];
  seedScriptAgentRuntimeByDefault(input.lease);
  const started = runGenet(input.genet, ["daemon", "start"], { ...env, ...input.launchEnv });
  if (started.code !== 0) {
    throw new BlockedError(`genet daemon start failed: ${started.stderr || started.stdout}`);
  }
  return {
    genet: input.genet,
    env,
    stop() {
      const stopped = runGenet(input.genet, ["daemon", "stop"], env);
      if (stopped.code !== 0) {
        throw new Error(`genet daemon stop failed (${stopped.code}): ${stopped.stderr || stopped.stdout}`);
      }
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

import type { EnvironmentLease } from "../../infrastructure/public.ts";
import { genetEnv, locateGenet, runGenet } from "./cli.ts";

/** One `genet` invocation as a caller sees it: exit code, the single
 * `genet.cli/v1` value on stdout (null when stdout is not one), and stderr. */
export interface GenetCliResult {
  code: number;
  stdout: string;
  stderr: string;
  envelope: CliEnvelope | null;
}

export interface CliEnvelope {
  schema?: unknown;
  type?: unknown;
  data?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown; retryable?: unknown };
  [key: string]: unknown;
}

/** The last non-empty stdout line as JSON, or null. */
export function cliEnvelope(stdout: string): CliEnvelope | null {
  const line = stdout.split("\n").map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as CliEnvelope) : null;
  } catch {
    return null;
  }
}

/**
 * The shipped `genet` binary run as this lease's local user, against the
 * daemon the lease's data directory names. Nothing about the call is
 * special: the same binary, arguments and environment a person's shell
 * would give it.
 */
export function localGenetCli(openRoot: string, lease: EnvironmentLease): (args: string[]) => GenetCliResult {
  const genet = locateGenet(openRoot);
  const env = genetEnv(openRoot, { ...lease.env, GENEHUB_LOCAL_DATA_DIR: lease.data });
  return (args) => {
    const result = runGenet(genet, args, env);
    return { ...result, envelope: cliEnvelope(result.stdout) };
  };
}

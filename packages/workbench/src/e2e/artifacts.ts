import { existsSync } from "node:fs";
import path from "node:path";

/** Finds the channel-stamped executable Cargo actually built in this checkout. */
export function builtBinary(
  repo: string,
  names: readonly string[],
  override?: string,
): string {
  if (override?.trim()) return override;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = names.map((name) => path.join(repo, "target", "debug", `${name}${suffix}`));
  return candidates.find(existsSync) ?? candidates[0]!;
}

/** Uses the override names belonging to the channel stamped into the binary. */
export function daemonEnvironment(
  daemon: string,
  values: {
    dataDir: string;
    workspaceDir: string;
    log: string;
    agent?: string;
  },
): Record<string, string> {
  const binary = path.basename(daemon).replace(/\.exe$/i, "");
  const channel = binary.endsWith("-local")
    ? "LOCAL"
    : binary.endsWith("-dev")
      ? "DEV"
      : binary.endsWith("-beta")
        ? "BETA"
        : "";
  const infix = channel ? `_${channel}` : "";
  return {
    [`GENEHUB${infix}_DATA_DIR`]: values.dataDir,
    [`GENEHUB${infix}_WORKSPACE_DIR`]: values.workspaceDir,
    [`GENEHUB${infix}_LOG`]: values.log,
    ...(values.agent ? { [`GENET_AGENT${infix}_COMMAND`]: values.agent } : {}),
  };
}

/**
 * Local contributors may run the fast Web suite without first compiling Rust.
 * CI explicitly requires these journeys, so a missing artifact is a failure,
 * never a green test run whose most important suites quietly skipped.
 */
export function missingArtifacts(artifacts: Readonly<Record<string, string>>): boolean {
  const missing = Object.entries(artifacts).filter(([, artifact]) => !existsSync(artifact));
  if (missing.length > 0 && process.env.GENET_E2E_REQUIRED === "1") {
    throw new Error(
      `mandatory end-to-end artifacts are missing: ${missing
        .map(([name, artifact]) => `${name} (${artifact})`)
        .join(", ")}`,
    );
  }
  return missing.length > 0;
}

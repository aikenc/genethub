import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** Finds the channel-stamped executable Cargo actually built in this checkout. */
export function builtBinary(
  repo: string,
  names: readonly string[],
  override?: string,
): string {
  if (override?.trim()) return override;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = (["iterate", "debug", "release"] as const).flatMap((profile) =>
    names.map((name) => path.join(repo, "target", profile, `${name}${suffix}`)),
  );
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
  // Same directory testctl uses. The host only honours it on the local
  // channel; without it every workbench e2e file pays a cold Component
  // compile inside whatever host sits beside the CLI (debug host ~6s here).
  const cache =
    process.env.GENEHUB_TEST_COMPONENT_CACHE_DIR?.trim() ||
    path.join(path.dirname(daemon), "..", "test-component-cache");
  mkdirSync(cache, { recursive: true });
  return {
    [`GENEHUB${infix}_DATA_DIR`]: values.dataDir,
    [`GENEHUB${infix}_WORKSPACE_DIR`]: values.workspaceDir,
    [`GENEHUB${infix}_LOG`]: values.log,
    GENEHUB_TEST_COMPONENT_CACHE_DIR: cache,
    ...(values.agent ? { [`GENET_AGENT${infix}_COMMAND`]: values.agent } : {}),
  };
}

/** Host + guest that `genet daemon run` execs; a missing pair is a start failure. */
export function runtimeArtifacts(daemon: string): {
  daemon: string;
  host: string;
  component: string;
} {
  const dir = path.dirname(daemon);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const stem = path.basename(daemon).replace(/\.exe$/i, "");
  // Source-tree launchers accept these overrides and Cargo keeps the guest
  // under its cross-target directory. Validate what will actually be run,
  // rather than requiring an obsolete copy beside the native executable.
  const local = stem === "genet-local";
  const target = path.dirname(dir);
  const cargoLayout = ["iterate", "debug", "release"].includes(path.basename(dir));
  const components = [
    ...(cargoLayout ? ["iterate", "debug", "release"].map(profile => path.join(target, "wasm32-wasip2", profile, "genehub_guest.wasm")) : []),
    path.join(dir, "genehub_guest.wasm"),
  ];
  return {
    daemon,
    host: (local && process.env.GENEHUB_HOST?.trim()) || path.join(dir, `${stem.replace(/^genet/, "genehub-host")}${suffix}`),
    component: (local && (process.env.GENEHUB_LOCAL_COMPONENT?.trim() || process.env.GENEHUB_LOCAL_DAEMON_COMPONENT?.trim())) || components.find(existsSync) || components[0]!,
  };
}

export type StartedDaemon = {
  process: ChildProcess;
  stop(): Promise<void>;
  url: string;
  localServerProof: {
    proof: string;
    challenge: string;
    pid: number;
    machineId: string;
    fingerprint: string;
    expiresAt: number;
  };
};

/** Mirrors `genet_frontdoor::launch_env::SESSION_SCOPED`. */
const AGENT_SESSION_CONTEXT = [
  "GENEHUB_SESSION_ID",
  "GENEHUB_CONTROLLER_TOKEN",
  "GENEHUB_EVIDENCE_SCOPE",
  "GENEHUB_SKILLS_DIR",
  "GENET_WORKSPACE_ROOT",
  "GENEHUB_AGENT_PID",
  "GENEHUB_HOST_PID",
  "GENEHUB_ALLOW_FOREGROUND_IN_SESSION",
];

/** Spawn `daemon run` and wait for the listening JSON line on stdout. */
export function startListeningDaemon(
  daemon: string,
  values: {
    dataDir: string;
    workspaceDir: string;
    log: string;
    agent?: string;
  },
  timeoutMs = 120_000,
): Promise<StartedDaemon> {
  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    let settled = false;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...daemonEnvironment(daemon, values),
    };
    // The runner may be an Agent's tool. This daemon belongs to the test, and
    // `daemon run` refuses to start under an inherited Agent session.
    for (const key of AGENT_SESSION_CONTEXT) delete env[key];
    const child = spawn(daemon, ["daemon", "run"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      const tail = stderr.join("").trim();
      reject(tail ? new Error(`${error.message}\n${tail}`) : error);
    };
    const timer = setTimeout(() => {
      fail(new Error("the daemon never reported a port"));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      fail(
        new Error(
          `the daemon exited before listening (code ${code}, signal ${signal})`,
        ),
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      process.stderr.write(`[daemon] ${chunk}`);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        let frame: {
          event?: string;
          url?: string;
          serverProof?: string;
          admission?: Omit<StartedDaemon["localServerProof"], "proof">;
        };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          continue;
        }
        if (frame.event !== "listening" || !frame.url || !frame.serverProof || !frame.admission) {
          continue;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners("exit");
        resolve({
          process: child,
          async stop() {
            // The product stop command verifies this isolated daemon and retires
            // its child tree. Killing just the host strands external agents.
            await promisify(execFile)(daemon, ["daemon", "stop"], {
              env: { ...process.env, ...daemonEnvironment(daemon, values) }, timeout: 15000,
            });
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("stopped daemon did not exit")), 5000);
              child.once("exit", () => { clearTimeout(timer); resolve(); });
            });
          },
          url: frame.url,
          localServerProof: { proof: frame.serverProof, ...frame.admission },
        });
      }
    });
  });
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

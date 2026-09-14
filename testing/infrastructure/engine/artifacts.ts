import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Where a run finds the product it is testing, and how it makes sure that
 * build is the tree's current one.
 *
 * The lookup order is stated once here. It used to be spelled out in the CLI
 * driver, in the run's artifact identity and in whatever else needed a
 * binary, and the copies are what let a stale `target/iterate` build shadow a
 * freshly compiled `target/debug` one: every case passed against code nobody
 * had recompiled, and the run still called itself green.
 */
const PROFILES = ["iterate", "debug", "release"] as const;

/** The runtime artifacts a daemon-backed case needs. */
export const GENET = "genet";
export const HOST = "genehub-host-local";
export const DAEMON_COMPONENT = "genehub_guest.wasm";

interface ArtifactSpec {
  /** Candidate file names, most specific first. */
  names: string[];
  /** Path segments under `target/` that hold one profile's output. */
  profileDir: (profile: string) => string[];
  /** Environment variables that name an explicit build, checked first. */
  overrides: string[];
  /**
   * The cargo invocation that produces the file the drivers will pick. It
   * builds the `iterate` profile because that is what they try first.
   */
  build: string[];
}

const SPECS: Record<string, ArtifactSpec> = {
  [GENET]: {
    names: ["genet-local", "genet-dev", "genet-beta", "genet"],
    profileDir: (profile) => [profile],
    overrides: ["GENET_E2E_DAEMON"],
    build: ["build", "--profile", "iterate", "-p", "genet-cli"],
  },
  [HOST]: {
    names: ["genehub-host-local"],
    profileDir: (profile) => [profile],
    overrides: ["GENEHUB_HOST"],
    build: ["build", "--profile", "iterate", "-p", "genehub-host"],
  },
  [DAEMON_COMPONENT]: {
    names: ["genehub_guest.wasm"],
    profileDir: (profile) => ["wasm32-wasip2", profile],
    overrides: ["GENEHUB_LOCAL_COMPONENT", "GENEHUB_LOCAL_DAEMON_COMPONENT"],
    build: ["build", "--profile", "iterate", "-p", "genehub-guest", "--target", "wasm32-wasip2"],
  },
};

export interface RuntimeArtifact {
  name: string;
  /** The file the drivers will actually pick, or `null` when none exists. */
  path: string | null;
  /** True when an environment variable chose the file instead of the tree. */
  overridden: boolean;
  /** How to produce it, as a shell line a human can copy. */
  buildCommand: string;
}

function fileAt(candidate: string): string | undefined {
  try {
    return statSync(candidate).isFile() ? path.resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this module knows how to locate a name a case declared. */
export function isRuntimeArtifact(name: string): boolean {
  return Object.hasOwn(SPECS, name);
}

function spec(name: string): ArtifactSpec {
  const found = SPECS[name];
  if (!found) throw new Error(`unknown runtime artifact: ${name}`);
  return found;
}

/** Candidate file names for one artifact, in the order the drivers try them. */
export function runtimeArtifactCandidates(openRoot: string, name: string): string[] {
  const found = spec(name);
  const suffix = process.platform === "win32" && !name.endsWith(".wasm") ? ".exe" : "";
  return PROFILES.flatMap((profile) =>
    found.names.map((candidate) =>
      path.resolve(openRoot, "target", ...found.profileDir(profile), `${candidate}${suffix}`),
    ),
  );
}

/**
 * Resolves one runtime artifact exactly the way the drivers do, so a check
 * and a case can never disagree about which file is in play.
 */
export function locateRuntimeArtifact(openRoot: string, name: string): RuntimeArtifact {
  const found = spec(name);
  const buildCommand = `cargo ${found.build.join(" ")}`;
  for (const variable of found.overrides) {
    const override = process.env[variable]?.trim();
    if (!override) continue;
    return { name, path: fileAt(override) ?? null, overridden: true, buildCommand };
  }
  for (const candidate of runtimeArtifactCandidates(openRoot, name)) {
    const resolved = fileAt(candidate);
    if (resolved) return { name, path: resolved, overridden: false, buildCommand };
  }
  return { name, path: null, overridden: false, buildCommand };
}

export interface ArtifactProblem {
  name: string;
  detail: string;
  buildCommand: string;
}

/**
 * Makes the tree's current build present, then reports what is still absent.
 *
 * Asking cargo is the whole point. File timestamps cannot answer "is this
 * binary current": cargo leaves an up-to-date artifact untouched, so a
 * timestamp rule both accuses innocent artifacts and, worse, cannot be
 * satisfied by running the rebuild it just recommended. Cargo owns the
 * dependency graph, so let it decide and keep the answer trustworthy; an
 * up-to-date tree costs about a second.
 *
 * An overridden artifact is never built: the caller pointed at a specific file
 * on purpose, and this has no standing to replace it.
 */
export function ensureRuntimeArtifacts(
  openRoot: string,
  names: string[],
  options: { build: boolean },
): ArtifactProblem[] {
  const problems: ArtifactProblem[] = [];
  const cargo = process.env.CARGO?.trim() || "cargo";
  for (const name of names) {
    const artifact = locateRuntimeArtifact(openRoot, name);
    if (artifact.overridden) {
      if (!artifact.path) {
        problems.push({
          name,
          detail: `${spec(name).overrides.join(" or ")} names a file that does not exist`,
          buildCommand: artifact.buildCommand,
        });
      }
      continue;
    }
    if (options.build) {
      const built = spawnSync(cargo, spec(name).build, {
        cwd: openRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (built.error || built.status !== 0) {
        problems.push({
          name,
          detail: built.error
            ? `${cargo} could not run: ${built.error.message}`
            : lastLines(`${built.stdout ?? ""}${built.stderr ?? ""}`),
          buildCommand: artifact.buildCommand,
        });
        continue;
      }
    }
    if (!locateRuntimeArtifact(openRoot, name).path) {
      problems.push({
        name,
        detail: `not found under ${path.join(openRoot, "target")}`,
        buildCommand: artifact.buildCommand,
      });
    }
  }
  return problems;
}

function lastLines(output: string, keep = 12): string {
  const lines = output.trimEnd().split("\n");
  return lines.slice(-keep).join("\n");
}

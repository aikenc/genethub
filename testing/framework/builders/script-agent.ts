import {
  appendFileSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BlockedError,
  pinnedPythonRuntimeCache,
  readPinnedPythonRuntime,
  type EnvironmentLease,
  type PinnedPythonRuntime,
} from "../../infrastructure/public.ts";

const OPEN_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../fixtures/script-agent/", import.meta.url));
/** The pinned build the shipped install script installs, read from it. */
export type PinnedScriptAgentRuntime = PinnedPythonRuntime;

export function pinnedScriptAgentRuntime(openRoot = OPEN_ROOT): PinnedScriptAgentRuntime {
  return readPinnedPythonRuntime(openRoot);
}

/** The pinned interpreter tree in the host cache. */
export function cachedScriptAgentRuntime(openRoot = OPEN_ROOT): string {
  return pinnedPythonRuntimeCache(openRoot).tree;
}

export interface SeededScriptAgentRuntime {
  /** `<data>/agents/runtime/python-<version>-<release>`. */
  dir: string;
  python: string;
  /** See `scriptAgentRuntimeIdentity`. */
  identity: string;
}

/**
 * Puts a private copy of the pinned build where the installer would, and
 * records it in `python.json` the way the installer does, so the daemon finds
 * a platform Python without anything being downloaded. A copy, not a link:
 * the interpreter writes bytecode into its own tree, and neither that nor a
 * later installer run may reach the shared cache.
 */
export function seedScriptAgentRuntime(lease: EnvironmentLease, openRoot = OPEN_ROOT): SeededScriptAgentRuntime {
  const pinned = pinnedScriptAgentRuntime(openRoot);
  const dir = path.join(lease.data, "agents", "runtime", pinned.dirName);
  if (!existsSync(dir)) {
    const source = cachedScriptAgentRuntime(openRoot);
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(source, dir, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      mode: fsConstants.COPYFILE_FICLONE,
    });
  }
  const python = path.join(dir, "bin", "python3");
  writeFileSync(path.join(path.dirname(dir), "python.json"), `${JSON.stringify({ python })}\n`);
  return { dir, python, identity: scriptAgentRuntimeIdentity(dir) };
}

const unseeded = new Set<string>();
let cacheUnavailable = false;

/** For a case about the runtime install itself: daemons started on this
 * lease get no seeded runtime, so its data directory is a fresh machine's
 * (no `python.json`). */
export function keepScriptAgentRuntimeUnseeded(lease: EnvironmentLease): void {
  unseeded.add(path.resolve(lease.data));
}

/**
 * What `startDaemon` does for every lease: any daemon lists Agents as soon
 * as a client asks, which starts every script Agent, and those need the
 * platform Python the installer would have put there. When the cache cannot
 * be had (cold and offline) the lease stays as a fresh machine would be; a
 * case that needs a working runtime calls `seedScriptAgentRuntime` itself and
 * is blocked there.
 */
export function seedScriptAgentRuntimeByDefault(lease: EnvironmentLease, openRoot = OPEN_ROOT): void {
  if (cacheUnavailable || unseeded.has(path.resolve(lease.data))) return;
  try {
    seedScriptAgentRuntime(lease, openRoot);
  } catch (error) {
    if (!(error instanceof BlockedError)) throw error;
    cacheUnavailable = true;
  }
}

/** Changes whenever the installer replaces the tree (it removes the old one
 * and moves a freshly unpacked one in), which is what a download does. */
export function scriptAgentRuntimeIdentity(dir: string): string {
  try {
    const tree = statSync(dir);
    const python = statSync(realpathSync(path.join(dir, "bin", "python3")));
    return `${tree.dev}:${tree.ino}/${python.dev}:${python.ino}`;
  } catch {
    return "missing";
  }
}

/** What `testing/fixtures/script-agent/agent.py` reads from `control.json`. */
export interface ScriptAgentControl {
  profile: ScriptAgentProfile;
  providerBaseUrl?: string;
  providerDialect?: "openai" | "anthropic";
  chunks?: number;
  /** Non-secret expected text in a resumed public conversation question. */
  expectedResume?: string;
  questionCount?: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; llmRounds: number; tokenUsageStatus: "reported" | "partial" | "unavailable" };
  delayMs?: number;
  floods?: number;
  processTree?: boolean;
  /** The profile's fault fires once per state directory, then the Agent behaves normally. */
  once?: boolean;
  ignoreSigterm?: boolean;
}

/** Serve-protocol behaviours of the fixture script. Each is something a
 * script or the CLI behind it is free to do; none is a switch in the product. */
export type ScriptAgentProfile =
  /** Answers every turn with `chunks` chunks and turnCompleted. */
  | "normal"
  /** Calls the real public CLI with its Session controller identity, then stops. */
  | "cli-question"
  | "provider-cli"
  | "native-question"
  /** Emits a planApproval request; continues when sent the approval prompt. */
  | "native-plan"
  /** One chunk, then the serve process exits with no terminal event. */
  | "exit-without-terminal"
  /** Like exit-without-terminal, leaving a grandchild that inherited every
   * inheritable descriptor (a shim's real program). */
  | "grandchild-holds-stdio"
  /** Accepts the turn, says one chunk, never ends it. Honours interrupt. */
  | "accept-then-silent"
  /** Two chunks 150ms apart, then silent. Honours interrupt. */
  | "burst-then-silent"
  /** A long reasoning item, then never answers turn or interrupt. */
  | "reasoning-ignore-interrupt"
  /** Never ends the turn; `session.interrupt` is never answered. */
  | "ignore-interrupt"
  /** Turns complete; `session.setModel` is never answered. */
  | "ignore-set-model"
  /** `session.start` is never answered. */
  | "hang-session-new"
  /** After `session.start`, the process stops reading the protocol pipe. */
  | "stdin-never-drains"
  /** One turn emits `floods` events, then completes. */
  | "flood-events"
  /** The process exits before it can answer `initialize`. */
  | "crash-on-start"
  /** Not ready until the `login` action stores sha256(secret) in its state dir. */
  | "login"
  /** Ready; also offers actions that open Agent-level requests: one held at a
   * crash (`crash-now` in the state dir ends the process), three over the
   * size bounds followed by a sentinel, and nine at once. */
  | "requests"
  /** Resumable actions with a real owned child and independent effect receipts. */
  | "durable";

export interface ScriptAgentHandle {
  agentId: string;
  dir: string;
  stateDir: string;
  journalPath: string;
}

export interface ScriptAgentJournalEntry {
  ts: number;
  pid: number;
  ppid: number;
  profile: string;
  event: string;
  [key: string]: unknown;
}

/**
 * Writes the fixture Agent as `<data>/agents/user/<id>/` with its control file,
 * and seeds the runtime. Before daemon start it is picked up by the start-up
 * scan; afterwards `agent.reload {agentId}` picks it up.
 */
export function installScriptAgent(
  lease: EnvironmentLease,
  input: { id: string; control: ScriptAgentControl; openRoot?: string },
): ScriptAgentHandle {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(input.id)) throw new Error(`not a script Agent id: ${input.id}`);
  seedScriptAgentRuntime(lease, input.openRoot);
  const agents = path.join(lease.data, "agents");
  const dir = path.join(agents, "user", input.id);
  mkdirSync(dir, { recursive: true });
  for (const name of ["agent.toml", "agent.py"]) copyFileSync(path.join(FIXTURE, name), path.join(dir, name));
  const handle: ScriptAgentHandle = {
    agentId: input.id,
    dir,
    stateDir: path.join(agents, "state", input.id),
    journalPath: path.join(lease.root, `script-agent-${input.id}.ndjson`),
  };
  writeScriptAgentControl(handle, input.control);
  appendFileSync(handle.journalPath, "");
  return handle;
}

export function writeScriptAgentControl(handle: ScriptAgentHandle, control: ScriptAgentControl): void {
  writeFileSync(
    path.join(handle.dir, "control.json"),
    JSON.stringify({ ...control, journal: handle.journalPath }, null, 2),
    { mode: 0o600 },
  );
}

/** Replaces `agent.toml` with one the daemon must refuse (`protocol = 99`). */
export function breakScriptAgentManifest(handle: ScriptAgentHandle): void {
  copyFileSync(path.join(FIXTURE, "invalid.agent.toml"), path.join(handle.dir, "agent.toml"));
}

export function readScriptAgentJournal(handle: { journalPath: string }): ScriptAgentJournalEntry[] {
  if (!existsSync(handle.journalPath)) return [];
  return readFileSync(handle.journalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ScriptAgentJournalEntry];
      } catch {
        return [];
      }
    });
}

/** The third-party CLIs the built-in script Agents look for on PATH. */
export const HOST_AGENT_CLIS = ["codex", "cursor-agent"];

/**
 * Keeps this machine's own Agent CLIs away from the daemon a case starts.
 * The built-in scripts probe any CLI they find on PATH and list models from
 * the account behind it, so a case that is not about those CLIs would depend
 * on what is installed and logged in here. GeneHub only updates a cursor CLI
 * its own install action recorded as `installedByGenehub`, but cursor-agent
 * updates itself when run: it downloads into the lease home and leaves a
 * detached `cleanup-install-versions` process behind.
 */
export function hideHostAgentClis(lease: EnvironmentLease, keep: string[] = []): void {
  lease.env.PATH = pathWithout(
    HOST_AGENT_CLIS.filter((name) => !keep.includes(name)),
    lease.env.PATH ?? process.env.PATH ?? "",
  );
}

/** PATH without any directory that holds the named executables, for a case
 * whose fact is "this CLI is not installed". */
export function pathWithout(names: string[], current = process.env.PATH ?? ""): string {
  return current
    .split(path.delimiter)
    .filter((dir) => dir && !names.some((name) => existsSync(path.join(dir, name))))
    .join(path.delimiter);
}

/** The fault profiles the session-level specialties drive through
 * `openControlledAgentSession`. */
export type ControlledAgentProfile = Exclude<ScriptAgentProfile, "crash-on-start" | "login" | "requests">;

export interface ControlledAgentOptions extends Omit<ScriptAgentControl, "profile"> {
  profile: ControlledAgentProfile;
  /** The user-layer directory name, which is also the Agent id. */
  id?: string;
}

export interface ControlledAgentHandle extends ScriptAgentHandle {
  profile: ControlledAgentProfile;
}

export type ControlledAgentJournalEntry = ScriptAgentJournalEntry;

/** Installs the fixture script Agent with one fault profile and hides the
 * host's Agent CLIs from the daemon. Must run before the daemon starts, which
 * picks up `user/` directories when it scans. */
export function registerControlledAgent(
  lease: EnvironmentLease,
  options: ControlledAgentOptions,
): ControlledAgentHandle {
  const { id, profile, ...rest } = options;
  hideHostAgentClis(lease);
  const handle = installScriptAgent(lease, { id: id ?? `ctl-${profile}`, control: { profile, ...rest } });
  return { ...handle, profile };
}

export const readControlledAgentJournal = readScriptAgentJournal;

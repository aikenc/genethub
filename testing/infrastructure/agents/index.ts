import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EnvironmentLease } from "../environment/lease.ts";

/** What a real ACP CLI is free to do to a turn that is already in flight.
 * Each name is one externally observable misbehaviour, never a switch inside
 * the product. */
export type ControlledAgentProfile =
  /** Answers normally. The control case every fault is compared against. */
  | "normal"
  /** Emits one chunk, then exits with no terminal frame: stdout reaches EOF. */
  | "exit-without-terminal"
  /** The same exit, but a grandchild keeps stdout open, so there is no EOF. */
  | "grandchild-holds-stdout"
  /** Accepts the turn and never answers. Honours a cancel. */
  | "accept-then-silent"
  /** Never answers the turn and never answers a cancel. */
  | "ignore-interrupt"
  /** Also ignores SIGTERM, so only an escalation to SIGKILL ends it. */
  | "ignore-sigterm"
  /** Stops draining stdin after the handshake, so a large prompt blocks. */
  | "stdin-never-drains"
  /** Emits far more events in one turn than a client can consume. */
  | "flood-events";

export interface ControlledAgentOptions {
  profile: ControlledAgentProfile;
  /** The `agents.custom` key. The daemon exposes it as `acp:<id>`. */
  id?: string;
  /** Visible chunks before the profile's fault fires. */
  chunks?: number;
  /** Held before the profile answers or goes quiet. */
  delayMs?: number;
  /** Events emitted by `flood-events`. */
  floods?: number;
}

export interface ControlledAgentHandle {
  /** The id to pass to `session.create`. */
  agentId: string;
  profile: ControlledAgentProfile;
  journalPath: string;
}

export interface ControlledAgentJournalEntry {
  ts: number;
  pid: number;
  ppid: number;
  profile: string;
  event: string;
  [key: string]: unknown;
}

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "controlled-agent.mjs");

/** Declares the controlled agent in the daemon's own config file.
 *
 * This must run before the daemon starts: the adapter registry is built once
 * from `agents.custom` at startup. Writing config rather than reaching into
 * the registry is the point — the case exercises the same path a user takes
 * to register any third-party ACP CLI.
 */
export function registerControlledAgent(
  lease: EnvironmentLease,
  options: ControlledAgentOptions,
): ControlledAgentHandle {
  const id = options.id ?? `controlled-${options.profile}`;
  const journalPath = path.join(lease.root, `controlled-agent-${id}.ndjson`);
  const command = [
    process.execPath,
    SCRIPT,
    "--profile",
    options.profile,
    "--journal",
    journalPath,
  ];
  if (options.chunks !== undefined) command.push("--chunks", String(options.chunks));
  if (options.delayMs !== undefined) command.push("--delay-ms", String(options.delayMs));
  if (options.floods !== undefined) command.push("--floods", String(options.floods));

  const configPath = path.join(lease.data, "config.json");
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const custom = (agents.custom ?? {}) as Record<string, unknown>;
  custom[id] = { extends: "acp", command, label: `Controlled ${options.profile}` };
  agents.custom = custom;
  config.agents = agents;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  appendFileSync(journalPath, "");

  return { agentId: `acp:${id}`, profile: options.profile, journalPath };
}

/** What the agent process recorded about itself: the only self-report the
 * cases trust, and the only way to learn the pid of a process that is
 * supposed to be gone. */
export function readControlledAgentJournal(
  handle: ControlledAgentHandle,
): ControlledAgentJournalEntry[] {
  if (!existsSync(handle.journalPath)) return [];
  return readFileSync(handle.journalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ControlledAgentJournalEntry];
      } catch {
        return [];
      }
    });
}

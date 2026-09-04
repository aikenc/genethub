import {
  readControlledAgentJournal,
  registerControlledAgent,
  type ControlledAgentHandle,
  type ControlledAgentJournalEntry,
  type ControlledAgentOptions,
  type EnvironmentLease,
} from "../../../infrastructure/public.ts";
import {
  createAgentSession,
  openWorkspace,
  requireAgentReady,
  type ProductSession,
} from "../main/index.ts";

/** Terminal round outcomes as they appear on the wire. A round that reaches
 * neither is the freeze this whole group of cases is about. */
const TERMINAL = new Set(["turnCompleted", "turnFailed"]);

export interface ControlledAgentSession {
  agent: ControlledAgentHandle;
  client: ProductSession["client"];
  daemon: ProductSession["daemon"];
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  /** Every event this client received, live or replayed after a gap, in
   * arrival order. Replays are included because a client that ignored them
   * would be a broken client, not evidence about the product. */
  events: Array<{ type?: string; raw: unknown }>;
  /** How many times the daemon told this client it had fallen behind. */
  resyncs(): number;
  /** The status carried by the most recent resync snapshot, if any. */
  resyncStatus(): string | undefined;
  /** What the agent process recorded about itself. */
  journal(): ControlledAgentJournalEntry[];
  /** The first terminal round event, if one ever arrived. */
  terminal(): { type?: string; raw: unknown } | undefined;
  /** Resolves when a round ends either way; rejects on timeout. A case that
   * expects a freeze calls `terminal()` after a bounded wait instead. */
  waitForTerminal(timeoutMs?: number): Promise<{ type?: string; raw: unknown }>;
  /** The daemon's own answer, not the client's mirror of it. */
  daemonStatus(): Promise<string>;
  /** The running turn's last sign of life, as the daemon reports it. */
  daemonLastActivityMs(): Promise<number | null>;
  dispose(): Promise<void>;
}

/** Opens a session against an ACP agent that will misbehave in one named way.
 *
 * The agent is declared in the daemon's config before it starts, so the
 * product resolves and launches it exactly as it would any third-party CLI.
 */
export async function openControlledAgentSession(input: {
  openRoot: string;
  lease: EnvironmentLease;
  agent: ControlledAgentOptions;
}): Promise<ControlledAgentSession> {
  const agent = registerControlledAgent(input.lease, input.agent);
  const opened = await openWorkspace({ openRoot: input.openRoot, lease: input.lease });
  try {
    await requireAgentReady(opened.client, agent.agentId);
    const sessionId = await createAgentSession(opened.client, {
      workspaceId: opened.workspaceId,
      agentId: agent.agentId,
      modelId: null,
    });
    const events: Array<{ type?: string; raw: unknown }> = [];
    const record = (envelope: unknown) => {
      const inner = (envelope as { event?: { type?: string } }).event;
      events.push({ type: inner?.type ?? (envelope as { type?: string }).type, raw: envelope });
    };
    let resyncCount = 0;
    let lastResyncStatus: string | undefined;
    await opened.client.subscribe(sessionId, {
      onEvent: record,
      onResync: (snapshot, replayed) => {
        resyncCount += 1;
        const summary = (snapshot as { summary?: { status?: unknown } } | null)?.summary;
        if (summary?.status !== undefined) lastResyncStatus = String(summary.status);
        for (const event of replayed) record(event);
      },
    });
    return {
      agent,
      client: opened.client,
      daemon: opened.daemon,
      workspaceId: opened.workspaceId,
      workspaceRoot: opened.workspaceRoot,
      sessionId,
      events,
      resyncs: () => resyncCount,
      resyncStatus: () => lastResyncStatus,
      journal: () => readControlledAgentJournal(agent),
      terminal: () => events.find((event) => TERMINAL.has(event.type ?? "")),
      async waitForTerminal(timeoutMs = 20_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const found = events.find((event) => TERMINAL.has(event.type ?? ""));
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`no turnCompleted or turnFailed within ${timeoutMs}ms`);
      },
      async daemonStatus() {
        const reply = await opened.client.call({
          type: "session.get",
          payload: { sessionId },
        });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        return String(reply.data.summary.status);
      },
      async daemonLastActivityMs() {
        const reply = await opened.client.call({
          type: "session.get",
          payload: { sessionId },
        });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        const at = reply.data.summary.lastActivityAtMs;
        return typeof at === "number" ? at : null;
      },
      async dispose() {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      },
    };
  } catch (error) {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
    throw error;
  }
}

/** Wall-clock cost of a control-plane call, whether or not it succeeded.
 *
 * A control call that hangs and one that fails fast are different bugs, and
 * an assertion on the elapsed time is the only thing that tells them apart.
 */
export async function timeControlCall(
  run: () => Promise<unknown>,
): Promise<{ ms: number; outcome: "ok" | "error"; error?: string }> {
  const started = Date.now();
  try {
    await run();
    return { ms: Date.now() - started, outcome: "ok" };
  } catch (error) {
    return { ms: Date.now() - started, outcome: "error", error: String(error) };
  }
}

/** Whether a pid is still on this machine. Used where the fact under test is
 * an OS fact — a process the product promised to reap. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

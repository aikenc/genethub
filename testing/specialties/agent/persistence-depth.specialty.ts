import { readFileSync } from "node:fs";
import path from "node:path";

import {
  defineSpecialty,
  genetEnv,
  locateGenet,
  parseJson,
  runGenet,
  type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type EventLog = Array<{ type?: string; raw: unknown }>;

function terminalCount(events: EventLog): number {
  return events.filter((event) =>
    event.type === "turnCompleted" || event.type === "turnFailed" || event.type === "turnCanceled").length;
}

function persistenceCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, harness: RestartHarness) => Promise<void>,
  expectedDurationMs = 70_000,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "session", "persistence-depth"],
      llm: { default: "mock" },
      expectedDurationMs,
      timeoutMs: 300_000,
      resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 2, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent", "workbench-client"],
      productInterfaces: ["genet-cli", "@genehub/workbench/client"],
    },
    async (t) => {
      const harness = new RestartHarness(t);
      try {
        await run(t, harness);
      } finally {
        await harness.closeAll();
      }
    },
  );
}

class RestartHarness {
  private readonly active = new Set<Opened>();

  constructor(private readonly t: CaseContext) {}

  async boot(): Promise<Opened> {
    const opened = await this.t.flows.main.openWorkspace({ openRoot: this.t.openRoot, lease: this.t.env });
    await this.t.flows.main.configureMockProvider(opened.client, opened.mock);
    this.active.add(opened);
    return opened;
  }

  async restart(opened: Opened): Promise<Opened> {
    await this.close(opened);
    return this.boot();
  }

  async close(opened: Opened): Promise<void> {
    if (!this.active.delete(opened)) return;
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }

  async closeAll(): Promise<void> {
    for (const opened of [...this.active]) await this.close(opened);
  }
}

async function completeTurn(
  t: CaseContext,
  opened: Opened,
  sessionId: string,
  prompt: string,
  reply: string,
  existingEvents?: EventLog,
): Promise<EventLog> {
  opened.mock.script({ text: reply });
  const events = existingEvents ?? await t.flows.main.attachEventLog(opened.client, sessionId);
  const before = terminalCount(events);
  await t.flows.main.sendPrompt(opened.client, sessionId, prompt);
  try {
    await t.tools.waitUntil(() => terminalCount(events) > before, 75_000);
  } catch {
    throw new Error(`turn did not settle for ${JSON.stringify(prompt)}: ${events.map((event) => event.type).join(",")}`);
  }
  t.assertions.assert(events.filter((event) => event.type === "turnFailed").length === 0, `turn failed: ${prompt}`);
  return events;
}

async function snapshot(opened: Opened, sessionId: string): Promise<Extract<Awaited<ReturnType<Opened["client"]["call"]>>, { type: "snapshot" }>> {
  const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
  if (reply?.type !== "snapshot") throw new Error(`session.get ${sessionId} returned ${reply?.type}`);
  return reply;
}

function itemCount(reply: Awaited<ReturnType<typeof snapshot>>): number {
  return reply.data.items.length;
}

persistenceCase(
  "specialty.agent.persistence.four-sessions-survive-restart",
  "Four completed Agent sessions retain exact identities across restart",
  "all four ids, Unicode titles, and non-empty snapshots remain associated with the same workspace",
  ["only most recent session persisted", "title map keyed by list position", "restart replaces session ids"],
  async (t, harness) => {
    let opened = await harness.boot();
    const sessions: Array<{ id: string; title: string }> = [];
    for (let index = 0; index < 4; index += 1) {
      const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, id);
      const title = `持久会话 ${index} 🧬`;
      await opened.client.call({ type: "session.rename", payload: { sessionId: id, title } });
      await completeTurn(t, opened, id, `Complete durable session ${index}.`, `durable-${index}`, events);
      sessions.push({ id, title });
    }
    const workspaceId = opened.workspaceId;
    opened = await harness.restart(opened);
    const listed = await opened.client.call({
      type: "session.list",
      payload: { workspaceId, includeArchived: true },
    });
    t.assertions.assert(listed?.type === "sessions", `session.list returned ${listed?.type}`);
    for (const expected of sessions) {
      const found = listed?.type === "sessions" ? listed.data.find((entry) => entry.id === expected.id) : undefined;
      t.assertions.assert(found?.title === expected.title, `lost session metadata: ${JSON.stringify({ expected, found })}`);
      t.assertions.assert(itemCount(await snapshot(opened, expected.id)) > 0, `session ${expected.id} lost history`);
    }
  },
);

persistenceCase(
  "specialty.agent.persistence.long-history-continues-after-restart",
  "A long conversation continues after daemon restart",
  "eight completed turns survive, then two additional turns grow the same session snapshot",
  ["history truncates at restart", "restored session remains busy", "new turn replaces old timeline"],
  async (t, harness) => {
    let opened = await harness.boot();
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    let events = await t.flows.main.attachEventLog(opened.client, sessionId);
    for (let index = 0; index < 8; index += 1) {
      await completeTurn(t, opened, sessionId, `History before restart ${index}.`, `before-${index}`, events);
    }
    const beforeRestart = itemCount(await snapshot(opened, sessionId));
    opened = await harness.restart(opened);
    const restored = itemCount(await snapshot(opened, sessionId));
    t.assertions.assert(restored === beforeRestart, `restart changed item count ${beforeRestart} -> ${restored}`);
    events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await completeTurn(t, opened, sessionId, "History after restart 0.", "after-0", events);
    await completeTurn(t, opened, sessionId, "History after restart 1.", "after-1", events);
    const continued = itemCount(await snapshot(opened, sessionId));
    t.assertions.assert(continued > restored, `continued history did not grow: ${restored} -> ${continued}`);
  },
  110_000,
);

persistenceCase(
  "specialty.agent.persistence.failed-and-completed-rounds-survive",
  "Failed and completed rounds remain distinct after restart",
  "one provider failure and one later completion persist as separate failed/completed ledger outcomes",
  ["failed round dropped", "later success rewrites prior outcome", "ledger collapses rounds across restart"],
  async (t, harness) => {
    let opened = await harness.boot();
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    opened.mock.script({ status: 500 }, { text: "recovered" });
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Fail this durable round.");
    await t.tools.waitUntil(() => terminalCount(events) === 1, 45_000);
    t.assertions.assert(events.some((event) => event.type === "turnFailed"), "first round did not fail");
    await t.flows.main.sendPrompt(opened.client, sessionId, "Complete the next durable round.");
    await t.tools.waitUntil(() => terminalCount(events) === 2, 45_000);
    t.assertions.assert(events.some((event) => event.type === "turnCompleted"), "second round did not complete");
    opened = await harness.restart(opened);
    const chat = path.join(opened.workspaceRoot, ".genethub", "sessions", sessionId, "chat.jsonl");
    const outcomes = roundOutcomes(readFileSync(chat, "utf8"));
    t.assertions.assert(outcomes.includes("failed"), `failed outcome absent: ${JSON.stringify(outcomes)}`);
    t.assertions.assert(outcomes.includes("completed"), `completed outcome absent: ${JSON.stringify(outcomes)}`);
    t.assertions.assert(itemCount(await snapshot(opened, sessionId)) > 0, "restored snapshot was empty");
  },
);

persistenceCase(
  "specialty.agent.persistence.archived-renamed-session-continues",
  "An archived and renamed session can be restored and continued after restart",
  "Unicode title and archive state persist; unarchive keeps the same id and a new turn completes",
  ["archive deletes history", "rename lost on restart", "unarchive creates replacement session"],
  async (t, harness) => {
    let opened = await harness.boot();
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await completeTurn(t, opened, sessionId, "Persist before archive.", "before archive");
    const title = "归档后继续 🗃️";
    await opened.client.call({ type: "session.rename", payload: { sessionId, title } });
    await opened.client.call({ type: "session.archive", payload: { sessionId, archived: true } });
    opened = await harness.restart(opened);
    const live = await opened.client.call({
      type: "session.list",
      payload: { workspaceId: opened.workspaceId, includeArchived: false },
    });
    const all = await opened.client.call({
      type: "session.list",
      payload: { workspaceId: opened.workspaceId, includeArchived: true },
    });
    t.assertions.assert(live?.type === "sessions" && !live.data.some((entry) => entry.id === sessionId), "archive state was lost");
    const archived = all?.type === "sessions" ? all.data.find((entry) => entry.id === sessionId) : undefined;
    t.assertions.assert(archived?.title === title, `archived title changed: ${JSON.stringify(archived)}`);
    await opened.client.call({ type: "session.archive", payload: { sessionId, archived: false } });
    await completeTurn(t, opened, sessionId, "Continue after restore.", "continued after restore");
    const restored = await snapshot(opened, sessionId);
    t.assertions.assert(restored.data.summary.id === sessionId && restored.data.summary.title === title, "restored identity changed");
  },
);

persistenceCase(
  "specialty.agent.persistence.two-restarts-do-not-duplicate-history",
  "Two consecutive daemon restarts do not duplicate session history",
  "the same snapshot item count survives both restarts and grows only after a new turn",
  ["replay appended as new history", "startup imports ledger twice", "session id remapped per boot"],
  async (t, harness) => {
    let opened = await harness.boot();
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await completeTurn(t, opened, sessionId, "One durable turn.", "one durable reply");
    const original = itemCount(await snapshot(opened, sessionId));
    opened = await harness.restart(opened);
    const once = itemCount(await snapshot(opened, sessionId));
    opened = await harness.restart(opened);
    const twice = itemCount(await snapshot(opened, sessionId));
    t.assertions.assert(once === original && twice === original, `history duplicated ${original}/${once}/${twice}`);
    await completeTurn(t, opened, sessionId, "Grow only now.", "new reply");
    t.assertions.assert(itemCount(await snapshot(opened, sessionId)) > twice, "new turn did not grow stable history");
  },
);

persistenceCase(
  "specialty.agent.persistence.concurrent-sessions-durable",
  "Six concurrent Agent sessions become durable together",
  "all six terminal timelines are readable by exact id after a daemon restart",
  ["concurrent flush loses a session", "ledger writes alias between sessions", "shutdown races pending persistence"],
  async (t, harness) => {
    let opened = await harness.boot();
    const count = 6;
    opened.mock.script(...Array.from({ length: count }, (_, index) => ({ text: `parallel-durable-${index}`, delayMs: 500 })));
    const sessions = await Promise.all(
      Array.from({ length: count }, () => t.flows.main.createBuiltinSession(opened.client, opened.workspaceId)),
    );
    const logs = await Promise.all(sessions.map((sessionId) => t.flows.main.attachEventLog(opened.client, sessionId)));
    await Promise.all(sessions.map((sessionId, index) => t.flows.main.sendPrompt(opened.client, sessionId, `Durable parallel ${index}.`)));
    await t.tools.waitUntil(() => logs.every((events) => events.some((event) => event.type === "turnCompleted")), 60_000);
    opened = await harness.restart(opened);
    for (const sessionId of sessions) {
      t.assertions.assert(itemCount(await snapshot(opened, sessionId)) > 0, `concurrent session ${sessionId} was not durable`);
    }
  },
  85_000,
);

// Every case above restarts between turns, which is the easy half of
// durability. These two restart during one, because that is when a user
// actually closes the window: an answer is arriving, it is taking a while, and
// they quit. Whatever was already on screen was, as far as they know, said.
//
// The agent is a real external ACP CLI that speaks once and then stops
// talking, so the quit lands with narrative delivered and the round still
// open — no product internal is stubbed to arrange it.

type ControlledAgent = Awaited<
  ReturnType<CaseContext["flows"]["branches"]["openControlledAgentSession"]>
>;

/** What the agent says before it falls silent, and therefore the word that
 * has to survive. Matched against the whole item rather than a parsed text
 * field: the question is whether the sentence is still there at all. */
const SPOKEN = "thinking";

function timesSaid(items: unknown[]): number {
  return items.filter((item) => JSON.stringify(item).includes(SPOKEN)).length;
}

function midTurnDurabilityCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  agentId: string,
  endTheDaemon: (t: CaseContext, session: ControlledAgent) => Promise<void>,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "session", "persistence-depth", "fault-injection"],
      llm: { default: "none" },
      expectedDurationMs: 40_000,
      timeoutMs: 160_000,
      resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 2, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent-adapter", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agents.custom"],
    },
    async (t) => {
      const session = await t.flows.branches.openControlledAgentSession({
        openRoot: t.openRoot,
        lease: t.env,
        agent: { profile: "accept-then-silent", id: agentId },
      });
      const opened: Opened[] = [];
      const reopen = async (): Promise<unknown[]> => {
        const next = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
        opened.push(next);
        const reply = await next.client.call({
          type: "session.get",
          payload: { sessionId: session.sessionId },
        });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        return reply.data.items;
      };
      try {
        await t.flows.main.sendPrompt(session.client, session.sessionId, "Say something, then stall.");
        await t.tools
          .waitUntil(() => timesSaid(session.events.map((event) => event.raw)) > 0, 20_000)
          .catch(() => {
            throw new Error(
              `the agent never reached the client: ${session.events.map((event) => event.type).join(",")}`,
            );
          });
        // The round is deliberately still open here: the fault under test is
        // what a quit costs, not what a completed turn keeps.
        t.assertions.assert(
          session.terminal() === undefined,
          "the round ended on its own, so this case never tested a quit mid-turn",
        );
        session.client.close();
        await endTheDaemon(t, session);

        const restored = await reopen();
        t.assertions.assert(
          timesSaid(restored) === 1,
          `the restored session should carry what was said exactly once: ${JSON.stringify(restored)}`,
        );
        // Recovering an unfinished turn moves it into the log, and a second
        // start must find that move already done rather than repeat it.
        opened[0]!.client.close();
        opened[0]!.daemon.stop();
        const again = await reopen();
        t.assertions.assert(
          timesSaid(again) === 1,
          `a second start duplicated the recovered turn: ${JSON.stringify(again)}`,
        );
      } finally {
        for (const each of opened) {
          each.client.close();
          each.daemon.stop();
          await each.mock.stop();
        }
        await session.dispose();
      }
    },
  );
}

midTurnDurabilityCase(
  "specialty.agent.persistence.quitting-mid-turn-keeps-what-was-said",
  "Quitting while an answer is arriving keeps the part that arrived",
  "an assistant message the client had already rendered is still in the snapshot after an ordinary daemon stop mid-turn and a restart",
  [
    "narrative reaches disk only when the turn ends",
    "shutdown closes the agent without flushing the open turn",
    "the restored session shows the prompt with no answer",
  ],
  "durable-quit",
  async (_t, session) => {
    // The tray's own exit path: `genet daemon stop`, not a signal.
    session.daemon.stop();
  },
);

midTurnDurabilityCase(
  "specialty.agent.persistence.crashing-mid-turn-keeps-what-was-said",
  "A crash while an answer is arriving keeps the part that arrived",
  "an assistant message the client had already rendered is still in the snapshot after the daemon is SIGKILLed mid-turn and restarted",
  [
    "the open turn exists only in memory until it settles",
    "a crash costs a turn the user had already read",
    "restart reports the session intact while its answer is gone",
  ],
  "durable-crash",
  async (t, _session) => {
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, t.env.env);
    const status = parseJson(runGenet(genet, ["daemon", "status"], env).stdout);
    const pid = Number(status.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no daemon pid: ${JSON.stringify(status)}`);
    process.kill(pid, "SIGKILL");
    await t.tools.waitUntil(
      () => parseJson(runGenet(genet, ["daemon", "status"], env).stdout).running === false,
      15_000,
    );
  },
);

function roundOutcomes(contents: string): string[] {
  const outcomes: string[] = [];
  for (const line of contents.split("\n").filter((item) => item.trim())) {
    try {
      const row = JSON.parse(line) as { t?: string; round?: { outcome?: string } };
      if (row.t === "round" && typeof row.round?.outcome === "string") outcomes.push(row.round.outcome);
    } catch {
      // Malformed rows remain observable through the missing expected outcomes.
    }
  }
  return outcomes;
}

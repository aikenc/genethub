// A round that never ends is the freeze users report, and every way it
// happens starts outside the product: an agent CLI that exits without a
// terminal frame, dies behind a grandchild that still holds the pipe, or
// says far more than the channel between us can carry.
//
// The agent under these cases is a real external process registered through
// `agents.custom`, the same door a user opens for Goose or any other ACP CLI.
// Nothing inside the daemon is stubbed: what varies is only what a CLI is
// free to do to a turn already in flight.

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type ControlledAgent = Awaited<
  ReturnType<CaseContext["flows"]["branches"]["openControlledAgentSession"]>
>;
type AgentOptions = Parameters<
  CaseContext["flows"]["branches"]["openControlledAgentSession"]
>[0]["agent"];

function wedgeCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  agent: AgentOptions,
  run: (t: CaseContext, session: ControlledAgent) => Promise<void>,
  durationMs = 25_000,
  // Raised only for the case that pushes thousands of events through a real
  // transport: sharing a machine with nine other environments is what made
  // that one slow enough to look like a hang.
  cpu = 1,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.wedge.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "wedge-depth", "fault-injection"],
      llm: { default: "none" },
      expectedDurationMs: durationMs,
      timeoutMs: durationMs * 4,
      resources: { environments: 1, cpu, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent-adapter", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agents.custom"],
    },
    async (t) => {
      const session = await t.flows.branches.openControlledAgentSession({
        openRoot: t.openRoot,
        lease: t.env,
        agent,
      });
      try {
        await run(t, session);
      } finally {
        await session.dispose();
      }
    },
  );
}

/** The fault has to have actually fired. Without this, a case that passes
 * because the agent never got the prompt would read as a product success. */
function assertPromptReached(t: CaseContext, session: ControlledAgent): void {
  const journal = session.journal();
  t.assertions.assert(
    journal.some((entry) => entry.event === "prompt"),
    `the controlled agent never received a prompt: ${JSON.stringify(journal)}`,
  );
}

wedgeCase(
  "control-normal-round-ends",
  "A well-behaved ACP agent ends its round",
  "an agents.custom ACP CLI that answers session/prompt produces turnCompleted and leaves the session sendable",
  ["controlled-agent harness does not speak ACP", "custom agent registration regressed"],
  { profile: "normal", id: "wedge-normal", chunks: 3 },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "hello");
    const terminal = await session.waitForTerminal(20_000);
    t.assertions.assert(
      terminal.type === "turnCompleted",
      `expected turnCompleted, got ${terminal.type}`,
    );
    const status = await session.daemonStatus();
    t.assertions.assert(status === "idle", `session did not return to idle: ${status}`);
    t.note(`control: ${session.events.map((event) => event.type).join(",")}`);
  },
);

wedgeCase(
  "exit-without-terminal",
  "An agent that exits mid-turn still ends the round",
  "after the agent process is gone, the session emits a terminal round event within 15s and reports a non-running status",
  [
    "ACP read loop leaves the pending session/prompt sender alive at EOF",
    "no synthesized TurnFailed when an agent dies mid-turn",
    "session pinned to running with no live process",
  ],
  { profile: "exit-without-terminal", id: "wedge-exit" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "please crash");
    await t.tools.waitUntil(
      () => session.journal().some((entry) => entry.event === "exit"),
      10_000,
    );
    assertPromptReached(t, session);

    const terminal = await session.waitForTerminal(15_000);
    t.assertions.assert(
      terminal.type === "turnFailed",
      `a dead agent must fail the round, not ${terminal.type}`,
    );
    const status = await session.daemonStatus();
    t.assertions.assert(status !== "running", `session still running after the agent died: ${status}`);
  },
);

wedgeCase(
  "grandchild-holds-stdout",
  "A round ends even when no EOF ever arrives",
  "the agent exits leaving a grandchild holding stdout; the round still reaches a terminal event within 15s and the grandchild is gone after session.close",
  [
    "termination detection depends on stdout EOF",
    "shim-shaped agents (npm/.cmd wrappers) never close the pipe",
    "grandchild survives session close",
  ],
  { profile: "grandchild-holds-stdout", id: "wedge-grandchild" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "please crash quietly");
    await t.tools
      .waitUntil(() => session.journal().some((entry) => entry.event === "orphan-spawned"), 10_000)
      .catch(() => {
        throw new Error(
          `the agent never reported a grandchild: ${session
            .journal()
            .map((entry) => `${entry.pid}:${entry.event}`)
            .join(" ")}`,
        );
      });
    const orphanPid = Number(
      session.journal().find((entry) => entry.event === "orphan-spawned")?.orphanPid ?? 0,
    );
    t.assertions.assert(orphanPid > 0, "the controlled agent did not report a grandchild pid");

    try {
      const terminal = await session.waitForTerminal(15_000);
      t.assertions.assert(
        terminal.type === "turnFailed",
        `a dead agent must fail the round, not ${terminal.type}`,
      );
      const status = await session.daemonStatus();
      t.assertions.assert(status !== "running", `session still running: ${status}`);

      await session.client.call({ type: "session.close", payload: { sessionId: session.sessionId } });
      await t.tools
        .waitUntil(() => !t.flows.branches.processAlive(orphanPid), 10_000)
        .catch(() => {
          throw new Error(`grandchild ${orphanPid} outlived session.close`);
        });
    } finally {
      // The grandchild is deliberately outside the daemon's direct child set;
      // leaking it into the next case would be this file's own bug.
      if (t.flows.branches.processAlive(orphanPid)) {
        try {
          process.kill(orphanPid, "SIGKILL");
        } catch {
          // Already reaped between the check and the signal.
        }
      }
    }
  },
);

wedgeCase(
  "long-silence-is-not-death",
  "A long quiet turn is allowed to finish",
  "an agent that says nothing for 15s has its silence reported and is left running, then answers with turnCompleted",
  [
    "silence treated as death",
    "a healthy long-running turn killed by an inactivity timer",
    "a silence nobody can see, so slow and wedged look the same",
    "an age reported for a session that has already finished",
  ],
  { profile: "normal", id: "wedge-slow", chunks: 1, delayMs: 15_000 },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "think for a while");

    // Mid-silence, the daemon has to be able to say how long it has been quiet
    // — and to be still running while it says so. Both halves matter: an age
    // that is never reported leaves the user guessing, which is the "又卡住了"
    // report, and a turn ended on account of its age is the freeze's cure being
    // worse than the freeze.
    await t.tools.waitUntil(async () => {
      const at = await session.daemonLastActivityMs();
      return at !== null && Date.now() - at > 5_000;
    }, 20_000);
    const quietFor = Date.now() - ((await session.daemonLastActivityMs()) ?? Date.now());
    t.assertions.assert(
      (await session.daemonStatus()) === "running",
      `a turn quiet for ${quietFor}ms was not left alone`,
    );
    t.note(`reported quiet for ${quietFor}ms while still running`);

    const terminal = await session.waitForTerminal(40_000);
    t.assertions.assert(
      terminal.type === "turnCompleted",
      `a slow but healthy turn must complete, not ${terminal.type}`,
    );
    // And once it is over there is nothing to be quiet about: an age on a
    // finished session reads as a problem where there is none.
    await t.tools.waitUntil(async () => (await session.daemonLastActivityMs()) === null, 10_000);
  },
  60_000,
);

wedgeCase(
  "a-flood-still-leaves-the-client-knowing-the-turn-ended",
  "A client still learns a turn ended after an event flood",
  "after a turn emitting 4000 events, the daemon settles to idle and the subscriber ends up knowing the turn is over, by terminal event or by the snapshot a declared gap hands it",
  [
    "terminal events share a lossy broadcast with streaming deltas",
    "a lagged subscriber loses the only settlement signal",
    "a declared gap is announced but never actually repaired",
  ],
  { profile: "flood-events", id: "wedge-flood", floods: 4000 },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "say a lot");
    // The daemon settling is the first half: if its own answer is still
    // `running`, no amount of client repair could recover the session.
    await t.tools.waitUntil(async () => (await session.daemonStatus()) === "idle", 60_000);

    // The second half is what the client is left holding. Losing the terminal
    // event itself is allowed — that is what a declared gap means, and under
    // load it does get lost — but then the snapshot handed over with the gap
    // has to say the turn is over. Requiring the event to survive would be
    // asserting a stronger contract than the protocol offers; requiring
    // convergence is the property a frozen chat actually violates.
    const settled = () =>
      session.events.some(
        (event) => event.type === "turnCompleted" || event.type === "turnFailed",
      ) || session.resyncStatus() === "idle";
    await t.tools.waitUntil(settled, 60_000).catch(() => {
      throw new Error(
        `the client never learned the turn ended: resyncs=${session.resyncs()} resyncStatus=${session.resyncStatus()} events=${session.events.length}`,
      );
    });
    t.note(
      `resyncs=${session.resyncs()} resyncStatus=${session.resyncStatus()} events=${session.events.length}`,
    );
  },
  // Thousands of events through a real transport is slow work.
  180_000,
  2,
);

/**
 * What the daemon said, or the fact that it said nothing.
 *
 * The case timeout would also catch a hang, but not tell anyone which call
 * hung, and here that is the whole question: a refusal is a perfectly good
 * answer to a prompt the agent cannot take, and silence is the defect.
 */
async function definiteAnswer(
  answer: Promise<unknown>,
  budgetMs: number,
  what: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<string>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the daemon never answered ${what} within ${budgetMs}ms`)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([
      answer.then(() => "accepted").catch((error: unknown) => `refused: ${String(error)}`),
      silence,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The freeze that never gets as far as a turn.
//
// A prompt to an agent that has not started yet announces a running session
// before it has anything running: the status is set and published, and only
// then does the daemon go and start the CLI and hand the message over. If that
// handover does not come back, the session stays that way — running, with no
// round and no narrative behind it — and every later prompt is refused as a
// conflict with a turn that never began. That is fb_R7fAQhyHcVIK: a send that
// timed out after sixty seconds, an immediate retry refused as a conflict, and
// a session the daemon still called running with zero rounds and zero items.
//
// The oracle is about the user's way out, not about any one step being fast:
// a handover that fails must leave a session that can be prompted again.
wedgeCase(
  "a-startup-that-hangs-does-not-claim-the-session-forever",
  "A session survives an agent that never finishes starting",
  "a prompt to an agent whose handshake never completes ends in a definite failure, leaves the session idle or failed, and does not refuse the next prompt as a conflict",
  [
    "a running status is published before there is anything running",
    "a handover with no deadline leaves the claim behind it standing",
    "a turn that never began refuses every prompt after it",
  ],
  { profile: "never-finishes-starting", id: "wedge-slow-start" },
  async (t, session) => {
    // A definite answer either way. Which one does not matter here — a refusal
    // is a fine outcome, a silence is not.
    const first = await definiteAnswer(
      t.flows.main.sendPrompt(session.client, session.sessionId, "hello"),
      120_000,
      "the first prompt",
    );
    t.note(`first send: ${first}`);

    // Nothing is running, so nothing may say it is. This is the field the
    // sidebar shows and the one the composer ends up believing.
    let status = await session.daemonStatus();
    await t.tools
      .waitUntil(async () => {
        status = await session.daemonStatus();
        return status === "idle" || status === "failed";
      }, 30_000)
      .catch(() => {
        throw new Error(
          `the handover ended in "${first}" and the session still says ${status}, with nothing behind it`,
        );
      });

    // And the way out has to still be there. A session that answers every
    // retry with "a turn is already running" is the freeze, whatever the
    // status field says.
    const second = await definiteAnswer(
      t.flows.main.sendPrompt(session.client, session.sessionId, "hello again"),
      120_000,
      "the second prompt",
    );
    t.note(`second send: ${second}`);
    t.assertions.assert(
      !/already running/i.test(second),
      `the retry was refused as a conflict with a turn that never began: ${second}`,
    );
  },
  150_000,
);

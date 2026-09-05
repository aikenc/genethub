// Whatever an agent does to a turn, the controls around that turn have to
// keep working. Interrupt and close are the user's only way out of a stuck
// round, so a wedged agent must not be able to take them away — not by
// refusing to answer, not by refusing to read, and not by refusing to die.
//
// These cases hold the escape hatches to a wall clock. "Eventually" is not a
// property a person waiting on a frozen chat can observe.

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type ControlledAgent = Awaited<
  ReturnType<CaseContext["flows"]["branches"]["openControlledAgentSession"]>
>;
type AgentOptions = Parameters<
  CaseContext["flows"]["branches"]["openControlledAgentSession"]
>[0]["agent"];

/** How long a control-plane call may take before it is a hang rather than a
 * slow answer. Generous next to a human's patience, tiny next to forever. */
const CONTROL_BUDGET_MS = 15_000;

/** Big enough to stop the pipe to the agent from moving again once the agent
 * itself stops reading, and still inside the protocol's `MAX_RPC_BODY_BYTES`
 * so the case measures the agent rather than a request the client refuses to
 * send. Pasting something this large is a thing people do. */
const OVERSIZED_PROMPT = "x".repeat(2_500_000);

/** How many stop presses it takes to run the queue between the daemon and a
 * silent agent out of room.
 *
 * The queue is bounded by messages rather than bytes, so the oversized prompt
 * alone only stalls the writer behind it — every later write is still
 * accepted until the queue itself is full. Pressing stop is the one control
 * the user has here and the one they press repeatedly, so it is also the
 * honest way to reach that state.
 */
const STOP_PRESSES = 96;

function livenessCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  agent: AgentOptions,
  run: (t: CaseContext, session: ControlledAgent) => Promise<void>,
  durationMs = 30_000,
): void {
  defineSpecialty(
    {
      id: `specialty.concurrency.control-plane.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "concurrency", "control-plane-liveness", "fault-injection"],
      llm: { default: "none" },
      expectedDurationMs: durationMs,
      timeoutMs: durationMs * 4,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
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

/** The external fault is a live CLI whose stdin is paused. Control requests
 * must remain available regardless of whether cancellation is queued or
 * immediately acknowledged. Requiring a stuck control request as the fixture
 * made the previous oracle block when the control plane was fixed. */
async function wedgeControlPlane(t: CaseContext, session: ControlledAgent): Promise<string> {
  const before = session.journal().length;
  await t.flows.main.sendPrompt(session.client, session.sessionId, OVERSIZED_PROMPT);
  const samples = () => session.journal().slice(before).filter((entry) => entry.event === "stdin-idle"
    && t.flows.branches.processAlive(Number(entry.pid)));
  await t.tools.waitUntil(() => samples().length >= 2, 10_000);
  const [first, second] = samples().slice(-2);
  if (!first || !second) throw new Error("the CLI stopped before its unreadable state could be observed");
  t.assertions.assert(first.pid === second.pid && first.bytesRead === second.bytesRead,
    "the live CLI did not stop consuming stdin");
  const started = Date.now();
  const presses = Array.from({ length: STOP_PRESSES }, () => session.client.call({
    type: "session.interrupt", payload: { sessionId: session.sessionId },
  }));
  const answers = await Promise.allSettled(presses);
  t.assertions.assert(Date.now() - started < CONTROL_BUDGET_MS, "repeated stop requests blocked the control plane");
  t.assertions.assert(answers.every((answer) => answer.status === "fulfilled"), "a stop request failed");
  return `${STOP_PRESSES} stop presses answered against unreadable CLI pid ${first.pid}`;
}

livenessCase(
  "close-after-repeated-stop-presses",
  "Close still answers after stop was pressed on an unreadable agent",
  "after repeated stop presses against an agent confirmed to have stopped reading, session.close returns within 15s",
  [
    "interrupt holds the agent lock across a write that can block",
    "one stuck control call wedges every other control call on the session",
    "the last escape hatch is unreachable on a wedged session",
  ],
  { profile: "stdin-never-drains", id: "liveness-close" },
  async (t, session) => {
    const wedge = await wedgeControlPlane(t, session);
    const timed = await t.flows.branches.timeControlCall(() =>
      session.client.call({ type: "session.close", payload: { sessionId: session.sessionId } }),
    );
    t.note(`close ${timed.outcome} in ${timed.ms}ms; ${wedge}`);
    t.assertions.assert(
      timed.ms < CONTROL_BUDGET_MS,
      `session.close took ${timed.ms}ms; a stuck stop press must not hold the control plane`,
    );
  },
  40_000,
);

livenessCase(
  "one-wedged-session-does-not-wedge-the-rest",
  "A wedged session does not take the workspace with it",
  "after repeated stop presses on an unreadable agent, session.list and a second session's creation both answer within 15s",
  [
    "a per-session wedge escalates to a daemon-wide stall",
    "the sidebar stops answering because one conversation is stuck",
  ],
  { profile: "stdin-never-drains", id: "liveness-blast-radius" },
  async (t, session) => {
    const wedge = await wedgeControlPlane(t, session);
    const listed = await t.flows.branches.timeControlCall(() =>
      session.client.call({
        type: "session.list",
        payload: { workspaceId: session.workspaceId, includeArchived: false },
      }),
    );
    const created = await t.flows.branches.timeControlCall(() =>
      t.flows.main.createBuiltinSession(session.client, session.workspaceId),
    );
    t.note(`list ${listed.outcome} in ${listed.ms}ms; create ${created.outcome} in ${created.ms}ms; ${wedge}`);
    t.assertions.assert(
      listed.ms < CONTROL_BUDGET_MS && created.ms < CONTROL_BUDGET_MS,
      `blast radius escaped the session: list ${listed.ms}ms, create ${created.ms}ms`,
    );
  },
  40_000,
);

livenessCase(
  "interrupt-escalates-past-a-deaf-agent",
  "Interrupt gives up on an agent that ignores it",
  "against an agent that answers neither the turn nor the cancel, session.interrupt returns within 15s and the session leaves running",
  [
    "interrupt waits forever on the wedged party's own reply",
    "no escalation from a polite cancel to termination",
  ],
  { profile: "ignore-interrupt", id: "liveness-deaf" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "ignore my cancel");
    await t.tools.waitUntil(
      () => session.journal().some((entry) => entry.event === "went-silent"),
      10_000,
    );

    const timed = await t.flows.branches.timeControlCall(() =>
      session.client.call({ type: "session.interrupt", payload: { sessionId: session.sessionId } }),
    );
    t.note(`interrupt ${timed.outcome} in ${timed.ms}ms`);
    t.assertions.assert(
      timed.ms < CONTROL_BUDGET_MS,
      `session.interrupt took ${timed.ms}ms against a deaf agent`,
    );
    await t.tools.waitUntil(async () => (await session.daemonStatus()) !== "running", 20_000);
  },
);

livenessCase(
  "close-outlives-an-agent-that-ignores-sigterm",
  "Close reaps an agent that ignores SIGTERM",
  "against an agent that ignores the cancel and SIGTERM, session.close returns within 15s and the agent process is gone",
  [
    "termination stops at a signal the agent can catch",
    "agent process leaks after the session is closed",
    // Not "kill_tree waits for the reap without a deadline". A process killed on
    // Linux is reaped immediately, so nothing here reaches that wait; claiming
    // it would be claiming a guard this case does not provide. Blocking a reap
    // needs a process stuck in the kernel, which no profile can arrange.
  ],
  { profile: "ignore-sigterm", id: "liveness-sigterm" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "outlive me");
    await t.tools.waitUntil(
      () => session.journal().some((entry) => entry.event === "went-silent"),
      10_000,
    );
    // The process that took the prompt. The probe the daemon started to read
    // the agent's catalog is already gone, so watching that one exit would
    // pass without close having done anything.
    const agentPid = Number(
      session.journal().find((entry) => entry.event === "went-silent")?.pid ?? 0,
    );
    t.assertions.assert(agentPid > 0, "the controlled agent never reported its pid");

    try {
      const timed = await t.flows.branches.timeControlCall(() =>
        session.client.call({ type: "session.close", payload: { sessionId: session.sessionId } }),
      );
      t.note(`close ${timed.outcome} in ${timed.ms}ms`);
      t.assertions.assert(
        timed.ms < CONTROL_BUDGET_MS,
        `session.close took ${timed.ms}ms against an agent that ignores SIGTERM`,
      );
      await t.tools.waitUntil(() => !t.flows.branches.processAlive(agentPid), 10_000);
    } finally {
      if (t.flows.branches.processAlive(agentPid)) {
        try {
          process.kill(agentPid, "SIGKILL");
        } catch {
          // Already reaped between the check and the signal.
        }
      }
    }
  },
);

livenessCase(
  "a-new-message-survives-the-previous-stop",
  "Sending again right after stop is not killed by the stop",
  "after stop is answered and a new prompt is sent within the grace window, the session is still running and its agent alive 8s later",
  [
    "the enforcement behind stop outlives the turn it was aimed at",
    "typing again too quickly kills the message you just sent",
  ],
  // Answers a cancel, never answers a prompt: stop lands cleanly, and the
  // turn after it is still open when the grace window for the first one
  // expires.
  { profile: "accept-then-silent", id: "liveness-restop" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "think about it");
    await t.tools.waitUntil(
      () => session.journal().some((entry) => entry.event === "went-silent"),
      10_000,
    );
    await session.client.call({
      type: "session.interrupt",
      payload: { sessionId: session.sessionId },
    });
    await t.tools.waitUntil(async () => (await session.daemonStatus()) !== "running", 15_000);

    // The impatient retype, well inside the window the stop armed.
    const beforeSecond = session.journal().length;
    await t.flows.main.sendPrompt(session.client, session.sessionId, "actually, this instead");
    await t.tools.waitUntil(async () => (await session.daemonStatus()) === "running", 15_000);

    await t.tools.waitUntil(() => session.journal().slice(beforeSecond).some((entry) => entry.event === "went-silent"), 10_000);
    const agentPid = Number(session.journal().slice(beforeSecond).find((entry) => entry.event === "went-silent")!.pid);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const status = await session.daemonStatus();
    t.note(`status after the grace window: ${status}`);
    t.assertions.assert(
      status === "running" && t.flows.branches.processAlive(agentPid),
      `the second message was killed by the first stop: status ${status}, agent alive ${t.flows.branches.processAlive(agentPid)}`,
    );
  },
  45_000,
);

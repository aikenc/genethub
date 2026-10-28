// A script that coordinates Sessions needs two things the platform did not
// give it: a way to tell a Session something that is NOT a request (so it does
// not interrupt the Session's work or undo a pause the person set), and a
// one-line description of what a Session is for (so another Agent can choose
// whom to ask). These cases drive the shipped `genet` against a real daemon and
// a real script Agent; nothing in the product is replaced.
//
//   - `session send` with an explicit `--system` notice queues a `system` notice behind a running round;
//   - a notice never lifts a pause, and a person's message still does;
//   - a notice is idempotent by messageId, and the CLI refuses what is not
//     durable;
//   - `session describe` / `agent run --description` set one trimmed line that
//     `session list` and `session get` print and a restart keeps.

import type { SessionSnapshot } from "@genehub/proto";

import {
  defineSpecialty,
  localGenetCli,
  type CaseContext,
  type GenetCliResult,
} from "../../framework/public.ts";

type Session = Awaited<ReturnType<CaseContext["flows"]["branches"]["openControlledAgentSession"]>>;
type Agent = Parameters<CaseContext["flows"]["branches"]["openControlledAgentSession"]>[0]["agent"];
type Cli = ReturnType<typeof localGenetCli>;

const SCHEMA = "genet.cli/v1";

function noticeCase(
  name: string,
  title: string,
  oracle: string,
  catches: string[],
  agent: Agent,
  run: (t: CaseContext, session: Session, cli: Cli) => Promise<void>,
  durationMs = 25_000,
): void {
  defineSpecialty(
    {
      id: `specialty.daemon.system-notice.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "session", "genet-cli", "system-notice"],
      llm: { default: "none" },
      expectedDurationMs: durationMs,
      timeoutMs: Math.max(durationMs * 4, 90_000),
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["genet-cli", "daemon", "script-agent"],
      productInterfaces: ["genet-cli", "@genehub/workbench/client", "agent-serve-protocol-1"],
    },
    async (t) => {
      const session = await t.flows.branches.openControlledAgentSession({
        openRoot: t.openRoot,
        lease: t.env,
        agent,
      });
      try {
        await run(t, session, localGenetCli(t.openRoot, t.env));
      } finally {
        await session.dispose();
      }
    },
  );
}

const brief = (result: GenetCliResult): string =>
  `exit ${result.code} stdout ${result.stdout.slice(-400)} stderr ${result.stderr.slice(-300)}`;

/** Exit 0 and one success envelope of `type`. */
function succeeded(t: CaseContext, result: GenetCliResult, type: string): Record<string, unknown> {
  t.assertions.assert(result.code === 0, `genet ${type}: ${brief(result)}`);
  const body = result.envelope;
  t.assertions.assert(
    body?.schema === SCHEMA && body.type === type && typeof body.data === "object",
    `genet ${type} envelope: ${result.stdout.slice(-400)}`,
  );
  return body!.data!;
}

function refusedWithUsage(t: CaseContext, result: GenetCliResult, what: string): void {
  const body = result.envelope;
  t.assertions.assert(
    result.code === 2 && body?.schema === SCHEMA && body.type === "error" && body.error?.code === "invalidArgs",
    `${what}: expected exit 2 invalidArgs, got ${brief(result)}`,
  );
}

async function snapshot(session: Session): Promise<SessionSnapshot> {
  const reply = await session.client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
  if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
  return reply.data;
}

async function sessionIds(session: Session): Promise<string[]> {
  const reply = await session.client.call({
    type: "session.list",
    payload: { workspaceId: session.workspaceId, includeArchived: false, lean: true },
  });
  if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
  return reply.data.map((entry) => entry.id);
}

const prompts = (session: Session) => session.journal().filter((entry) => entry.event === "prompt").length;
const cancels = (session: Session) => session.journal().filter((entry) => entry.event === "cancel").length;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

noticeCase(
  "does-not-interrupt-and-waits-behind-a-person",
  "a system notice sent to a busy Session waits for the round and behind a person's message",
  "while a round is running, `genet session send` with an explicit `--system` notice is accepted and the Agent is NOT interrupted (no cancel reaches it, the turn stays open); the same send from a person does interrupt; and once the person's turn is delivered the notice is still queued in pendingMessageIds",
  [
    "a script's notice cancelling the work it was meant to inform",
    "a notice delivered ahead of the person who is waiting",
    "the queue summary hiding whether a pending input is still waiting",
    "the notice dropped instead of waiting",
  ],
  { profile: "accept-then-silent" },
  async (t, session, cli) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Work on the migration.");
    await t.tools.waitUntil(() => session.journal().some((entry) => entry.event === "went-silent"), 15_000);
    t.assertions.assert((await snapshot(session)).summary.status === "running", "the round did not stay open");

    succeeded(
      t,
      cli(["session", "send", session.sessionId, "--system", "用途: result\n\n子会话 s_9 已完成", "--message-id", "s9.r1.done", "--no-wait"]),
      "session.result",
    );
    await t.tools.waitUntil(
      async () => (await snapshot(session)).summary.inputSummary?.pendingMessageIds.includes("s9.r1.done") === true,
      10_000,
    );
    await pause(1_500); // many 250 ms delivery ticks: an interrupt would have happened by now
    t.assertions.assert(cancels(session) === 0, `the notice interrupted the Agent: ${cancels(session)} cancel(s)`);
    t.assertions.assert(
      !session.events.some((event) => event.type === "turnCanceled"),
      "the running turn was canceled by a system notice",
    );
    t.assertions.assert((await snapshot(session)).summary.status === "running", "the notice ended the round");
    t.assertions.assert(prompts(session) === 1, "the notice started a second turn while the first was open");

    // The contrast: a person's message is a requirement, and does interrupt.
    succeeded(
      t,
      cli(["session", "send", session.sessionId, "Please stop and look at this", "--message-id", "u.one", "--no-wait"]),
      "session.result",
    );
    await t.tools.waitUntil(() => cancels(session) === 1 && prompts(session) === 2, 15_000);

    // The person's turn took the lane; the notice is still waiting behind it.
    const input = (await snapshot(session)).summary.inputSummary;
    t.assertions.assert(
      input?.pendingMessageIds.includes("s9.r1.done") === true,
      `the notice should still be pending: ${JSON.stringify(input)}`,
    );
    t.assertions.assert(
      input?.pendingMessageIds.includes("u.one") === true,
      `the person's message should be in pendingMessageIds until round finishes: ${JSON.stringify(input)}`,
    );
    t.assertions.assert(prompts(session) === 2, "the notice was delivered ahead of, or together with, the person's message");
  },
  40_000,
);

noticeCase(
  "never-lifts-a-pause-a-person-speaking-does",
  "a system notice sent to an interrupted Session stays queued; only a person's message lifts the pause",
  "after the person interrupts a Session, a `用途: ...` notice is accepted but no turn starts, the summary stays paused and shows the notice queued; a person's next message lifts the pause and starts a turn",
  [
    "a script silently undoing the person's interrupt by waking the Session",
    "a paused Session reported as running its queue",
    "the pause not visible in the summary once something is pending",
  ],
  { profile: "accept-then-silent" },
  async (t, session, cli) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Start the long task.");
    await t.tools.waitUntil(() => session.journal().some((entry) => entry.event === "went-silent"), 15_000);
    await session.client.call({ type: "session.interrupt", payload: { sessionId: session.sessionId } });
    await t.tools.waitUntil(async () => (await session.daemonStatus()) === "idle", 15_000);
    const before = prompts(session);

    succeeded(
      t,
      cli(["session", "send", session.sessionId, "--system", "用途: result\n\n后台任务 s_7 已完成", "--message-id", "s7.r2.done", "--no-wait"]),
      "session.result",
    );
    await t.tools.waitUntil(
      async () => (await snapshot(session)).summary.inputSummary?.pendingMessageIds.includes("s7.r2.done") === true,
      10_000,
    );
    await pause(2_000);
    const waiting = (await snapshot(session)).summary;
    t.assertions.assert(prompts(session) === before, "a notice woke a Session the person had paused");
    t.assertions.assert(waiting.status === "idle", `status ${waiting.status}`);
    t.assertions.assert(
      waiting.inputSummary?.paused === true,
      `the pause was lifted by a system notice: ${JSON.stringify(waiting.inputSummary)}`,
    );
    t.assertions.assert(
      waiting.inputSummary?.pendingMessageIds.includes("s7.r2.done") === true,
      "the notice should be waiting, not dropped or delivered",
    );

    succeeded(
      t,
      cli(["session", "send", session.sessionId, "carry on", "--message-id", "u.go", "--no-wait"]),
      "session.result",
    );
    await t.tools.waitUntil(() => prompts(session) === before + 1, 15_000);
    t.assertions.assert(
      (await snapshot(session)).summary.inputSummary?.paused === false,
      "a person's message did not lift the pause",
    );
  },
  35_000,
);

noticeCase(
  "is-idempotent-and-the-cli-refuses-what-is-not-durable",
  "a system notice is acknowledged again, not queued twice, and the CLI refuses a notice that cannot be retried",
  "the same notice sent twice leaves one message and is delivered and handled; the same id with other text is refused; a system notice without --message-id, with --task-run, exits 2; an initial system notice with a stable id creates one Session",
  [
    "two channels or a retry delivering the same notice twice",
    "an id reused for different content silently overwriting a notice",
    "a notice without a stable id accepted",
    "an initial durable notice rejected instead of creating its Session",
  ],
  { profile: "normal" },
  async (t, session, cli) => {
    const id = session.sessionId;
    const send = (text: string) =>
      cli(["session", "send", id, "--system", text, "--message-id", "s9.r1.done", "--no-wait"]);
    succeeded(t, send("用途: result\n\n子会话 s_9 已完成"), "session.result");
    succeeded(t, send("用途: result\n\n子会话 s_9 已完成"), "session.result");
    const other = send("用途: result\n\nanother body under the same id");
    t.assertions.assert(
      other.code !== 0 && other.envelope?.type === "error",
      `the same id with other text must be refused: ${brief(other)}`,
    );

    // It is handled like any input: the turn runs, the queue empties.
    await t.tools.waitUntil(async () => {
      const summary = (await snapshot(session)).summary;
      // An empty queue is omitted from the summary, not sent as [].
      return summary.status === "idle" && (summary.inputSummary?.pendingMessageIds.length ?? 0) === 0;
    }, 20_000);
    const copies = (await snapshot(session)).items.filter(
      (item) => item.type === "userMessage" && item.id === "s9.r1.done",
    );
    t.assertions.assert(copies.length === 1, `the retried notice appeared ${copies.length} times in the timeline`);
    t.assertions.assert(prompts(session) === 1, `the notice ran ${prompts(session)} turns`);

    refusedWithUsage(t, cli(["session", "send", id, "--system", "用途: result\n\nx", "--no-wait"]), "system notice without --message-id");
    refusedWithUsage(
      t,
      cli(["session", "send", id, "--system", "用途: result\n\nx", "--message-id", "q.1", "--task-run", "r1", "--no-wait"]),
      "system notice with --task-run",
    );
    const before = await sessionIds(session);
    succeeded(t, cli(["agent", "run", "--agent", session.agent.agentId, "--workspace", session.workspaceId,
      "--system", "--message-id", "q.2", "--no-wait", "用途: result\n\nx"]), "session.result");
    const after = await sessionIds(session);
    t.assertions.assert(after.length === before.length + 1, "a durable initial system notice did not create one Session");
  },
);

noticeCase(
  "description-is-one-trimmed-line-printed-and-kept",
  "session describe and agent run --description set one trimmed line that list and get print and a restart keeps",
  "`genet session describe` stores a trimmed one-line description that `session get`, `session list` and the product client all show; too long or multi-line text is refused by the CLI (exit 2) and by the daemon; an empty text clears it; `agent run --description` sets it before the first prompt; a daemon restart keeps it",
  [
    "a description only held in memory",
    "a multi-line or oversized description accepted into a field other Agents read",
    "the description missing from the list an Agent uses to choose whom to ask",
    "--description applied after the prompt, so the first round starts without it",
  ],
  { profile: "normal" },
  async (t, session, cli) => {
    const id = session.sessionId;
    const line = "评审 Rust 改动；要找人看 daemon 代码时来问我";
    const described = succeeded(t, cli(["session", "describe", id, `  ${line}  `]), "session.describe");
    t.assertions.assert(
      (described.session as { description?: string }).description === line,
      `describe reply: ${JSON.stringify(described).slice(0, 300)}`,
    );

    const got = succeeded(t, cli(["session", "get", id]), "session.get");
    t.assertions.assert(
      JSON.stringify(got).includes(line),
      `session get does not show the description: ${JSON.stringify(got).slice(0, 300)}`,
    );
    const listed = succeeded(t, cli(["session", "list"]), "session.list");
    const row = (listed.sessions as Array<{ id: string; description?: string }>).find((s) => s.id === id);
    t.assertions.assert(row?.description === line, `session list row: ${JSON.stringify(row)}`);
    t.assertions.assert(
      (await snapshot(session)).summary.description === line,
      "the product client does not see the description the CLI set",
    );

    refusedWithUsage(t, cli(["session", "describe", id, "x".repeat(301)]), "a 301-byte description");
    refusedWithUsage(t, cli(["session", "describe", id, "two\nlines"]), "a two-line description");
    // The daemon refuses it too: the CLI is not the only caller.
    let daemonRefused = false;
    try {
      await session.client.call({ type: "session.describe", payload: { sessionId: id, text: "two\nlines" } });
    } catch {
      daemonRefused = true;
    }
    t.assertions.assert(daemonRefused, "the daemon accepted a two-line description over the protocol");
    t.assertions.assert((await snapshot(session)).summary.description === line, "a refused change altered the description");

    // Set at creation, before the first prompt is sent.
    const before = await sessionIds(session);
    const created = "跑评审的会话：被请求评审时来找它";
    succeeded(
      t,
      cli(["agent", "run", "--agent", session.agent.agentId, "--workspace", session.workspaceId, "--description", created, "--no-wait", "hello"]),
      "session.result",
    );
    let fresh = "";
    await t.tools.waitUntil(async () => {
      fresh = (await sessionIds(session)).find((s) => !before.includes(s)) ?? "";
      return fresh !== "";
    }, 20_000);
    const first = await session.client.call({ type: "session.get", payload: { sessionId: fresh } });
    t.assertions.assert(
      first?.type === "snapshot" && first.data.summary.description === created
        && first.data.items.some((item) => item.type === "userMessage" && item.text === "hello"),
      `agent run --description: ${JSON.stringify(first?.type === "snapshot" ? first.data.summary.description : first)}`,
    );

    // A restart keeps both, and clearing works on the restarted daemon.
    session.client.close();
    session.daemon.stop();
    const reopened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      for (const [sessionId, expected] of [[id, line], [fresh, created]] as const) {
        const reply = await reopened.client.call({ type: "session.get", payload: { sessionId } });
        t.assertions.assert(
          reply?.type === "snapshot" && reply.data.summary.description === expected,
          `a restart lost the description of ${sessionId}`,
        );
      }
      const cleared = succeeded(t, cli(["session", "describe", id, ""]), "session.describe");
      t.assertions.assert(
        (cleared.session as { description?: string }).description === undefined,
        `an empty text should clear the description: ${JSON.stringify(cleared).slice(0, 200)}`,
      );
    } finally {
      reopened.client.close();
      reopened.daemon.stop();
      await reopened.mock.stop();
    }
  },
  45_000,
);

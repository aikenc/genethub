import { existsSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";
import {
  defineSpecialty,
  connectProductClient,
  daemonEndpoint,
  parseJson,
  runGenet,
  type CaseContext,
} from "../../framework/public.ts";

type Session = Awaited<ReturnType<CaseContext["flows"]["branches"]["openControlledAgentSession"]>>;
type Agent = Parameters<CaseContext["flows"]["branches"]["openControlledAgentSession"]>[0]["agent"];

function contractCase(
  name: string,
  oracle: string,
  catches: string[],
  agent: Agent,
  run: (t: CaseContext, session: Session) => Promise<void>,
): void {
  defineSpecialty({
    id: `specialty.agent.execution-contract.${name}`,
    title: name.replaceAll("-", " "),
    oracle,
    catches,
    tags: ["core", "agent", "session", "chat-lifecycle", "fault-injection", name],
    llm: { default: "none" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent-adapter", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agents.custom"],
  }, async (t) => {
    const session = await t.flows.branches.openControlledAgentSession({
      openRoot: t.openRoot, lease: t.env, agent,
    });
    try { await run(t, session); } finally { await session.dispose(); }
  });
}

async function snapshot(session: Session) {
  const reply = await session.client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
  if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
  return reply.data;
}

const completed = (session: Session) => session.events.filter((event) => event.type === "turnCompleted").length;

contractCase(
  "reconnect-resets-even-when-daemon-sequences-overlap",
  "a delayed original observer gets a full reset after a new daemon has already advanced beyond its old cursor",
  ["numeric cursor comparison cannot identify a daemon lifetime", "incremental replay omits the start of work done while disconnected"],
  { profile: "normal", chunks: 4 },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Before the daemon restart.");
    await session.waitForTerminal();
    const oldSeq = (await snapshot(session)).seq;
    let release!: () => void;
    const reconnect = new Promise<void>((resolve) => { release = resolve; });
    const observer = await connectProductClient({
      ...daemonEndpoint(session.daemon),
      redial: async () => { await reconnect; return daemonEndpoint(session.daemon); },
    });
    let reset: boolean | undefined;
    let recovered = "";
    let liveCompletions = 0;
    await observer.subscribe(session.sessionId, {
      onEvent: (event) => { if (event.event.type === "turnCompleted") liveCompletions += 1; },
      onResync: (state, _events, didReset) => { reset = didReset; recovered = JSON.stringify(state); },
    });
    let next: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>> | undefined;
    try {
      session.daemon.stop();
      await t.tools.waitUntil(() => observer.connectionState !== "ready", 5_000);
      next = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      for (let i = 0; i < 2; i += 1) {
        await t.flows.main.sendPrompt(next.client, session.sessionId, `Disconnected execution ${i}.`);
        await t.tools.waitUntil(async () => {
          const reply = await next!.client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
          return reply?.type === "snapshot" && reply.data.summary.status === "idle";
        }, 15_000);
      }
      const current = await next.client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
      t.assertions.assert(current?.type === "snapshot" && current.data.seq > oldSeq, "the new daemon did not overlap the old cursor");
      release();
      await t.tools.waitUntil(() => reset !== undefined, 20_000);
      t.assertions.assert(reset === true && recovered.includes("Disconnected execution 1."),
        `overlapping daemon sequences were treated as continuous: reset=${reset}`);
      await t.flows.main.sendPrompt(next.client, session.sessionId, "Live after the reset.");
      await t.tools.waitUntil(() => liveCompletions === 1, 10_000);
    } finally {
      release(); observer.close();
      if (next) { next.client.close(); next.daemon.stop(); await next.mock.stop(); }
    }
  },
);

contractCase(
  "failed-append-cannot-be-overwritten-by-the-next-execution",
  "after a real chat append failure, restoring the file and sending again preserves both executions across two restarts",
  ["failed flush discards pending item ids", "a new execution overwrites the only checkpoint of the previous answer"],
  { profile: "burst-then-silent" },
  async (t, session) => {
    const directory = path.join(session.workspaceRoot, ".genethub", "sessions", session.sessionId);
    const chat = path.join(directory, "chat.jsonl");
    const saved = path.join(directory, "chat.saved");
    const checkpoint = path.join(directory, "open-turn.jsonl");
    const reopenings: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>[] = [];
    let obstructed = false;
    try {
      await t.flows.main.sendPrompt(session.client, session.sessionId, "Preserve the first execution.");
      await t.tools.waitUntil(async () => JSON.stringify((await snapshot(session)).items).includes("checkpoint-tail"), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      t.assertions.assert(existsSync(checkpoint), "no recovery copy exists before the fault");
      renameSync(chat, saved);
      mkdirSync(chat); // A real filesystem error, including when tests run as root.
      obstructed = true;
      await session.client.call({ type: "session.interrupt", payload: { sessionId: session.sessionId } });
      await t.tools.waitUntil(async () => (await session.daemonStatus()) === "failed", 15_000);
      t.assertions.assert(existsSync(checkpoint), "a failed append deleted the recovery copy");
      rmdirSync(chat); renameSync(saved, chat); obstructed = false;
      await t.flows.main.sendPrompt(session.client, session.sessionId, "Preserve the second execution too.");
      await t.tools.waitUntil(async () => (await snapshot(session)).items.filter((item) => item.type === "assistantMessage"
        && item.text.includes("checkpoint-tail")).length === 2, 15_000);
      session.client.close(); session.daemon.stop();
      for (let i = 0; i < 2; i += 1) {
        const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
        reopenings.push(opened);
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
        const kept = reply?.type === "snapshot" ? reply.data.items.filter((item) => item.type === "assistantMessage"
          && item.text.includes("checkpoint-prefix") && item.text.includes("checkpoint-tail")) : [];
        t.assertions.assert(kept.length === 2, `recovery ${i + 1} lost or duplicated an execution after an append failure`);
        opened.client.close(); opened.daemon.stop();
      }
    } finally {
      if (obstructed) { rmdirSync(chat); renameSync(saved, chat); }
      for (const opened of reopenings) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
    }
  },
);

async function rounds(session: Session) {
  const reply = await session.client.call({ type: "session.rounds", payload: {
    sessionId: session.sessionId, throughRoundId: null, cursor: null, limit: 10,
  } });
  if (reply?.type !== "sessionRounds") throw new Error(`session.rounds returned ${reply?.type}`);
  return reply.data.rounds;
}

contractCase(
  "stop-during-startup-owns-the-process",
  "stop during session creation settles the pending send and reaps the exact CLI process within 12 seconds",
  ["stop cannot reach an agent before it is installed", "a dropped startup future leaves its child alive"],
  { profile: "hang-session-new" },
  async (t, session) => {
    const journalBefore = session.journal().length;
    let sendFinished = false;
    const pending = t.flows.main.sendPrompt(session.client, session.sessionId, "Stop before startup finishes.")
      .then(() => { sendFinished = true; }, () => { sendFinished = true; });
    const starting = () => session.journal().slice(journalBefore).find((entry) =>
      entry.event === "withholding-session-new" && t.flows.branches.processAlive(Number(entry.pid)));
    await t.tools.waitUntil(() => Boolean(starting()), 45_000);
    const pid = Number(starting()!.pid);
    t.assertions.assert(t.flows.branches.processAlive(pid), "the startup process was never alive");
    await session.client.call({ type: "session.interrupt", payload: { sessionId: session.sessionId } });
    await t.tools.waitUntil(() => sendFinished && !t.flows.branches.processAlive(pid), 12_000)
      .catch(() => { throw new Error(`startup stop: sendFinished=${sendFinished}, processAlive=${t.flows.branches.processAlive(pid)}`); });
    await pending;
    t.assertions.assert((await session.daemonStatus()) !== "running", "startup remained running after its owner ended");
  },
);

contractCase(
  "previous-stop-cannot-end-a-continued-round",
  "a second execution continuing the same round remains running past the first stop escalation deadline",
  ["round identity reused as execution identity", "previous interrupt kills a new execution"],
  { profile: "accept-then-silent" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Begin this round.");
    await t.tools.waitUntil(() => session.journal().some((entry) => entry.event === "went-silent"), 10_000);
    const roundId = (await rounds(session)).find((round) => round.outcome === "running")?.roundId;
    t.assertions.assert(Boolean(roundId), "the first execution has no public running round");
    await session.client.call({ type: "session.interrupt", payload: { sessionId: session.sessionId } });
    await t.tools.waitUntil(async () => (await session.daemonStatus()) !== "running", 15_000);
    const journalBefore = session.journal().length;
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Continue the same round.", roundId);
    await t.tools.waitUntil(() => session.journal().slice(journalBefore).some((entry) => entry.event === "went-silent"), 15_000);
    const pid = Number(session.journal().slice(journalBefore).find((entry) => entry.event === "went-silent")!.pid);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const after = await snapshot(session);
    t.assertions.assert(after.summary.status === "running" && t.flows.branches.processAlive(pid),
      `the continued execution was stopped: status=${after.summary.status}, processAlive=${t.flows.branches.processAlive(pid)}`);
    t.assertions.assert((await rounds(session)).some((round) => round.roundId === roundId && round.outcome === "running"),
      "continuation replaced or ended the logical round");
  },
);

contractCase(
  "initial-snapshot-advances-the-subscription",
  "after subscribing to a nonempty snapshot, the next turn arrives as live events without a synthetic gap",
  ["initial subscription ignores snapshot seq", "every new event triggers another reset"],
  { profile: "normal", chunks: 4 },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Finish the first execution.");
    await session.waitForTerminal();
    await session.client.unsubscribe(session.sessionId);
    let terminals = 0;
    let resyncs = 0;
    const subscribed = await session.client.subscribe(session.sessionId, {
      onEvent: (event) => { if (event.event.type === "turnCompleted") terminals += 1; },
      onResync: () => { resyncs += 1; },
    });
    t.assertions.assert(Number((subscribed.snapshot as { seq?: number }).seq) > 0, "the snapshot did not exercise a nonzero cursor");
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Finish the second execution.");
    await t.tools.waitUntil(() => terminals === 1 || resyncs > 0, 10_000);
    t.assertions.assert(terminals === 1 && resyncs === 0,
      `the initial cursor manufactured a gap: live terminals=${terminals}, resyncs=${resyncs}`);
  },
);

contractCase(
  "cursor-from-a-previous-daemon-resets",
  "a subscribe cursor beyond the current daemon sequence explicitly returns a reset snapshot",
  ["future cursor treated as an empty incremental replay after a daemon restart"],
  { profile: "normal" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Produce a nonempty replay window.");
    await session.waitForTerminal();
    const current = await snapshot(session);
    const reply = await session.client.call({ type: "subscribe", payload: {
      sessionId: session.sessionId, sinceSeq: current.seq + 1000, expandLastRound: true,
    } });
    t.assertions.assert(reply?.type === "subscribed" && reply.data.reset === true,
      `a cursor beyond the current daemon did not reset: ${JSON.stringify(reply)}`);
  },
);

contractCase(
  "same-client-receives-events-after-daemon-restart",
  "the original Client resubscribes after a daemon restart and receives a subsequent completion with a lower sequence",
  ["reset keeps a cursor from the previous daemon", "reconnect tests replace the Client and miss stale state"],
  { profile: "normal", chunks: 4 },
  async (t, session) => {
    for (let i = 0; i < 2; i += 1) {
      await t.flows.main.sendPrompt(session.client, session.sessionId, `Before restart ${i}.`);
      await t.tools.waitUntil(() => completed(session) === i + 1, 15_000);
    }
    session.daemon.stop();
    await t.tools.waitUntil(() => session.client.connectionState !== "ready", 5_000);
    const started = runGenet(session.daemon.genet, ["daemon", "start"], session.daemon.env);
    t.assertions.assert(started.code === 0, `restart failed: ${started.stderr}`);
    await t.tools.waitUntil(() => session.client.connectionState === "ready", 30_000);
    await t.flows.main.sendPrompt(session.client, session.sessionId, "After restart, on the same Client.");
    await t.tools.waitUntil(() => completed(session) === 3, 15_000)
      .catch(() => { throw new Error(`same Client lost completion after restart: completions=${completed(session)}, resyncs=${session.resyncs()}`); });
  },
);

contractCase(
  "silent-tail-reaches-a-crash-checkpoint",
  "both chunks emitted within one checkpoint interval survive a later SIGKILL and two recoveries exactly once",
  ["checkpoint needs another event to flush its tail", "recovery duplicates the last partial answer"],
  { profile: "burst-then-silent" },
  async (t, session) => {
    const reopened: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>[] = [];
    try {
      await t.flows.main.sendPrompt(session.client, session.sessionId, "Emit two chunks and then stay silent.");
      await t.tools.waitUntil(async () => JSON.stringify((await snapshot(session)).items).includes("checkpoint-tail"), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const status = parseJson(runGenet(session.daemon.genet, ["daemon", "status"], session.daemon.env).stdout);
      const pid = Number(status.pid);
      t.assertions.assert(Number.isInteger(pid) && pid > 0, "daemon did not report its process");
      session.client.close();
      process.kill(pid, "SIGKILL");
      await t.tools.waitUntil(() => parseJson(runGenet(session.daemon.genet, ["daemon", "status"], session.daemon.env).stdout).running === false, 15_000);
      for (let i = 0; i < 2; i += 1) {
        const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
        reopened.push(opened);
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
        t.assertions.assert(reply?.type === "snapshot", "recovery did not return a snapshot");
        const items = reply?.type === "snapshot" ? reply.data.items : [];
        const matches = items.filter((item) => item.type === "assistantMessage" && item.text.includes("checkpoint-prefix") && item.text.includes("checkpoint-tail"));
        t.assertions.assert(matches.length === 1, `recovery ${i + 1} lost or duplicated the silent tail: ${JSON.stringify(items)}`);
        opened.client.close();
        opened.daemon.stop();
      }
    } finally {
      for (const opened of reopened) {
        opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
      }
    }
  },
);

contractCase(
  "forced-stop-drains-the-last-reasoning-source",
  "the full last reasoning item, beyond its compact overview, is readable from the blob layer after forced stop and restart",
  ["aborting a pump drops its raw reasoning buffer", "joining a parent does not drain its blob-writer child"],
  { profile: "reasoning-ignore-interrupt" },
  async (t, session) => {
    await t.flows.main.sendPrompt(session.client, session.sessionId, "Produce a long source item, then ignore cancellation.");
    await t.tools.waitUntil(async () => (await snapshot(session)).items.some((item) => item.type === "reasoning"), 15_000);
    const roundId = (await rounds(session)).find((round) => round.outcome === "running")?.roundId;
    if (!roundId) throw new Error("the source item has no public round");
    await session.client.call({ type: "session.interrupt", payload: { sessionId: session.sessionId } });
    await t.tools.waitUntil(async () => (await session.daemonStatus()) === "idle", 15_000);
    const checkSource = async (client: typeof session.client) => {
      const trunk = await client.call({ type: "round.trunk.get", payload: { sessionId: session.sessionId, roundId, trunkIndex: 0 } });
      if (trunk?.type !== "roundTrunk") throw new Error("the stopped round has no trunk");
      const row = trunk.data.batches.flatMap((batch) => batch.blobs).find((blob) => blob.kind === "reasoning");
      if (!row?.blob) throw new Error("the stopped reasoning item has no source blob");
      const payload = await client.call({ type: "blob.get", payload: { sessionId: session.sessionId, blob: row.blob } });
      t.assertions.assert(payload?.type === "blob" && JSON.stringify(payload.data.value).includes("final-reasoning-marker"),
        "forced stop preserved only the overview and lost the source tail");
    };
    await checkSource(session.client);
    session.client.close(); session.daemon.stop();
    const reopened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try { await checkSource(reopened.client); }
    finally { reopened.client.close(); reopened.daemon.stop(); await reopened.mock.stop(); }
  },
);

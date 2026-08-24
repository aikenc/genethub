import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Events = Array<{ type?: string; raw: unknown }>;

function eventCase(id: string, title: string, oracle: string, catches: string[], run: (t: CaseContext, opened: Opened) => Promise<void>, expectedDurationMs = 35_000): void {
  defineSpecialty({
    id: `specialty.agent.events.${id}`,
    title,
    oracle,
    catches,
    tags: ["core", "agent", "agent-event-depth"],
    llm: { default: "mock" },
    expectedDurationMs,
    timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  }, async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      await run(t, opened);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  });
}

function terminals(events: Events): Array<{ type?: string; raw: unknown }> {
  return events.filter((event) => event.type === "turnCompleted" || event.type === "turnFailed" || event.type === "turnCanceled");
}

async function create(opened: Opened, t: CaseContext): Promise<{ id: string; events: Events }> {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  return { id, events: await t.flows.main.attachEventLog(opened.client, id) };
}

async function complete(opened: Opened, t: CaseContext, id: string, events: Events, prompt: string, reply: string): Promise<void> {
  opened.mock.script({ text: reply });
  const before = terminals(events).length;
  await t.flows.main.sendPrompt(opened.client, id, prompt);
  await t.tools.waitUntil(() => terminals(events).length === before + 1, 60_000);
}

async function snapshot(opened: Opened, id: string) {
  const reply = await opened.client.call({ type: "session.get", payload: { sessionId: id } });
  if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
  return reply;
}

eventCase("start-precedes-terminal", "Turn start always precedes its terminal event", "the first start index is lower than the single completion index", ["terminal emitted before start", "start omitted"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  await complete(opened, t, id, events, "Order events.", "ordered");
  const types = events.map((event) => event.type);
  t.assertions.assert(types.indexOf("turnStarted") >= 0 && types.indexOf("turnStarted") < types.indexOf("turnCompleted"), `event order ${types}`);
});

eventCase("one-terminal-per-success", "A successful turn emits exactly one terminal outcome", "one completion and no failure or cancellation are observed", ["duplicate completion", "success also emits failure"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  await complete(opened, t, id, events, "One outcome.", "done");
  t.assertions.assert(terminals(events).length === 1 && terminals(events)[0]?.type === "turnCompleted", `terminals ${terminals(events).map((event) => event.type)}`);
});

eventCase("snapshot-grows-after-turn", "A completed turn grows the public snapshot", "the item count increases and never shrinks after completion", ["completion before persistence", "timeline replacement"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  const before = (await snapshot(opened, id)).data.items.length;
  await complete(opened, t, id, events, "Grow snapshot.", "growth");
  const after = (await snapshot(opened, id)).data.items.length;
  t.assertions.assert(after > before, `snapshot did not grow ${before} -> ${after}`);
});

eventCase("empty-provider-reply-settles", "An empty provider reply still settles the turn", "the turn completes exactly once and the session remains readable", ["empty chunk wedges turn", "empty reply drops terminal"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  await complete(opened, t, id, events, "Accept empty output.", "");
  t.assertions.assert(terminals(events).length === 1 && terminals(events)[0]?.type === "turnCompleted", "empty reply did not complete");
  t.assertions.assert((await snapshot(opened, id)).data.summary.id === id, "session unreadable after empty reply");
});

eventCase("unicode-reply-persists", "Unicode model output survives the Agent timeline", "the exact CJK, emoji, Greek, and combining sequence appears in the snapshot", ["stream decoding corruption", "Unicode normalization"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  const reply = "回答 🧬 Ελληνικά e\u0301";
  await complete(opened, t, id, events, "Return Unicode.", reply);
  t.assertions.assert(JSON.stringify(await snapshot(opened, id)).includes(reply), "Unicode reply missing from snapshot");
});

eventCase("multiline-reply-persists", "Multiline model output remains multiline", "all lines and separators appear in the persisted snapshot", ["stream lines reordered", "newlines stripped"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  const reply = "line-one\nline-two\nline-three";
  await complete(opened, t, id, events, "Return lines.", reply);
  t.assertions.assert(JSON.stringify(await snapshot(opened, id)).includes("line-one\\nline-two\\nline-three"), "multiline reply changed");
});

eventCase("three-failures-then-success", "A session recovers after three consecutive provider failures", "three failed terminals are followed by exactly one completion", ["retry state leaks forever", "failure count corrupts session"], async (t, opened) => {
  opened.mock.script({ status: 500 }, { status: 500 }, { status: 500 }, { text: "recovered-fourth" });
  const { id, events } = await create(opened, t);
  for (let index = 0; index < 4; index += 1) {
    await t.flows.main.sendPrompt(opened.client, id, `Attempt ${index}`);
    await t.tools.waitUntil(() => terminals(events).length === index + 1, 60_000);
  }
  t.assertions.assert(events.filter((event) => event.type === "turnFailed").length === 3, "failure count drifted");
  t.assertions.assert(events.filter((event) => event.type === "turnCompleted").length === 1, "fourth turn did not recover");
});

eventCase("failure-snapshot-readable", "A failed turn leaves a readable session snapshot", "session.get returns the same id after the terminal failure", ["failure deletes session", "failed ledger cannot hydrate"], async (t, opened) => {
  opened.mock.script({ status: 500 });
  const { id, events } = await create(opened, t);
  await t.flows.main.sendPrompt(opened.client, id, "Fail but persist.");
  await t.tools.waitUntil(() => terminals(events).length === 1, 60_000);
  t.assertions.assert(terminals(events)[0]?.type === "turnFailed", "turn did not fail");
  t.assertions.assert((await snapshot(opened, id)).data.summary.id === id, "failed session unreadable");
});

eventCase("archived-session-can-resume", "An archived idle session resumes after restoration", "unarchive preserves id and a new turn completes", ["archive poisons Agent state", "restore creates replacement"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: true } });
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: false } });
  await complete(opened, t, id, events, "Resume restored session.", "resumed");
  t.assertions.assert(terminals(events).at(-1)?.type === "turnCompleted", "restored session did not complete");
});

eventCase("rename-during-turn-safe", "Renaming during an active turn does not cancel it", "the delayed turn completes and the final snapshot has the new title", ["metadata lock cancels Agent", "completion restores old title"], async (t, opened) => {
  opened.mock.script({ text: "delayed", delayMs: 900 });
  const { id, events } = await create(opened, t);
  await t.flows.main.sendPrompt(opened.client, id, "Run while renamed.");
  await t.tools.waitUntil(() => events.some((event) => event.type === "turnStarted"), 30_000);
  await opened.client.call({ type: "session.rename", payload: { sessionId: id, title: "renamed-mid-turn" } });
  await t.tools.waitUntil(() => terminals(events).length === 1, 60_000);
  const snap = await snapshot(opened, id);
  t.assertions.assert(terminals(events)[0]?.type === "turnCompleted" && snap.data.summary.title === "renamed-mid-turn", "rename/turn did not converge");
});

eventCase("late-client-reads-completion", "A client connecting after completion reads the final timeline", "the late client obtains the same session id and nonempty items", ["timeline only exists in subscriber cache", "late hydration empty"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  await complete(opened, t, id, events, "Complete before observer.", "persist for observer");
  const observer = await t.flows.main.openSecondClient(opened, "late-agent-observer");
  try {
    const reply = await observer.call({ type: "session.get", payload: { sessionId: id } });
    t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.id === id && reply.data.items.length > 0, "late client saw no completed timeline");
  } finally { observer.close(); }
});

eventCase("title-stable-after-turn", "Completing a turn does not overwrite an explicit title", "session.list retains the exact pre-turn title", ["automatic title races explicit rename", "completion resets metadata"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  await opened.client.call({ type: "session.rename", payload: { sessionId: id, title: "explicit-stable-title" } });
  await complete(opened, t, id, events, "Do not retitle.", "completed");
  const listed = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: true } });
  const found = listed?.type === "sessions" ? listed.data.find((item) => item.id === id) : undefined;
  t.assertions.assert(found?.title === "explicit-stable-title", `title changed: ${JSON.stringify(found)}`);
});

eventCase("four-independent-terminals", "Four parallel sessions each own one terminal event", "all four logs complete once without failure or cancellation", ["terminal cross-talk", "one session consumes another response"], async (t, opened) => {
  opened.mock.script(...Array.from({ length: 4 }, (_, index) => ({ text: `parallel-${index}`, delayMs: 300 })));
  const created = await Promise.all(Array.from({ length: 4 }, () => create(opened, t)));
  await Promise.all(created.map(({ id }, index) => t.flows.main.sendPrompt(opened.client, id, `Parallel ${index}`)));
  await t.tools.waitUntil(() => created.every(({ events }) => terminals(events).length === 1), 60_000);
  t.assertions.assert(created.every(({ events }) => terminals(events)[0]?.type === "turnCompleted"), "parallel terminal mismatch");
});

eventCase("idle-interrupt-side-effect-free", "Interrupting an idle session does not poison its next turn", "after the idle interrupt settles or refuses, the next prompt completes once", ["idle interrupt permanently cancels session", "phantom canceled terminal"], async (t, opened) => {
  const { id, events } = await create(opened, t);
  try { await opened.client.call({ type: "session.interrupt", payload: { sessionId: id } }); } catch { /* explicit idle refusal is valid */ }
  const before = terminals(events).length;
  await complete(opened, t, id, events, "Run after idle interrupt.", "healthy");
  t.assertions.assert(terminals(events).length === before + 1 && terminals(events).at(-1)?.type === "turnCompleted", "idle interrupt poisoned next turn");
});

eventCase("two-observers-same-terminal", "Two clients agree on one terminal outcome", "both subscriptions observe exactly one completion for the same turn", ["connection-specific outcome", "fanout duplicate"], async (t, opened) => {
  opened.mock.script({ text: "shared terminal", delayMs: 300 });
  const { id, events } = await create(opened, t);
  const observer = await t.flows.main.openSecondClient(opened, "terminal-observer");
  try {
    const observed = await t.flows.main.attachEventLog(observer, id);
    await t.flows.main.sendPrompt(opened.client, id, "Share terminal.");
    await t.tools.waitUntil(() => terminals(events).length === 1 && terminals(observed).length === 1, 60_000);
    t.assertions.assert(terminals(events)[0]?.type === "turnCompleted" && terminals(observed)[0]?.type === "turnCompleted", "observers disagreed");
  } finally { observer.close(); }
});

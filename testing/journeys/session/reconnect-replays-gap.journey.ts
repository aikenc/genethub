import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.reconnect-replays-gap",
    title: "Reconnecting replays the gap without losing or repeating events",
    oracle: "a second Client.call subscribe sinceSeq:1 returns reset=false, ordered unique replay, last seq matches snapshot",
    catches: ["gap replay duplicates", "gap replay empty when the window still holds the turn"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const returning = await t.flows.main.openSecondClient(opened, "gap-replay");
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "hello there" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Say hello.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      const subscribed = await returning.call({
        type: "subscribe",
        payload: { sessionId, sinceSeq: 1, expandLastRound: false },
      });
      t.assertions.assert(subscribed?.type === "subscribed", `subscribe returned ${subscribed?.type}`);
      if (subscribed?.type !== "subscribed") return;
      t.assertions.assert(!subscribed.data.reset, "everything still fits in the replay window");
      t.assertions.assert(subscribed.data.replayed.length > 0, "the gap should be filled");
      const sequences = subscribed.data.replayed.map((event) => event.seq);
      const sorted = [...sequences].sort((a, b) => a - b);
      const unique = [...new Set(sorted)];
      t.assertions.assert(
        JSON.stringify(sequences) === JSON.stringify(unique),
        `duplicates or reordering: ${sequences.join(",")}`,
      );
      t.assertions.assert(
        sequences.at(-1) === subscribed.data.snapshot.seq,
        `replay ended at ${sequences.at(-1)}, snapshot seq ${subscribed.data.snapshot.seq}`,
      );
    } finally {
      returning.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

import { writeFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.gap-older-than-window",
    title: "Asking for a gap older than the window gets an honest full reset",
    oracle: "first-start config replayWindow:1 plus subscribe sinceSeq:0 after a turn returns reset and a useful snapshot",
    catches: ["overflow papered over as a continuation"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    writeFileSync(
      path.join(t.env.data, "config.json"),
      JSON.stringify({ port: 0, lanEnabled: false, replayWindow: 1 }, null, 2),
    );
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const returning = await t.flows.main.openSecondClient(opened, "gap-reset");
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "a reply long enough to produce several events" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Talk.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      const subscribed = await returning.call({
        type: "subscribe",
        payload: { sessionId, sinceSeq: 0, expandLastRound: false },
      });
      t.assertions.assert(subscribed?.type === "subscribed", `subscribe returned ${subscribed?.type}`);
      if (subscribed?.type !== "subscribed") return;
      t.assertions.assert(
        subscribed.data.reset,
        `a gap we cannot fill must be admitted (snapshot seq ${subscribed.data.snapshot.seq}, replayed ${subscribed.data.replayed.map((event) => event.seq).join(",")})`,
      );
      t.assertions.assert(
        subscribed.data.snapshot.items.length > 0,
        "the reset has to carry the full history to be useful",
      );
    } finally {
      returning.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.interrupted-round-superseded",
    title: "An interrupted round left dangling is ledgered as superseded once a new one starts",
    oracle: "chat.jsonl has superseded then completed after interrupt + new send",
    catches: ["dangling round dropped"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script(
        { text: "A slow reply, so the interrupt lands mid-turn.", delayMs: 800 },
        { text: "Unrelated new task." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const chat = path.join(opened.workspaceRoot, ".genethub", "sessions", sessionId, "chat.jsonl");
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "count to 500");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 20_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCanceled"), 30_000);
      await t.flows.main.sendPrompt(opened.client, sessionId, "something else entirely");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      await t.tools.waitUntil(() => existsSync(chat), 10_000);
      const rounds = foldRounds(readFileSync(chat, "utf8"));
      t.assertions.assert(rounds.length === 2, `expected two rounds, got ${rounds.length}`);
      t.assertions.assert(rounds[0]?.outcome === "superseded", `first outcome ${String(rounds[0]?.outcome)}`);
      t.assertions.assert(rounds[1]?.outcome === "completed", `second outcome ${String(rounds[1]?.outcome)}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

function foldRounds(contents: string): Array<{ outcome?: string }> {
  const rounds: Array<{ roundId?: string; outcome?: string }> = [];
  for (const line of contents.split("\n").filter((item) => item.trim())) {
    let row: { t?: string; round?: { roundId?: string; outcome?: string } };
    try {
      row = JSON.parse(line) as { t?: string; round?: { roundId?: string; outcome?: string } };
    } catch {
      continue;
    }
    if (row.t !== "round" || !row.round) continue;
    const existing = rounds.find((item) => item.roundId === row.round?.roundId);
    if (existing) Object.assign(existing, row.round);
    else rounds.push({ ...row.round });
  }
  return rounds;
}

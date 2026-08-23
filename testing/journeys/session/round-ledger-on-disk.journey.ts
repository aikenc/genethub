import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.round-ledger-on-disk",
    title: "A completed round is recorded in the round ledger on disk",
    oracle: "workspace .genethub/sessions/<id>/chat.jsonl has one completed round row",
    catches: ["ledger only in memory"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "ok" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const chat = path.join(opened.workspaceRoot, ".genethub", "sessions", sessionId, "chat.jsonl");
      t.assertions.assert(!existsSync(chat) || !readFileSync(chat, "utf8").includes('"t":"round"'), "ledgered before any prompt");
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "hello");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      await t.tools.waitUntil(() => existsSync(chat), 10_000);
      const rounds = foldRounds(readFileSync(chat, "utf8"));
      t.assertions.assert(rounds.length === 1, `expected one round, got ${rounds.length}`);
      t.assertions.assert(rounds[0]?.outcome === "completed", `outcome ${String(rounds[0]?.outcome)}`);
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

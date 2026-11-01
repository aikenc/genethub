import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.expert-quiet-task-completes",
  title: "a quiet worker survives its diagnostic window and delivers its real batch result once",
  oracle: "A slow real external Agent remains running beyond the batch quiet window; its completed sibling stays pending, one diagnostic is retained without undoing a Human pause, then both actual results arrive once",
  catches: ["silence cancels valid work", "finished sibling fabricates a stuck batch result", "diagnostic floods the requester", "a diagnostic undoes a Human pause"],
  tags: ["core", "expert", "quiet-task"], llm: { default: "none" },
  expectedDurationMs: 45000, timeoutMs: 120000,
  surfaces: ["daemon", "tools/team.py", "genet-cli", "script-agent"],
}, async t => {
  const r = await openTeam(t, "quiet-team", [{ id: "ctl-slow", profile: "normal", delayMs: 30000, chunks: 2 }]);
  try {
    const config = path.join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\nTEAM_PLATFORM_CHECK=99999\n");
    const idle = (id: string) => t.tools.waitUntil(async () => (await r.snapshot(id)).summary.status === "idle", 45000);
    await r.send(r.front, "Delegate a fast result and a legitimate quiet computation");
    await idle(r.front);
    const start = (agent: string, desc: string) => {
      const out = r.ok(["spawn", "--kind", "research", "--desc", desc, "--model", "fixture", desc],
        { TEAM_AGENT: agent, GENEHUB_SESSION_ID: r.front });
      return /s_[0-9a-f]+/.exec(out)![0];
    };
    const slow = start("ctl-slow", "quiet computation"), fast = start("ctl-normal", "fast result");
    await idle(fast);
    await r.client.call({ type: "session.interrupt", payload: { sessionId: r.front } });
    const hook = () => r.ok(["hook"], { TEAM_STUCK_AFTER: "300", TEAM_BATCH_STUCK_AFTER: "2" });
    const record = (id: string) => JSON.parse(readFileSync(r.state("pending", `${id}.json`), "utf8"));
    hook(); // Observe the fast sibling's real completion before the batch diagnostic.
    await new Promise(resolve => setTimeout(resolve, 3000));
    hook(); hook();
    const live = (await r.snapshot(slow)).summary;
    t.assertions.assert(live.status === "running" && !live.inputSummary?.paused, "quiet computation was interrupted");
    t.assertions.assert(!record(slow).done && !record(slow).stopReason && record(fast).done?.outcome === "ok", "batch retired or fabricated failure before the slow result");
    t.assertions.assert((await r.snapshot(r.front)).summary.inputSummary?.paused, "diagnostic undid Human pause");
    const diagnostics = readdirSync(r.state("notes")).filter(f => f.endsWith(".json"))
      .map(f => JSON.parse(readFileSync(r.state("notes", f), "utf8")))
      .filter(n => n.session === slow && n.kind === "anomaly");
    t.assertions.assert(diagnostics.length === 1, "quiet task diagnostic missing or repeated");
    await idle(slow);
    hook();
    t.assertions.assert(!existsSync(r.state("pending", `${slow}.json`)) && !existsSync(r.state("pending", `${fast}.json`)), "real finished batch did not retire");
    for (const id of [slow, fast]) {
      const done = JSON.parse(readFileSync(r.state("done", `${id}.json`), "utf8"));
      t.assertions.assert(done.done?.outcome === "ok", "actual result replaced by synthetic failure");
    }
    await r.send(r.front, "Continue and collect the completed results");
    await idle(r.front); hook(); await idle(r.front); hook();
    const replies = (await r.snapshot(r.front)).items.filter(item => item.type === "userMessage" && item.text.includes(slow) && item.text.includes(fast));
    t.assertions.assert(replies.length === 1, "actual batch result missing or duplicated");
    t.note("quiet computation survived, one diagnostic retained, Human pause preserved and both true results delivered once");
  } finally { await r.dispose(); }
});

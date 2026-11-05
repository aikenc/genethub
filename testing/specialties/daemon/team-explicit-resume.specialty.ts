import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

for (const delegated of [false, true]) {
defineSpecialty({
  id: delegated ? "specialty.daemon.team-explicit-resume.delegated-owner-once" : "specialty.daemon.team-explicit-resume.tracked-result-once",
  title: "explicit Human continuation resumes the original Agent once and returns its new result through Team tracking",
  oracle: "An archived real child is paused; internal notes preserve that pause, then one attributed continuation with a stable ID resumes it and establishes a fresh result baseline. Retries and conflicting bodies cannot run it twice, its original receipt survives, and the result waits for the Human-paused requester before being delivered once.",
  catches: ["native continuation bypasses Team result tracking", "repeated continuation re-arms a completed request", "conflicting IDs replay business", "a result undoes Human pause", "resumption loses the original receipt or Agent attribution"],
  tags: ["core", "team-explicit-resume"], llm: { default: "none" },
  expectedDurationMs: 25000, timeoutMs: 180000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["daemon", "genet-cli", "script-agent", "tools/team.py", "filesystem"],
  productInterfaces: ["session.send", "session.interrupt", "tools/team.py"],
}, async t => {
  const r = await openTeam(t, "resume-team", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = path.join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\nTEAM_PLATFORM_CHECK=99999\n");
    const idle = (id: string) => t.tools.waitUntil(async () => {
      const summary = (await r.snapshot(id)).summary;
      return summary.status === "idle" && summary.inputSummary?.pendingMessageIds.length === 0;
    }, 30000);
    const front = await r.create("ctl-cli-command");
    const cli = async (args: string[], caller = front) => {
      await r.send(caller, JSON.stringify({ argv: ["python3", path.join(r.root, "tools/team.py"), ...args], cwd: r.root }));
      await idle(caller);
      const replies = (await r.snapshot(caller)).items.filter(item => item.type === "assistantMessage");
      const last = replies[replies.length - 1];
      t.assertions.assert(last?.type === "assistantMessage", "real caller Agent did not report its command outcome");
      return JSON.parse(last!.type === "assistantMessage" ? last!.text : "null") as { code: number; out: string; err: string };
    };
    const ok = async (args: string[], caller = front) => {
      const result = await cli(args, caller);
      t.assertions.assert(result.code === 0, `Agent-bound team ${args[0]}: ${result.out.slice(-500)} ${result.err.slice(-500)}`);
      return result.out;
    };
    await r.send(front, "Coordinate one child and retain its original result"); await idle(front);
    const initial = await ok(["spawn", "--space", "leader", "--kind", "research", "--desc", "original short coordinator", "--model", "fixture", "complete the original read-only request"]);
    const child = /s_[0-9a-f]+/.exec(initial)![0];
    await idle(child); r.ok(["hook"]); await idle(front); r.ok(["hook"]);
    const donePath = r.state("done", `${child}.json`), pendingPath = r.state("pending", `${child}.json`);
    t.assertions.assert(existsSync(donePath) && !existsSync(pendingPath), "first result did not finish its Team subscription");
    const original = JSON.parse(readFileSync(donePath, "utf8"));
    await r.client.call({ type: "session.interrupt", payload: { sessionId: child } });
    const paused = () => r.snapshot(child).then(s => Boolean(s.summary.inputSummary?.paused));
    await t.tools.waitUntil(paused, 10000);
    await ok(["send", "--to", child, "--kind", "note", "Internal note only; do not repeat completed business"]);
    r.ok(["hook"]); t.assertions.assert(await paused(), "internal notice resumed a Human pause");
    const actor = delegated ? await r.create("ctl-cli-command") : front;
    const operation = "human-resume.original-once", goal = "Continue only the remaining read-only summary; preserve the original work";
    const args = ["send", "--to", child, "--kind", "human", "--resume", "--message-id", operation, goal];
    const missingId = await cli(["send", "--to", child, "--kind", "human", "--resume", goal], actor);
    t.assertions.assert(missingId.code !== 0 && await paused(), "resume without a stable ID changed the pause");
    await ok(args, actor);
    await ok(args, actor);
    const conflict = await cli([...args.slice(0, -1), "DIFFERENT BUSINESS MUST NOT RUN"], actor);
    t.assertions.assert(conflict.code !== 0, "same operation ID accepted different business");
    await idle(child);
    const resumed = await r.snapshot(child), newReply = resumed.summary.latestReply?.itemId;
    t.assertions.assert(!!newReply && newReply !== original.done.reply && !resumed.summary.inputSummary?.paused, "explicit continuation did not produce a new real final reply");
    const requests = resumed.items.filter(item => item.type === "userMessage" && item.id === operation);
    t.note(JSON.stringify({ continuationCount: requests.length, expectedSender: actor,
      inputs: resumed.items.filter(item => item.type === "userMessage").map(item => ({ id: item.id, origin: item.origin, hasGoal: item.text.includes(goal) })) }));
    t.assertions.assert(requests.length === 1, "continuation was duplicated or its original input ID was lost");
    t.assertions.assert(requests[0]?.type === "userMessage" && requests[0].origin?.sessionId === actor && requests[0].text.includes(goal), "continuation lost its authenticated Agent attribution or goal");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    t.assertions.assert(pending.requester === front && pending.baseline === original.done.reply && pending.resumeAwaitingReceipt === false, "new result subscription missing or its baseline was reset by a retry");
    const receipts = readdirSync(r.state("resumes")).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(r.state("resumes", n), "utf8")));
    const receipt = receipts.find(entry => entry.id === operation);
    t.assertions.assert(receipt?.state === "accepted" && receipt.previousDone.done.ref === original.done.ref && receipt.previousDone.done.text === original.done.text, "explicit continuation lost its original result receipt");
    await r.client.call({ type: "session.interrupt", payload: { sessionId: front } });
    r.ok(["hook"]);
    t.assertions.assert((await r.snapshot(front)).summary.inputSummary?.paused && !existsSync(pendingPath), "completed child result undid requester pause or failed to retire");
    const done = JSON.parse(readFileSync(donePath, "utf8"));
    t.assertions.assert(done.done.reply === newReply, "Team returned the old result instead of the resumed final reply");
    await r.send(front, "Collect the existing result without redoing work"); await idle(front);
    r.ok(["hook"]); await idle(front); r.ok(["hook"]);
    const resultCopies = (await r.snapshot(front)).items.filter(item => item.type === "userMessage" && item.text.includes(`ghref:item:${child}:${newReply}`));
    t.assertions.assert(resultCopies.length === 1, "resumed result was missing or delivered twice");
    await ok(args, actor); r.ok(["hook"]);
    t.assertions.assert(!existsSync(pendingPath) && (await r.snapshot(child)).items.filter(item => item.type === "userMessage" && item.id === operation).length === 1, "retry after completion re-armed or replayed the task");
    const receiptFile = readdirSync(r.state("resumes")).find(n => n.endsWith(".json") && JSON.parse(readFileSync(r.state("resumes", n), "utf8")).id === operation)!;
    const savedReceipt = readFileSync(r.state("resumes", receiptFile), "utf8");
    writeFileSync(r.state("resumes", receiptFile), "incomplete operation receipt");
    try {
      const damaged = await cli(args, actor);
      t.assertions.assert(damaged.code !== 0 && readFileSync(r.state("resumes", receiptFile), "utf8") === "incomplete operation receipt", "damaged operation receipt was overwritten or treated as a fresh request");
      t.assertions.assert(!existsSync(pendingPath) && (await r.snapshot(child)).items.filter(item => item.type === "userMessage" && item.id === operation).length === 1, "damaged receipt caused replay or result re-arming");
    } finally { writeFileSync(r.state("resumes", receiptFile), savedReceipt); }
    t.note("same original native Session; one attributed continuation; conflicting payload and damaged receipt refused; original receipt retained; new result delivered once after requester continuation");
  } finally { await r.dispose(); }
});
}

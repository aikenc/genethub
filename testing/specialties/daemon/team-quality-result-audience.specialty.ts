import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-result-audience",
  title: "An explicit result watcher preserves the primary requester without creating a routing redline",
  oracle: "A real Task receives a third-party public send, which registers a genuine watcher without hijacking its primary requester. Both actual Sessions receive the native result once. The public collector/card accepts the explicitly bound audience, while labelled external snapshot faults retain wrong-recipient and per-recipient duplicate detection and legacy snapshots keep their original semantics.",
  catches: ["declared watcher is scored as a wrong recipient", "normal result fanout is scored as a duplicate", "watcher receipt replaces primary delivery", "arbitrary recipient or mismatched result ref is exempted", "duplicate to same recipient is ignored", "old frozen snapshots change meaning"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py send", "tools/run.py tick", "tools/run.py quality facts", "tools/run.py quality card", "session.get"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "result-audience", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let sequence = 0;
    const cli = async (sid: string, args: string[]) => {
      const requestId = "audience." + (++sequence);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId })); await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage" && x.text.includes(JSON.stringify(requestId))).at(-1);
      if (item?.type !== "assistantMessage") throw Error("actual command receipt missing");
      const reply = JSON.parse(item.text); t.assertions.assert(reply.code === 0, reply.err + reply.out); return reply;
    };
    const front = await r.create("ctl-cli-command"), watcher = await r.create("ctl-cli-command");
    const start = await cli(front, ["task", "start", "--space", "leader", "--desc", "explicit result audience", "--request-id", "audience.goal", "Complete a bounded goal while preserving an explicit observer"]);
    const task = JSON.parse(start.out.trim().split("\n").at(-1)!); const owner = task.owner.sessionId as string; await idle(owner);
    await cli(watcher, ["send", "--to", owner, "--kind", "task", "Observe this existing task without replacing its primary requester"]); await idle(owner);
    const record = () => {
      const pending = r.state("pending", owner + ".json");
      return JSON.parse(readFileSync(existsSync(pending) ? pending : r.state("done", owner + ".json"), "utf8"));
    };
    t.assertions.assert(record().requester === front && record().watchers.includes(watcher), "public send did not preserve the primary and declare its observer");
    await cli(owner, ["task", "finish", task.taskId, "--outcome", "success", "One genuine result for the primary and its declared watcher"]);
    r.ok(["tick"]); await idle(front); await idle(watcher);
    const delivered = record();
    const resultMessages = async (sid: string) => (await r.snapshot(sid)).items.filter(x => x.type === "userMessage" && x.text.startsWith("用途: result\n") && x.text.includes("One genuine result for the primary"));
    t.assertions.assert((await resultMessages(front)).length === 1 && (await resultMessages(watcher)).length === 1 && delivered.resultDelivery.queued === true,
      "actual native result was not delivered once to each intended recipient");
    const facts = JSON.parse(r.ok(["quality", "facts"]));
    const work = facts.workItems.find((x: any) => x.id === delivered.operationId);
    t.assertions.assert(work?.deliveryEvents.length === 2 && work.deliveryCoverageKnown === true, "native fanout evidence was not captured");
    const file = join(t.env.root, "external-audience-facts.json");
    const card = (value: any) => { writeFileSync(file, JSON.stringify(value)); return JSON.parse(r.ok(["quality", "card", "--snapshot", file])); };
    const first = card(facts);
    t.assertions.assert(first.redLines.R3.triggered === false && !first.officialCapture,
      "one actual result to a primary and declared watcher was called wrong-recipient or duplicate");
    const fault = () => { const v = structuredClone(facts); v.fixture = "labelled external scoring fault only; no native delivery or official history claim"; return v; };
    for (const recipient of [front, watcher]) {
      const v = fault(), item = v.workItems.find((x: any) => x.id === delivered.operationId);
      const event = item.deliveryEvents.find((x: any) => x.recipient === recipient);
      item.deliveryEvents.push({ ...event, messageId: "fixture-distinct-duplicate", acceptedAtMs: event.acceptedAtMs + 1 });
      t.assertions.assert(card(v).redLines.R3.instances.some((x: any) => x.reason === "duplicate-result"), "same-recipient duplicate was exempted by the audience");
    }
    const undeclared = fault(); undeclared.workItems.find((x: any) => x.id === delivered.operationId).deliveryAudience.watchers = [];
    t.assertions.assert(card(undeclared).redLines.R3.instances.some((x: any) => x.reason === "wrong-recipient"), "undeclared recipient was exempted");
    const mismatched = fault(); mismatched.workItems.find((x: any) => x.id === delivered.operationId).deliveryAudience.ref = "ghref:session:unrelated";
    t.assertions.assert(card(mismatched).redLines.R3.instances.some((x: any) => x.reason === "wrong-recipient"), "unrelated result generation inherited watcher permission");
    const legacy = fault(); delete legacy.resultAudienceBasis;
    for (const item of legacy.workItems) delete item.deliveryAudience;
    const old = card(legacy);
    t.assertions.assert(old.redLines.R3.triggered === true && old.streakCompatibilityKey !== first.streakCompatibilityKey,
      "legacy facts were silently reinterpreted or mixed with the new audience basis");
    t.note("Actual public Task/send/native delivery and collector; only external duplicate/contract faults are labelled frozen snapshots. Original requester timing and legacy semantics retained; no live Team mutation or official-score claim.");
  } finally { await r.dispose(); }
});

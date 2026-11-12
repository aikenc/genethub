import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-upgrade-delivery",
  title: "Upgrade reuses a proven legacy batch input and preserves unknown delivery obligations",
  oracle: "A restored legacy ledger references real native conclusions and an already consumed native batch input. The public timer migrates both children to that input without another send; partial archival replay is idempotent, unknown receipts remain pending, and an independent idle-requester result queues within one minute. Refreshing only the template baseline does not close an adoption note.",
  catches: ["upgrade replaces a legacy receipt and duplicates its result", "one archived batch sibling loses the original input identity", "unknown delivery is guessed accepted or resent", "unknown legacy record blocks independent delivery", "template baseline is mistaken for deployed adoption"],
  tags: ["core", "team-result", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py tick", "tools/run.py snapshot", "session.send", "session.get", "session.narrative", "Team persisted delivery ledger"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 30000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "upgrade-delivery");
  const write = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  const idle = (sid: string) => t.tools.waitUntil(async () => {
    const s = (await r.snapshot(sid)).summary;
    return s.status === "idle" && !!s.latestReply && !s.inputSummary?.pendingMessageIds.length;
  }, 30000);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    await r.send(r.front, "Coordinate the bounded upgrade acceptance"); await idle(r.front);
    const role = r.spaces.find(x => x.name === "research" && x.agentSpace?.parentWorkspaceId === r.project.id)!;
    const conclusions = [] as any[];
    for (let n = 0; n < 5; n++) {
      const sid = await r.create("ctl-normal", role.id);
      await r.send(sid, "Produce independent evidence " + n); await idle(sid);
      const view = await r.snapshot(sid), reply = view.summary.latestReply!.itemId;
      const message = view.items.find(x => x.id === reply);
      t.assertions.assert(message?.type === "assistantMessage", "real native conclusion absent");
      const done = { outcome: "ok", reply, ref: `ghref:item:${sid}:${reply}`, text: message!.type === "assistantMessage" ? message!.text : "" };
      // Explicit persisted-format fixture, matching the incident's Python JSON
      // digest representation; it is not an oracle for native acceptance.
      const oldJson = "{" + Object.keys(done).sort().map(k => JSON.stringify(k) + ": " + JSON.stringify((done as any)[k]).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))).join(", ") + "}";
      const legacy = { key: "legacy-batch-hash", state: "queued", to: r.front, transport: "queue", atMs: Date.now(), resultHash: createHash("sha256").update(oldJson).digest("hex") };
      conclusions.push({ sessionId: sid, requester: r.front, kind: "research", desc: "restored upgrade result", createdAtMs: Date.now(), baseline: reply, notified: [], batch: "prior-batch", done, resultDelivery: legacy });
    }
    const messageId = "x.original-upgrade-batch";
    const oldBody = `用途: result\n发送方: original batch\nref: ${conclusions.slice(0, 2).map(x => x.done.ref).join(", ")}\n\nOriginal completed batch evidence`;
    const sent = await runGenetAsync(r.daemon.genet, ["session", "send", r.front, oldBody, "--system", "--message-id", messageId, "--no-wait"], r.env);
    t.assertions.assert(sent.code === 0, "original native batch send failed"); await idle(r.front);
    const results = async () => (await r.snapshot(r.front)).items.filter(x => x.type === "userMessage" && x.text.startsWith("用途: result\n"));
    t.assertions.assert((await results()).filter(x => x.id === messageId).length === 1, "original native receipt missing");
    for (const rec of conclusions.slice(0, 3)) write(r.state("pending", rec.sessionId + ".json"), rec);
    // The fourth independent conclusion has no prior delivery claim.
    const independent = { ...conclusions[3] }; delete independent.resultDelivery;
    write(r.state("pending", independent.sessionId + ".json"), independent);
    const queued = conclusions[4], inboxId = "x.original-upgrade-inbox";
    write(r.state("pending", queued.sessionId + ".json"), queued);
    const inbox = r.state("inbox", r.front + ".jsonl"); mkdirSync(dirname(inbox), { recursive: true });
    writeFileSync(inbox, JSON.stringify({ messageId: inboxId, atMs: Date.now(), purpose: "result", sender: "original queued sender", ref: queued.done.ref, text: "Original queued evidence", machine: null }) + "\n");
    const started = Date.now();
    // Each bounded timer pass can retain unfinished reconciliation. Observe
    // real archive completion across passes within the original user contract,
    // rather than treating a returned hook as five completed deliveries.
    await t.tools.waitUntil(async () => {
      r.ok(["hook"]);
      return [...conclusions.slice(0, 2), independent, queued].every(rec =>
        existsSync(r.state("done", rec.sessionId + ".json")));
    }, 60000);
    await idle(r.front);
    t.assertions.assert(Date.now() - started < 60000, "idle requester result exceeded one minute");
    for (const rec of conclusions.slice(0, 2)) {
      const saved = JSON.parse(readFileSync(r.state("done", rec.sessionId + ".json"), "utf8"));
      t.assertions.assert(saved.resultDelivery.messageId === messageId && saved.resultDelivery.queued
        && JSON.stringify(saved.resultDelivery.legacyReceipt) === JSON.stringify(rec.resultDelivery), "legacy batch lost original native identity or metadata");
    }
    const unknownPath = r.state("pending", conclusions[2].sessionId + ".json");
    const unknown = JSON.parse(readFileSync(unknownPath, "utf8"));
    t.assertions.assert(JSON.stringify(unknown.resultDelivery) === JSON.stringify(conclusions[2].resultDelivery)
      && unknown.lastReconcileError && !existsSync(r.state("done", conclusions[2].sessionId + ".json")), "unknown delivery was replaced or silently settled");
    const queuedRecord = JSON.parse(readFileSync(r.state("done", queued.sessionId + ".json"), "utf8"));
    t.assertions.assert(queuedRecord.resultDelivery.messageId === inboxId && queuedRecord.resultDelivery.migrationBasis === "original-inbox-envelope"
      && (await results()).filter(x => x.id === inboxId).length === 1, "original durable inbox identity was replaced");
    t.assertions.assert((await results()).length === 3 && (await results()).some(x => x.type === "userMessage" && x.text.includes(independent.done.ref)), "legacy migration resent old results or hid independent delivery");
    // Crash recovery can restore one pending sibling after another is archived.
    write(r.state("pending", conclusions[0].sessionId + ".json"), conclusions[0]);
    r.ok(["hook"]); await idle(r.front);
    t.assertions.assert((await results()).length === 3 && JSON.parse(readFileSync(unknownPath, "utf8")).resultDelivery.key === "legacy-batch-hash", "partial archival replay duplicated inputs or discarded unknown legacy data");
    const note = { id: "nupgrade-acceptance", kind: "upgrade", atMs: Date.now(), text: "baseline is not adoption" };
    const notePath = r.state("notes", note.id + ".json");
    write(notePath, note);
    const sourceFile = join(r.root, "tools/genet_builtin/team.py"), source = readFileSync(sourceFile, "utf8");
    writeFileSync(sourceFile, source + "\n# User-owned pending adoption patch\n");
    r.ok(["snapshot", "--refresh-platform"]);
    t.assertions.assert(existsSync(notePath) && readFileSync(sourceFile, "utf8").endsWith("# User-owned pending adoption patch\n")
      && !existsSync(r.state("notes-done", note.id + ".json")), "baseline refresh falsely closed adoption or overwrote customized source");
    t.note("Actual native batch accepted/consumed before restored ledger migration; original input reused, unknown evidence retained, independent idle delivery <60s, baseline-only adoption kept pending. No live Team/project mutation.");
  } finally { await r.dispose(); }
});

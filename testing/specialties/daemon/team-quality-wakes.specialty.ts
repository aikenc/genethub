import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-wakes",
  title: "Native system wake rounds distinguish actual ledger increments, no-op reads and unobserved intervals",
  oracle: "Actual public task creation changes the durable ledger; status and identical replay do not. Native system rounds and bracketing hook observations expose those facts, while Human input, absent samples and failed diagnostic writes cannot manufacture a good score.",
  catches: ["M5 has no native samples", "idempotent replay counted as progress", "missing telemetry becomes no-op", "Human input counted as automatic wake", "diagnostic fault blocks business"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py hook", "tools/run.py quality facts", "genet-cli", "session.inspect", "session.rounds"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 45000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "wake-ledger-fixture", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = path.join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const front = await r.create("ctl-cli-command");
    const idle = () => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(front)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const body = (args: string[]) => JSON.stringify({ argv: ["python3", path.join(r.root, "tools/run.py"), ...args], cwd: r.root });
    const answer = async () => {
      const last = (await r.snapshot(front)).items.filter(x => x.type === "assistantMessage").at(-1);
      if (last?.type !== "assistantMessage") throw new Error("native caller did not finish");
      const result = JSON.parse(last.text);
      t.assertions.assert(result.code === 0, "public task operation failed: " + result.err + result.out);
      const final = result.out.trim().split("\n").at(-1);
      try { return JSON.parse(final); } catch { return final; }
    };
    const system = async (id: string, args: string[]) => {
      const sent = await runGenetAsync(r.daemon.genet, ["session", "send", front, body(args), "--system", "--message-id", id, "--no-wait"], r.env);
      t.assertions.assert(sent.code === 0, "native system send failed: " + sent.stderr);
      await idle();
      return answer();
    };
    const start = ["task", "start", "--space", "leader", "--desc", "native wake evidence", "--request-id", "wake.original", "Maintain a bounded work ledger"];
    await r.send(front, body(start)); await idle();
    const task = await answer();
    r.ok(["hook"]);
    await system("wake.read", ["task", "status", task.taskId]);
    const replay = await system("wake.retry", start);
    t.assertions.assert(replay.taskId === task.taskId && replay.owner.sessionId === task.owner.sessionId, "retry changed business ownership");
    const changed = await system("wake.changed", start.map(x => x === "wake.original" ? "wake.second" : x));
    t.assertions.assert(changed.taskId !== task.taskId, "fixture did not create a distinct durable task");
    const note = r.ok(["note", "--session", front, "--kind", "observation", "--quote", "fixture",
      "--context", "Observe ordinary reflection note completion", "Bounded observation note"]).match(/\bn[0-9a-f]{12}\b/)?.[0];
    if (!note) throw new Error("public note creation returned no stable identity");
    await system("wake.note-done", ["notes", "done", note]);
    for (let i = 0; i < 20; i++) await system("wake.noop." + i, ["task", "status", task.taskId]);
    await r.client.call({ type: "session.interrupt", payload: { sessionId: front } });
    await t.tools.waitUntil(async () => Boolean((await r.snapshot(front)).summary.inputSummary?.paused), 10000);
    const coalesced = await runGenetAsync(r.daemon.genet, ["session", "send", front, body(["task", "status", task.taskId]),
      "--system", "--message-id", "wake.coalesced", "--no-wait"], r.env);
    t.assertions.assert(coalesced.code === 0, "paused system input was not admitted");
    await r.send(front, body(["task", "status", task.taskId])); await idle(); await answer();
    r.ok(["hook"]);
    const facts = () => JSON.parse(r.ok(["quality", "facts"]));
    const observed = facts();
    const rows = (id: string, value = observed) => value.wakes.filter((x: any) => x.messageId === id);
    t.assertions.assert(rows("wake.read").length === 1 && rows("wake.read")[0].ledgerChanged === false,
      "actual native read-only wake has no proven no-delta observation");
    t.assertions.assert(rows("wake.retry").length === 1 && rows("wake.retry")[0].ledgerChanged === false,
      "identical request replay manufactured a work-ledger increment");
    t.assertions.assert(rows("wake.changed").length === 1 && rows("wake.changed")[0].ledgerChanged === true,
      "real native task creation lost its ledger increment");
    t.assertions.assert(rows("wake.note-done").length === 1 && rows("wake.note-done")[0].ledgerChanged === true,
      "completed reflection note was miscounted as idle");
    const noops = observed.wakes.filter((x: any) => x.messageId?.startsWith("wake.noop."));
    t.assertions.assert(noops.length === 20 && noops.every((x: any) => x.ledgerChanged === false),
      "twenty actual no-op rounds were omitted or turned into progress");
    const inspection = await r.client.call({ type: "session.inspect", payload: { sessionId: front, throughRoundId: null } });
    if (inspection?.type !== "sessionInspection") throw new Error("native input evidence unavailable");
    const human = inspection.data.retainedInputs?.filter(x => x.source === "user").map(x => x.messageId) ?? [];
    t.assertions.assert(human.length > 0 && !observed.wakes.some((x: any) => human.includes(x.messageId)), "Human input was scored as an automatic wake");
    const mixed = inspection.data.retainedInputs?.find(x => x.messageId === "wake.coalesced");
    const sharesHumanTurn = inspection.data.retainedInputs?.some(x => x.source === "user" && x.turnId === mixed?.turnId);
    // Native admission may execute a Human continuation before its queued
    // system input. Adjacency is not proof that both belong to one turn.
    t.assertions.assert(Boolean(mixed?.turnId) && (sharesHumanTurn ? rows("wake.coalesced").length === 0
      : rows("wake.coalesced").length === 1 && rows("wake.coalesced")[0].ledgerChanged === false),
      "wake classification disagrees with the native Human/system turn boundary: "
      + JSON.stringify({ mixed, human: inspection.data.retainedInputs?.filter(x => x.source === "user"), observations: rows("wake.coalesced") }));
    const frozen = path.join(r.root, "frozen-wakes.json"); writeFileSync(frozen, JSON.stringify(observed));
    const card = JSON.parse(r.ok(["quality", "card", "--snapshot", frozen]));
    t.assertions.assert(card.indicators.idleWakePct.samples >= 20 && card.metrics.M5 === 0,
      "actual no-op wake evidence did not reach the unchanged tq/1 metric");
    const eventFile = r.state("events", "events.jsonl");
    const original = readFileSync(eventFile);
    // Explicit frozen missing-observation input; never called native coverage.
    writeFileSync(eventFile, original.toString().trim().split("\n").map(x => JSON.parse(x))
      .filter(x => x.kind !== "ledger-observed").map(x => JSON.stringify(x)).join("\n") + "\n");
    const absent = facts();
    t.assertions.assert(rows("wake.read", absent)[0]?.ledgerChanged === null
      && rows("wake.changed", absent)[0]?.ledgerChanged === true,
      "absent observation became zero progress or erased a genuine delta");
    writeFileSync(eventFile, original);
    const saved = eventFile + ".saved";
    renameSync(eventFile, saved); mkdirSync(eventFile);
    try {
      const success = await system("wake.diagnostic-fault", start.map(x => x === "wake.original" ? "wake.fault" : x));
      const durable = JSON.parse(readFileSync(r.state("tasks", success.taskId + ".json"), "utf8"));
      t.assertions.assert(durable.owner.sessionId === success.owner.sessionId, "diagnostic append failure rolled back the actual task");
    } finally { rmdirSync(eventFile); renameSync(saved, eventFile); }
    r.ok(["hook"]);
    const failed = facts();
    t.assertions.assert(failed.wakes.every((x: any) => x.ledgerChanged === null), "failed diagnostic append manufactured complete absence evidence");
  } finally { await r.dispose(); }
});

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-event-spool",
  title: "Concurrent native Task events remain durable while the shared event append lock is occupied",
  oracle: "A real OS lock blocks event append while a genuine Agent starts a Task through the public CLI. The public collector must still find its real confirmation and complete event coverage. A normal later hook folds the durable events; restoring one exact file models append-before-unlink crash recovery and must not duplicate work. No native execution, receipt or timestamp is fabricated.",
  catches: ["parallel event producers silently lose conclusions", "lock contention invalidates a whole hour", "undrained durable events are invisible", "append crash duplicates an event"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task start", "tools/run.py quality facts", "tools/run.py hook", "session.send", "session.get"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "event-spool", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  let locker: ReturnType<typeof spawn> | undefined;
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\n");
    const lock = r.state("inbox", "quality-events.lock"), ready = join(t.env.root, "event-lock-ready");
    mkdirSync(dirname(lock), { recursive: true });
    const script = `import os,pathlib,sys
p=pathlib.Path(sys.argv[1]);f=p.open('a+b')
if os.name=='nt':
 import msvcrt
 if p.stat().st_size==0:f.write(b'0');f.flush()
 f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_LOCK,1)
else:
 import fcntl
 fcntl.flock(f.fileno(),fcntl.LOCK_EX)
pathlib.Path(sys.argv[2]).write_text('locked')
sys.stdin.read(1)
`;
    locker = spawn(process.env.GENEHUB_PYTHON!, ["-c", script, lock, ready], { env: r.env, stdio: ["pipe", "ignore", "ignore"] });
    await t.tools.waitUntil(async () => existsSync(ready), 5000);
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const caller = await r.create("ctl-cli-command");
    await r.send(caller, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "task", "start", "--space", "leader", "--desc", "concurrent event durability", "--request-id", "events.goal", "Assess a bounded goal"], cwd: r.root, requestId: "events.start" }));
    await idle(caller);
    const reply = (await r.snapshot(caller)).items.filter(x => x.type === "assistantMessage" && x.text.includes('"events.start"')).at(-1);
    if (reply?.type !== "assistantMessage") throw Error("actual Task receipt missing");
    const receipt = JSON.parse(reply.text); t.assertions.assert(receipt.code === 0, "event contention blocked the real Task: " + receipt.err);
    const task = JSON.parse(receipt.out.trim().split("\n").at(-1)!); await idle(task.owner.sessionId);
    const facts = () => JSON.parse(r.ok(["quality", "facts"]));
    const blocked = facts(), item = blocked.workItems.find((x: any) => x.sessionId === task.owner.sessionId);
    t.assertions.assert(locker.exitCode === null && blocked.evidenceCoverage?.lifecycleEventsComplete === true
      && blocked.evidenceCoverage?.failureCount === 0 && typeof item?.confirmedAtMs === "number",
      "real event-lock contention lost the native dispatch confirmation or created a false lifecycle gap");
    const spool = r.state("events", "spool"), files = readdirSync(spool).filter(x => x.endsWith(".json"));
    t.assertions.assert(files.length > 0, "no durable event evidence survived the occupied append lock");
    const name = files[0], original = readFileSync(join(spool, name));
    locker.stdin?.end(); await t.tools.waitUntil(async () => locker!.exitCode !== null, 5000);
    r.ok(["hook"]);
    t.assertions.assert(!existsSync(join(spool, name)), "later producer did not fold the durable event into the append log");
    // Restored exact event bytes: append succeeded but unlink was interrupted.
    // Native Task, input and execution history are never changed.
    writeFileSync(join(spool, name), original);
    const recovered = facts();
    t.assertions.assert(recovered.evidenceCoverage?.failureCount === 0
      && recovered.workItems.filter((x: any) => x.sessionId === task.owner.sessionId).length === 1
      && recovered.workItems.find((x: any) => x.sessionId === task.owner.sessionId).confirmedAtMs === item.confirmedAtMs,
      "restored append-crash event duplicated or lost the original native work identity");
    const eventFile = r.state("events", "events.jsonl"), savedLog = eventFile + ".append-unavailable";
    renameSync(eventFile, savedLog); mkdirSync(eventFile);
    try {
      await r.send(caller, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "note", "--kind", "idea", "--quote", "durable event", "--context", "append unavailable, spool writable", "Keep actual note"], cwd: r.root, requestId: "events.append-unavailable" }));
      await idle(caller);
      const noteReply = (await r.snapshot(caller)).items.filter(x => x.type === "assistantMessage" && x.text.includes('"events.append-unavailable"')).at(-1);
      t.assertions.assert(noteReply?.type === "assistantMessage" && JSON.parse(noteReply.text).code === 0,
        "temporary append failure blocked the real native note");
      t.assertions.assert((!existsSync(r.state("events", "failures")) || readdirSync(r.state("events", "failures")).length === 0)
        && readdirSync(spool).some(x => x.endsWith(".json")),
        "readable durable event was falsely recorded as lost after append failed");
    } finally { rmdirSync(eventFile); renameSync(savedLog, eventFile); }
    const retained = facts();
    t.assertions.assert(retained.evidenceCoverage?.failureCount === 0 && retained.issues.length === 0,
      "restored append storage could not read the retained real event");
    const oversized = join(spool, "a".repeat(64) + ".json");
    try {
      writeFileSync(oversized, " ".repeat(8193));
      t.assertions.assert(r.command(["quality", "facts"]).code !== 0,
        "collector ignored an oversized queued event instead of preserving unknown evidence");
    } finally { unlinkSync(oversized); }
    t.note("Real OS lock, genuine native Task and public collector; exact event-file crash fixture only. Original historical gaps remain untouched.");
  } finally {
    locker?.stdin?.end();
    if (locker) await t.tools.waitUntil(async () => locker!.exitCode !== null, 5000);
    await r.dispose();
  }
});

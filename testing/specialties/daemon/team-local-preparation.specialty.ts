import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-local-preparation-conclusion",
  title: "A concluded Task fences only local preparations explicitly known never to have attempted creation",
  oracle: "Actual public support refuses a missing or occupied directory before native creation. A still-active original stays untouched; an honest blocked conclusion permits one durable local fence and original result delivery. Ambiguous markers, a real paused support and its original writer bytes stay intact, with no new session or business replay.",
  catches: ["uncreated local intent traps a concluded Task forever", "absence guessed to be a negative native result", "another writer or paused support released", "old local operation replay creates work"],
  tags: ["core", "team-withdrawal", "team-task"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.interrupt", "session.get"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 25000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "local-preparation-conclusion", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_WAKE_GAP=999999\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\nTEAM_BOARD_PORT=0\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let sequence = 0;
    const cli = async (sid: string, args: string[], expected = 0) => {
      const requestId = "local-prepare." + (++sequence);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId }));
      await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage" && x.text.includes(JSON.stringify(requestId))).at(-1);
      if (item?.type !== "assistantMessage") throw Error("native command receipt missing");
      const reply = JSON.parse(item.text);
      t.assertions.assert(expected === 0 ? reply.code === 0 : reply.code !== 0, reply.out + reply.err);
      return expected === 0 ? JSON.parse(reply.out.trim().split("\n").at(-1)!) : reply;
    };
    const front = await r.create("ctl-cli-command");
    const start = async (key: string) => {
      const task = await cli(front, ["task", "start", "--space", "leader", "--desc", key, "--request-id", key, "Keep original bounded work and report its honest outcome"]);
      await idle(task.owner.sessionId); return task;
    };
    const intents = () => readdirSync(r.state("task-dispatch")).filter(x => x.endsWith(".json"))
      .map(x => JSON.parse(readFileSync(r.state("task-dispatch", x), "utf8")));
    const rejected = async (task: any, key: string, directory: string) => {
      const args = ["task", "support", task.taskId, "--space", "qa", "--desc", key, "--request-id", key, "--directory", directory, "Do not execute if the original resource cannot be claimed"];
      await cli(task.owner.sessionId, args, 1);
      const intent = intents().find(x => x.request.desc === key);
      t.assertions.assert(intent?.state === "creating" && intent.createAttempted === false && !intent.sessionId && !intent.lock && !intent.resourceBinding,
        "actual resource refusal did not preserve the observed pre-creation incident");
      return { intent, args, file: r.state("task-dispatch", intent.operationId + ".json") };
    };
    const task = await start("local.missing");
    const missing = await rejected(task, "local.missing.support", join(r.root, "not-created-directory"));
    const activeBytes = readFileSync(missing.file, "utf8");
    r.ok(["tick"]); await idle(task.owner.sessionId);
    t.assertions.assert(readFileSync(missing.file, "utf8") === activeBytes, "an active goal's uncreated preparation was withdrawn");
    await cli(task.owner.sessionId, ["task", "finish", task.taskId, "--outcome", "blocked", "Original directory was unavailable; no business was executed"]);
    const originalConclusion = JSON.parse(readFileSync(r.state("tasks", task.taskId + ".json"), "utf8")).finished;
    r.ok(["tick"]); await idle(front);
    const fenced = JSON.parse(readFileSync(missing.file, "utf8"));
    t.assertions.assert(fenced.state === "withdrawn" && fenced.withdrawnAtMs >= originalConclusion.atMs
      && fenced.createAttempted === false && !fenced.sessionId, "known uncreated local intent still prevents concluded Task settlement");
    const settled = JSON.parse(readFileSync(r.state("tasks", task.taskId + ".json"), "utf8"));
    t.assertions.assert(settled.state === "active" && existsSync(r.state("done", task.owner.sessionId + ".json")) && JSON.stringify(settled.finished) === JSON.stringify(originalConclusion)
      && settled.owner.sessionId === task.owner.sessionId, "local fence relabelled the original blocked outcome or changed ownership");
    const fenceBytes = readFileSync(missing.file, "utf8");
    r.ok(["tick"]);
    await cli(task.owner.sessionId, missing.args, 1);
    t.assertions.assert(readFileSync(missing.file, "utf8") === fenceBytes, "local fence replay mutated or restarted the old operation");

    const live = await start("local.real-writer");
    const directory = join(r.root, "real-writer"); mkdirSync(directory);
    const child = await cli(live.owner.sessionId, ["task", "support", live.taskId, "--space", "qa", "--desc", "actual writer", "--request-id", "local.real-child", "--directory", directory, "Keep the real original writer until its own explicit conclusion"]);
    await idle(child.collaborator);
    await r.client.call({ type: "session.interrupt", payload: { sessionId: child.collaborator } });
    const pause = (await r.snapshot(child.collaborator)).summary.inputSummary;
    const lease = join(directory, ".genethub/genet-writer.json"), leaseBytes = readFileSync(lease, "utf8");
    const occupied = await rejected(live, "local.other-writer-refusal", directory);
    // Restored crash-shape boundaries only. Actual creation and resource
    // refusals above use native public calls; missing/true markers prove no absence.
    const uncertainFiles: Array<[string, string]> = [];
    for (const mode of ["missing-marker", "attempted", "unknown-binding"]) {
      const shape = structuredClone(occupied.intent); shape.operationId += "." + mode;
      if (mode === "missing-marker") delete shape.createAttempted;
      else if (mode === "attempted") shape.createAttempted = true;
      else shape.resourceBinding = {};
      const file = r.state("task-dispatch", shape.operationId + ".json");
      const bytes = JSON.stringify(shape); writeFileSync(file, bytes); uncertainFiles.push([file, bytes]);
    }
    await cli(live.owner.sessionId, ["task", "finish", live.taskId, "--outcome", "blocked", "Keep real paused writer and unknown preparations as unresolved work"]);
    r.ok(["tick"]);
    const after = (await r.snapshot(child.collaborator)).summary.inputSummary;
    t.assertions.assert(JSON.parse(readFileSync(occupied.file, "utf8")).state === "withdrawn"
      && uncertainFiles.every(([file, bytes]) => readFileSync(file, "utf8") === bytes), "known and unknown local preparations were not distinguished");
    t.assertions.assert(readFileSync(lease, "utf8") === leaseBytes && pause?.paused && after?.paused
      && JSON.stringify(after.pendingMessageIds) === JSON.stringify(pause.pendingMessageIds), "local fence changed another writer or lifted the real native pause");
    const retained = JSON.parse(readFileSync(r.state("tasks", live.taskId + ".json"), "utf8"));
    t.assertions.assert(retained.state === "active" && retained.finished.outcome === "blocked"
      && retained.finished.unresolvedWork.pending.some((x: any) => x.sessionId === child.collaborator),
      "fencing an uncreated support completed or canceled an actual unresolved worker");
  } finally { await r.dispose(); }
});

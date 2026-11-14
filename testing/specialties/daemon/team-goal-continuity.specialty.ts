import { existsSync, lutimesSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-goal-idle-continuity",
  title: "An active goal Owner still receives bounded idle reminders after its pending record retires",
  oracle: "A real Task stays open after a real native failed round and its failure notification retire. The native paused Owner receives no reminder; after explicit case continuation, one idle reminder reaches that Owner, and repeated lack of progress becomes one internal note without a watchdog message to the front.",
  catches: ["retired pending record stops active goal observation", "watchdog resumes a paused Owner", "idle goal warnings are sent to the front", "unchanged idle goal creates repeated warnings"],
  tags: ["core", "team-task"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py tick", "session.interrupt", "session.get"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 12000, timeoutMs: 90000,
}, async t => {
  const r = await openTeam(t, "goal-idle-continuity", [{ id: "ctl-goal-recover", profile: "exit-without-terminal", once: true }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_WATCHDOG_AFTER=999999\nTEAM_WATCHDOG_MAX_WAKES=1\nTEAM_WAKE_ROUNDS=999999\nTEAM_BOARD_PORT=0\n");
    const task = JSON.parse(r.ok(["task", "start", "--space", "leader", "--desc", "continuous goal", "--request-id", "goal-idle", "Continue the original goal until its actual acceptance"], { GENEHUB_SESSION_ID: r.front, TEAM_AGENT: "ctl-goal-recover" }));
    const owner = task.owner.sessionId as string;
    const idle = (sid: string) => t.tools.waitUntil(async () => { const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length; }, 20000);
    await t.tools.waitUntil(async () => (await r.snapshot(owner)).summary.inputSummary?.paused === true, 20000);
    await t.tools.waitUntil(async () => {
      r.ok(["tick"]); await idle(r.front); return !existsSync(r.state("pending", owner + ".json"));
    }, 20000).catch(error => { throw Error("pending retirement: " + String(error) + " " + JSON.stringify({pending: existsSync(r.state("pending", owner + ".json")) ? JSON.parse(readFileSync(r.state("pending", owner + ".json"), "utf8")) : null})); });
    const ledger = () => JSON.parse(readFileSync(r.state("tasks", task.taskId + ".json"), "utf8"));
    t.assertions.assert(ledger().state === "active" && !ledger().finished, "native execution failure silently concluded the business goal");
    await r.client.call({ type: "session.interrupt", payload: { sessionId: owner } });
    const paused = (await r.snapshot(owner)).summary.inputSummary;
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_WATCHDOG_AFTER=1\n");
    await new Promise(resolve => setTimeout(resolve, 1200)); r.ok(["tick"]);
    t.assertions.assert((await r.snapshot(owner)).summary.inputSummary?.paused && !ledger().watchdog?.wakes,
      "goal reminder undid the native pause");
    await r.send(owner, "Continue this case-owned goal under its existing budget"); await idle(owner).catch(async error => { throw Error("explicit native continuation: " + String(error) + " " + JSON.stringify((await r.snapshot(owner)).summary.inputSummary)); });
    const notices = async (sid: string) => (await r.snapshot(sid)).items.filter(x => x.type === "userMessage"
      && x.text.startsWith("用途: watchdog\n") && x.text.includes(task.taskId));
    await t.tools.waitUntil(async () => { r.ok(["tick"]); await idle(owner); return (await notices(owner)).length === 1; }, 20000).catch(async error => { const s = (await r.snapshot(owner)).summary; throw Error("idle goal reminder: " + String(error) + " " + JSON.stringify({watchdog: ledger().watchdog, status: s.status, inputs: s.inputSummary, inbox: existsSync(r.state("inbox")) ? readdirSync(r.state("inbox")) : []})); });
    await new Promise(resolve => setTimeout(resolve, 1200)); r.ok(["tick"]); r.ok(["tick"]);
    const notes = readdirSync(r.state("notes")).filter(x => x.endsWith(".json"))
      .map(x => JSON.parse(readFileSync(r.state("notes", x), "utf8")))
      .filter(x => x.from === "system:task-watchdog" && x.context.includes(task.taskId));
    t.assertions.assert(notes.length === 1 && (await notices(r.front)).length === 0 && (await notices(owner)).length === 1,
      "idle goal warning was missing, repeated or delivered to the front");
    t.assertions.assert(paused?.paused && ledger().state === "active" && !ledger().finished, "watchdog altered the business conclusion");
  } finally { await r.dispose(); }
});

defineSpecialty({
  id: "specialty.daemon.team-goal-evidence-temp-protection",
  title: "Automatic temp cleanup preserves files referenced by goal summaries and evidence",
  oracle: "Real case-owned old temp files referenced by an absolute path, a root-relative path and a relative evidence link survive public temp clean, while an equally old unreferenced directory is removed. No active creator record is needed to protect completed evidence.",
  catches: ["completed evidence deleted after its Task settles", "relative evidence links ignored", "reference protection disables unrelated cleanup"],
  tags: ["core", "team-task", "expert-files"], llm: { default: "none" },
  productInterfaces: ["tools/run.py temp", "filesystem"], surfaces: ["daemon", "team-template", "filesystem"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 1, memoryMb: 1024, browser: 0 }, expectedDurationMs: 4000, timeoutMs: 45000,
}, async t => {
  const r = await openTeam(t, "goal-evidence-temp");
  try {
    const iteration = join(r.root, "datas/goals/goal-a/iterations/one");
    mkdirSync(join(iteration, "evidence"), { recursive: true });
    const old = new Date(Date.now() - 10 * 86400000);
    for (const name of ["absolute", "root-relative", "evidence-relative", "unreferenced"]) {
      const dir = join(r.root, "temp", name); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "proof.txt"), name); utimesSync(join(dir, "proof.txt"), old, old); utimesSync(dir, old, old);
    }
    const spaced = join(r.root, "temp/quoted proof.txt"); writeFileSync(spaced, "quoted path"); utimesSync(spaced, old, old);
    const original = join(iteration, "evidence/original.txt"), alias = join(r.root, "temp/linked-proof");
    writeFileSync(original, "evidence outside temp"); symlinkSync(original, alias); lutimesSync(alias, old, old);
    // Evidence payloads are not reference metadata and must not exhaust its read bound.
    writeFileSync(join(iteration, "evidence/capture.png"), Buffer.alloc(9 * 1024 * 1024, 0));
    writeFileSync(join(iteration, "summary.md"), `[native proof](${join(r.root, "temp/absolute/proof.txt")})\n\`temp/root-relative/proof.txt\`\n[quoted](<temp/quoted proof.txt>)\n[linked proof](temp/linked-proof)\n`);
    writeFileSync(join(iteration, "evidence/refs.md"), "[retained source](../../../../../../temp/evidence-relative/proof.txt)\n");
    r.ok(["temp", "clean", "--older-than", "7d", "--dry-run"]);
    t.assertions.assert(existsSync(join(r.root, "temp/unreferenced/proof.txt")), "dry run removed a file");
    r.ok(["temp", "clean", "--older-than", "7d"]);
    for (const name of ["absolute", "root-relative", "evidence-relative"])
      t.assertions.assert(existsSync(join(r.root, "temp", name, "proof.txt")), "referenced evidence was deleted: " + name);
    t.assertions.assert(existsSync(spaced) && !existsSync(join(r.root, "temp/unreferenced")), "quoted evidence was deleted or unreferenced expired material was kept");
    t.assertions.assert(existsSync(alias) && readFileSync(original, "utf8") === "evidence outside temp", "referenced symlink was deleted or its external target changed");
    const uncertain = join(r.root, "temp/uncertain.txt"); writeFileSync(uncertain, "retain on unreadable summary"); utimesSync(uncertain, old, old);
    writeFileSync(join(iteration, "summary.md"), Buffer.from("broken summary\0"));
    const refused = r.command(["temp", "clean", "--older-than", "7d"]);
    t.assertions.assert(refused.code !== 0 && existsSync(uncertain) && existsSync(spaced), "malformed reference text became proof of no references");
  } finally { await r.dispose(); }
});

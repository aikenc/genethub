import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-native-horizon",
  title: "Legacy stored epochs cannot shorten rolling24h capture or continuing Task native history",
  oracle: "Real SDK Task and three genuine Owner rounds straddle a labelled case-owned measurement epoch. A transparent native CLI forwarder requests one-row round pages without changing responses. Diagnostic collection must preserve the original activation and earliest Task work despite the later metric horizon; actual native timestamps, pause, receipts and source ledgers remain unchanged.",
  catches: ["rolling metric cutoff hides an active Task's first native Round", "new measurement epoch loses ongoing Task work", "readable native history is silently truncated", "history cache certifies an unobserved earlier range"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py quality facts", "session.rounds", "session.inspect"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "native-horizon", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const front = await r.create("ctl-cli-command");
    await r.send(front, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "task", "start", "--space", "leader", "--desc", "continuing Task", "--request-id", "horizon.goal", "Continue a genuine task across a measurement boundary"], cwd: r.root, requestId: "horizon.start" }));
    await idle(front);
    const reply = (await r.snapshot(front)).items.filter(x => x.type === "assistantMessage" && x.text.includes('"horizon.start"')).at(-1);
    if (reply?.type !== "assistantMessage") throw Error("actual Task receipt missing");
    const receipt = JSON.parse(reply.text); t.assertions.assert(receipt.code === 0, receipt.err);
    const task = JSON.parse(receipt.out.trim().split("\n").at(-1)!);
    const owner = task.owner.sessionId as string; await idle(owner);
    const firstReply = await runGenetAsync(r.daemon.genet, ["session", "rounds", owner, "--limit", "100"], r.env);
    t.assertions.assert(firstReply.code === 0, firstReply.stderr);
    const initial = JSON.parse(firstReply.stdout).data.page.rounds;
    const activation = initial.reduce((a: any, b: any) => a.startedAtMs < b.startedAtMs ? a : b);
    await r.send(owner, "A second genuine round before the measurement boundary"); await idle(owner);
    const epoch = Date.now();
    await r.send(owner, "A third genuine round after the measurement boundary"); await idle(owner);
    // Observational fixture only: this shortens the metric horizon to expose
    // pagination without waiting 24 hours. It is no production repair claim.
    const state = r.state("quality", "redline-state.json"); mkdirSync(join(r.root, ".genethub/team/quality"), { recursive: true });
    writeFileSync(state, JSON.stringify({ schema: "team-quality-redline-state/1", startedAtMs: epoch, incidents: {}, hours: {},
      measurementEpochs: [{ id: "case-owned-shortened-epoch", atMs: epoch, closedIncidentIds: [] }],
      fixture: "case-owned metric boundary; all Session histories and timestamps remain native; no official quality claim" }));
    const log = join(t.env.root, "native-page-calls.jsonl"), proxy = join(t.env.root, "forward-one-round-page.py");
    writeFileSync(log, "");
    writeFileSync(proxy, `#!${process.env.GENEHUB_PYTHON}\nimport os,sys,json\na=sys.argv[1:]\nif a[:2]==['session','rounds'] and '--limit' in a:a[a.index('--limit')+1]='1'\nwith open(${JSON.stringify(log)},'a') as f:f.write(json.dumps(a)+'\\n')\nos.execv(${JSON.stringify(r.daemon.genet)},[${JSON.stringify(r.daemon.genet)}]+a)\n`); chmodSync(proxy, 0o700);
    const facts = JSON.parse(r.ok(["quality", "facts"], { GENEHUB_CLI: proxy }));
    t.assertions.assert(facts.captureKind === "diagnostic" && facts.measurementWindow.startAtMs === facts.window.endAtMs - 24*3600000 && facts.issues.length === 0,
      "measurement fixture became an official card or native collection failed");
    const work = facts.workItems.find((x: any) => x.taskId === task.taskId && x.sessionId === owner);
    const tree = facts.taskTrees.find((x: any) => x.taskId === task.taskId);
    const member = tree?.sessions.find((x: any) => x.sessionId === owner);
    t.assertions.assert(work?.startedAtMs === activation.startedAtMs && member?.readable === true
      && member.runs.some((x: any) => x.startAtMs <= activation.startedAtMs && x.endAtMs >= activation.endedAtMs),
      "continuing Task lost its original native activation or pre-epoch work at the metric cutoff");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(x => JSON.parse(x) as string[]);
    t.assertions.assert(calls.filter(x => x[0] === "session" && x[1] === "rounds" && x[2] === owner).length >= 3,
      "collector did not follow actual bounded native pages through the Task activation");
    const native = JSON.parse(readFileSync(r.state("quality", "native", owner + ".json"), "utf8"));
    t.assertions.assert(native.rounds.some((x: any) => x.roundId === activation.roundId), "native activation proof missing from persisted cache");
    t.note("Real native Task/rounds and transparent pagination; only isolated metric epoch is a labelled fixture, no old timestamp/card or live Team mutation.");
  } finally { await r.dispose(); }
});

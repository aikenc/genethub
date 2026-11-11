import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-resource-obligation",
  title: "Native persistent Agent processes do not manufacture a resource lease",
  oracle: "Two real task Owners have independently observed native processes: an unbound conclusion owes no resource, while an explicitly bound writer remains held. Separately labelled frozen eleven-minute facts preserve the R5 threshold and distinguish measurement versions.",
  catches: ["Agent runtime mistaken for a lease", "real bound writer released while processes live", "fixed measurement stitched to old cards", "unknown measurement silently scored"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py task", "tools/run.py quality facts", "tools/run.py quality card", "process.list"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 15000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "resource-obligation", [
    { id: "ctl-resource-unbound", profile: "cli-command", processTree: true, tool: "runtime-tree" },
    { id: "ctl-resource-bound", profile: "cli-command", processTree: true, tool: "runtime-tree" },
    { id: "ctl-cli-command", profile: "cli-command" },
  ]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8")+"\nTEAM_AGENT=ctl-resource-runtime\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WATCHDOG_AFTER=999999\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    let sequence = 0;
    const cli = async (sid: string, args: string[]) => {
      const requestId = "resource-obligation."+(++sequence);
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root, requestId }));
      await idle(sid);
      const m = (await r.snapshot(sid)).items.filter(x => {
        if (x.type !== "assistantMessage") return false;
        try { return JSON.parse(x.text).requestId === requestId; } catch { return false; }
      }).at(-1);
      if (m?.type !== "assistantMessage") throw new Error("native Agent command outcome missing");
      const v = JSON.parse(m.text);
      t.assertions.assert(v.code === 0, v.out+v.err);
      return JSON.parse(v.out.trim().split("\n").at(-1)!);
    };
    const front = await r.create("ctl-cli-command");
    const tasks: any[] = [];
    for (const kind of ["unbound", "bound"]) {
      writeFileSync(config, readFileSync(config, "utf8")+"\nTEAM_AGENT=ctl-resource-"+kind+"\n");
      const task = await cli(front, ["task", "start", "--space", "leader", "--desc", kind+" resource observation", "--request-id", "resource."+kind, "Conclude a bounded observation"]);
      const owner = task.owner.sessionId as string;
      await idle(owner);
      t.assertions.assert((await r.snapshot(owner)).summary.agentId === "ctl-resource-"+kind, "task Owner did not inherit actual persistent-runtime Agent");
      await t.tools.waitUntil(async () => {
        const p = await r.client.call({ type: "process.list" });
        return p?.type === "processes" && p.data.some(x => x.sessionId === owner);
      }, 10000);
      if (kind === "bound") {
        const directory = join(r.root, "actual-writer"); mkdirSync(directory);
        await cli(owner, ["task", "bind-directory", task.taskId, "--directory", directory]);
      }
      await cli(owner, ["task", "finish", task.taskId, "--outcome", "success", "Bounded observation complete"]);
      r.ok(["hook"]);
      tasks.push(task);
    }
    const inventory = await r.client.call({ type: "process.list" });
    if (inventory?.type !== "processes") throw new Error("native process inventory missing");
    t.assertions.assert(tasks.every(task => inventory.data.some(x => x.sessionId === task.owner.sessionId)), "persistent process fault subject did not remain alive");
    const facts = JSON.parse(r.ok(["quality", "facts"]));
    const unbound = facts.workItems.find((x: any) => x.taskId === tasks[0].taskId && x.owner);
    const bound = facts.workItems.find((x: any) => x.taskId === tasks[1].taskId && x.owner);
    t.assertions.assert(unbound?.resourceRequired === false && unbound.resourceHeld !== true, "a process invented a resource obligation for an unbound concluded task");
    t.assertions.assert(bound?.resourceRequired === true && bound.resourceHeld === true && !bound.releasedAtMs, "an actual bound writer with native live processes was falsely released");
    const file = join(r.root, "external-frozen-resource-facts.json");
    const freeze = (item: any) => {
      const v = structuredClone(facts), end = v.window.endAtMs;
      v.workItems = [{ ...item, dispatchAtMs: end-20*60000, confirmedAtMs: end-20*60000+1, startedAtMs: end-19*60000,
        conclusionAtMs: end-11*60000, deliveredAtMs: end-10*60000, consumedAtMs: end-9*60000 }];
      v.coverage.resources = true; delete v.workItems[0].releasedAtMs;
      v.captureKind = "external-frozen-boundary";
      return v;
    };
    const card = (v: any) => { writeFileSync(file, JSON.stringify(v)); return JSON.parse(r.ok(["quality", "card", "--snapshot", file])); };
    const freeCard = card(freeze(unbound)), heldCard = card(freeze(bound));
    t.assertions.assert(freeCard.officialCapture === false && freeCard.redLines.R5.triggered === false && heldCard.redLines.R5.triggered === true, "eleven-minute external boundary weakened R5 or charged an unbound runtime");
    t.assertions.assert(facts.resourceObligationBasis === "dispatch-resource-obligation/2" && freeCard.measurementVersion === "tq/2+dispatch-resource-obligation/2+per-source-failure-domain/1" && freeCard.streakCompatibilityKey === freeCard.measurementVersion, "measurement version or streak boundary missing");
    const resourceOnly = freeze(unbound); delete resourceOnly.evidenceCoverageBasis;
    t.assertions.assert(card(resourceOnly).measurementVersion === "tq/2+dispatch-resource-obligation/2", "previous resource-only measurement was retagged");
    const old = freeze(unbound); delete old.resourceObligationBasis; delete old.evidenceCoverageBasis;
    const oldCard = card(old);
    t.assertions.assert(oldCard.streakCompatibilityKey === "tq/2" && !oldCard.measurementVersion, "historical facts were silently retagged");
    old.resourceObligationBasis = "unknown-resource-basis"; writeFileSync(file, JSON.stringify(old));
    t.assertions.assert(r.command(["quality", "card", "--snapshot", file]).code !== 0, "unknown basis silently scored");
    t.note("Real public task/native process observations; separately labelled frozen threshold algebra. No live Team ledger mutation, process signalling, formal card or goal-completion claim.");
  } finally { await r.dispose(); }
});

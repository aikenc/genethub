import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-reflection-brief",
  title: "Reflection needs a real signal, reads a bounded brief and leaves uncommitted user work alone",
  oracle: "Real read-only native Agent rounds do not cause a timer patrol even with legacy round thresholds set to one. Public urgent notes still start native reflection; its actual briefing stays below5000characters with original note IDs, and starting reflection cannot commit the user's pending memory edit. Explicit reflection remains available without signals.",
  catches: ["completed read-only rounds create an empty patrol", "large notes generate an unbounded reflection brief", "urgent feedback no longer wakes reflection", "reflection snapshots unrelated user work", "explicit reflection is disabled by quiet gating"],
  tags: ["core", "team-reflect"], llm: { default: "none" },
  productInterfaces: ["tools/run.py note", "tools/run.py notes done", "tools/run.py reflect", "tools/run.py tick", "session.get", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 20000, timeoutMs: 120000,
}, async t => {
  const r = await openTeam(t, "bounded-reflection", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  const git = (...args: string[]) => {
    const v = spawnSync("git", ["-C", r.root, ...args], { encoding: "utf8", timeout: 10000 });
    t.assertions.assert(v.status === 0, v.stderr); return v.stdout.trim();
  };
  try {
    const env = join(r.root, ".genethub/open.env");
    writeFileSync(env, readFileSync(env, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_MODE=1\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=1\nTEAM_WAKE_CHECK=0\nTEAM_WAKE_GAP=0\n");
    r.ok(["snapshot"]);
    const front = await r.create("ctl-cli-command");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 20000);
    for (let n = 0; n < 3; n++) {
      await r.send(front, JSON.stringify({ requestId: "read-only." + n, cwd: r.root,
        argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "path", "root"] }));
      await idle(front);
    }
    r.ok(["tick"]);
    t.assertions.assert(!existsSync(r.state("reflect.json")), "read-only rounds triggered a reflection patrol without a real signal");
    const beforeHead = git("rev-parse", "HEAD"), memory = join(r.root, "memory.md");
    const pending = readFileSync(memory, "utf8") + "\nUser's unfinished definition edit; preserve without committing.\n";
    writeFileSync(memory, pending);
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) {
      const answer = r.ok(["note", "--kind", "anomaly", "--session", front, "--quote", "case-owned feedback " + n,
        "--context", "Case-owned bounded feedback detail. ".repeat(180), "Urgent case feedback " + n]);
      const id = answer.match(/\bn[0-9a-f]{12}\b/)?.[0]; if (!id) throw Error("public note identity missing"); ids.push(id);
    }
    r.ok(["tick"]);
    const reflect = JSON.parse(readFileSync(r.state("reflect.json"), "utf8")); await idle(reflect.sessionId);
    const files = readdirSync(r.state("briefings")).filter(x => x.endsWith(".md"));
    const brief = readFileSync(r.state("briefings", files.sort().at(-1)!), "utf8");
    t.assertions.assert([...brief].length <= 5000 && ids.every(id => brief.includes(id)), "brief exceeded5000characters or lost original note identities");
    t.assertions.assert((await r.snapshot(reflect.sessionId)).items.some(x => x.type === "userMessage" && x.text.includes("反思")), "urgent notes did not reach a real native reflection");
    t.assertions.assert(git("rev-parse", "HEAD") === beforeHead && readFileSync(memory, "utf8") === pending
      && git("status", "--porcelain").includes("memory.md"), "starting reflection committed or changed unrelated user work");
    for (const id of ids) r.ok(["notes", "done", id, "--result", "No source action required in this isolated fixture"]);
    r.ok(["reflect", "now", "Inspect this explicit request without a routine signal"]);
    const explicit = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
    t.assertions.assert(explicit.sessionId !== reflect.sessionId && git("rev-parse", "HEAD") === beforeHead,
      "explicit request did not start independently or caused an actionless source commit");
  } finally { await r.dispose(); }
});

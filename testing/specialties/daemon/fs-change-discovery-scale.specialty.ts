import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { daemonEndpoint, defineSpecialty, openTeam, parseJson, runGenet } from "../../framework/public.ts";

const PROJECTS = 450, SESSIONS = 2500, QUIET_MS = 20_000, SLOW_TASKS = 8;
// Two core-seconds per 20s quiet window (10%): unchanged files are only looked
// at on their cadence. A daemon that re-reads every session, descriptor and
// hook directory on each background pass spends well over this.
const QUIET_CPU_SECONDS = 2.0;

defineSpecialty({
  id: "specialty.daemon.fs-change-discovery.scale-steady-state",
  title: "Hundreds of projects and thousands of sessions cost nothing while unchanged, and edits still appear",
  oracle: `With ${PROJECTS} registered projects, ${SESSIONS} on-disk sessions and a team with ${SLOW_TASKS + 1} tasks, the daemon process spends at most ${QUIET_CPU_SECONDS} CPU-second in a ${QUIET_MS / 1000}s quiet window and from then on logs no slow catalog or discovery pass; one team timer tick reads sessions with one incremental call per machine instead of one summary call per task, and still retires the finished task; session list --since returns nothing when quiet and exactly the renamed session after a rename; an external atomic replace and a new external session are visible to a scoped read at once and to an unscoped read within the 30s cold period`,
  catches: ["background passes re-read every unchanged file", "timer tick reads every project's hook directory", "team tick issues one session read per pending task", "incremental reads miss own writes", "cursor returns unchanged sessions", "external edits never reach an unscoped view", "scoped reads serve a stale index"],
  tags: ["core", "scale", "fs-change-discovery"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["workspace.open", "session.create", "session.rename", "session list --since", "session.page", "tools/team.py hook", "meta.json on disk"],
  surfaces: ["daemon", "tools/team.py", "genet-cli", "filesystem"],
  expectedDurationMs: 180_000, timeoutMs: 480_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0 },
}, async t => {
  const r = await openTeam(t, "scale-team", [{ id: "ctl-slow", profile: "normal", delayMs: 180_000, chunks: 2 }]);
  try {
    const config = path.join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=9999\nTEAM_PLATFORM_CHECK=99999\n");
    const call = async (request: Parameters<typeof r.client.call>[0]) => {
      const reply = await r.client.call(request);
      if (!reply || (reply as { type?: string }).type === "error") throw new Error(`${request.type}: ${JSON.stringify(reply).slice(0, 300)}`);
      return reply as { type: string; data: any };
    };
    const projects: Array<{ id: string; root: string }> = [];
    for (let n = 0; n < PROJECTS; n++) {
      const root = path.join(t.env.workspace, "projects", `p${String(n).padStart(3, "0")}`);
      mkdirSync(root, { recursive: true });
      projects.push({ id: (await call({ type: "workspace.open", payload: { root } })).data.id, root });
    }
    const created = await call({ type: "session.create", payload: { workspaceId: projects[0]!.id, agentId: "ctl-normal", modelId: null, modeId: null, title: "seed", cwd: null } });
    const example = JSON.parse(readFileSync(path.join(projects[0]!.root, ".genethub/sessions", created.data.id, "meta.json"), "utf8"));
    // Another writer of the same on-disk format: files are replaced atomically,
    // as the daemon itself writes them, and never through the daemon.
    const writeElsewhere = (project: { id: string; root: string }, id: string, title: string, updatedAtMs = Date.now() - 3_600_000) => {
      const dir = path.join(project.root, ".genethub/sessions", id);
      mkdirSync(dir, { recursive: true });
      const temporary = path.join(dir, ".meta.json.external.tmp");
      writeFileSync(temporary, JSON.stringify({ ...example, id, workspaceId: project.id, title, titleLocked: true, updatedAtMs, createdAtMs: updatedAtMs }));
      renameSync(temporary, path.join(dir, "meta.json"));
    };
    for (let n = 0; n < SESSIONS; n++) writeElsewhere(projects[n % PROJECTS]!, `s_scale${String(n).padStart(8, "0")}`, `history ${n}`);
    // A project just opened or written to stays hot for a minute; the quiet
    // window starts once that has passed for all of them.
    const settledAt = Date.now() + 65_000;

    const send = (desc: string, agent: string) => /s_[0-9a-f]+/.exec(r.ok(["spawn", "--kind", "research", "--desc", desc, "--model", "fixture", desc],
      { TEAM_AGENT: agent, GENEHUB_SESSION_ID: r.front }))![0];
    const slow = Array.from({ length: SLOW_TASKS }, (_, n) => send(`slow ${n}`, "ctl-slow"));
    const fast = send("fast result", "ctl-normal");
    await t.tools.waitUntil(async () => (await r.snapshot(fast)).summary.status === "idle", 60_000);
    for (const id of slow) t.assertions.assert((await r.snapshot(id)).summary.status === "running", `slow task ${id} is not running`);

    const pid = daemonEndpoint(r.daemon).localServerProof.pid;
    const cpu = () => {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      return (Number(fields[11]) + Number(fields[12])) / 100;
    };
    await new Promise(resolve => setTimeout(resolve, Math.max(8_000, settledAt - Date.now())));
    const log = path.join(t.env.data, "logs/daemon.log");
    const logged = () => existsSync(log) ? readFileSync(log, "utf8") : "";
    const steadyFrom = logged().length;
    const before = cpu();
    await new Promise(resolve => setTimeout(resolve, QUIET_MS));
    const spent = cpu() - before;
    t.note(JSON.stringify({ quiet: { cpuSeconds: Number(spent.toFixed(2)), windowMs: QUIET_MS } }));
    t.assertions.assert(spent <= QUIET_CPU_SECONDS, `the daemon spent ${spent.toFixed(2)} CPU-seconds while nothing changed`);

    // A recording front door: the real CLI, with each invocation's words kept.
    const record = path.join(t.env.root, "genet-calls.log"), recorder = path.join(t.env.root, "genet-recorder.sh");
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\nexec "${r.daemon.genet}" "$@"\n`);
    chmodSync(recorder, 0o755);
    const tick = () => {
      writeFileSync(record, "");
      r.ok(["hook"], { GENEHUB_CLI: recorder, TEAM_STUCK_AFTER: "3600", TEAM_BATCH_STUCK_AFTER: "3600" });
      return readFileSync(record, "utf8").split("\n").filter(Boolean);
    };
    tick();
    const calls = tick();
    const summaries = calls.filter(line => line.startsWith("session get")).length;
    const syncs = calls.filter(line => line.startsWith("session list") && line.includes("--since")).length;
    t.note(JSON.stringify({ tick: { calls: calls.length, summaries, syncs } }));
    t.assertions.assert(syncs >= 1 && summaries <= 1, `a tick read sessions one task at a time: ${summaries} summary reads, ${syncs} incremental reads`);
    t.assertions.assert(!existsSync(r.state("pending", `${fast}.json`)) && existsSync(r.state("done", `${fast}.json`)), "the finished task was not retired from synced rows");
    for (const id of slow) t.assertions.assert(existsSync(r.state("pending", `${id}.json`)), `running task ${id} was retired`);

    const cli = (args: string[]) => {
      const done = runGenet(r.daemon.genet, args, r.env);
      t.assertions.assert(done.code === 0, `genet ${args.slice(0, 3).join(" ")}: ${done.stdout.slice(-300)} ${done.stderr.slice(-300)}`);
      return (parseJson(done.stdout) as { data: any }).data;
    };
    const scope = projects.slice(0, 3).flatMap(p => ["--workspace", p.id]);
    let changes = cli(["session", "list", ...scope, "--since", "start"]);
    while (!changes.complete) changes = cli(["session", "list", ...scope, "--since", changes.cursor]);
    const quiet = cli(["session", "list", ...scope, "--since", changes.cursor]);
    t.assertions.assert(quiet.sessions.length === 0 && quiet.removed.length === 0 && quiet.reset === false, `a quiet cursor returned rows: ${JSON.stringify(quiet).slice(0, 300)}`);
    await call({ type: "session.rename", payload: { sessionId: created.data.id, title: "renamed while synced" } });
    const renamed = cli(["session", "list", ...scope, "--since", quiet.cursor]);
    t.assertions.assert(renamed.sessions.length === 1 && renamed.sessions[0].id === created.data.id && renamed.sessions[0].title === "renamed while synced",
      `the cursor did not return exactly the renamed session: ${JSON.stringify(renamed.sessions.map((s: { id: string }) => s.id))}`);

    const page = async (workspaceId: string | null) => {
      const reply = await call({ type: "session.page", payload: { requests: [{ workspaceId, limit: 100, cursor: null }], includeArchived: false } });
      return reply.data[0].sessions as Array<{ id: string; title: string | null }>;
    };
    const target = projects[7]!, edited = "s_scale00000007";
    writeElsewhere(target, edited, "edited elsewhere", Date.now());
    writeElsewhere(target, "s_scaleexternal01", "created elsewhere", Date.now());
    const scoped = await page(target.id);
    t.assertions.assert(scoped.find(s => s.id === edited)?.title === "edited elsewhere" && scoped.some(s => s.id === "s_scaleexternal01"),
      "a scoped read served the index instead of validating its own project");
    // A project nobody reads by scope: only the background sweep can find it.
    writeElsewhere(projects[9]!, "s_scaleexternal02", "seen without a scoped read", Date.now());
    const began = Date.now();
    await t.tools.waitUntil(async () => (await page(null)).some(s => s.id === "s_scaleexternal02"), 40_000);
    t.note(JSON.stringify({ unscopedVisibleMs: Date.now() - began }));

    // Reading the imported history once is real work; from then on nothing may be slow.
    const slowPasses = logged().slice(steadyFrom).split("\n").filter(line => /session_catalog_slow|workspace_discovery_slow/.test(line));
    t.assertions.assert(slowPasses.length === 0, `slow background passes: ${slowPasses.slice(-2).join(" | ").slice(0, 400)}`);
    t.note(`${PROJECTS} projects, ${SESSIONS} sessions: quiet CPU ${spent.toFixed(2)}s, tick ${summaries} summary + ${syncs} incremental reads, scoped edits immediate`);
  } finally { await r.dispose(); }
});

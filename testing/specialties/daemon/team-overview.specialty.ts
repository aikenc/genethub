import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-overview",
  title: "A 35-role Team separates current work from bounded scoped progress history",
  oracle: "One active snapshot retains all 35 native roles without expanding the two completed Agent conversations; progress uses explicitly bounded Team Space pages, counts one business round and excludes reflection; malformed responses preserve the prior status.",
  catches: ["board refresh queries every role", "progress uses unbounded machine-wide history", "reflection counts as business progress", "malformed overview erases last good status"],
  tags: ["core", "expert", "performance"], llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/team.py board refresh", "tools/team.py hook", "genet session list --lean", "genet session send"],
  surfaces: ["team-template", "daemon", "genet-cli", "filesystem"], expectedDurationMs: 20_000, timeoutMs: 180_000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const python = process.env.GENEHUB_PYTHON!, root = join(t.env.root, "overview-team");
  const cli = async (args: string[]) => {
    const p = await runGenetAsync(o.daemon.genet, args, o.daemon.env);
    if (p.code !== 0) throw new Error(p.stderr);
    return (parseJson(p.stdout) as { data: any }).data;
  };
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools/team.py"), readFileSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/team.py")));
      writeFileSync(join(root, "tools", "team_tasks.py"), readFileSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/team_tasks.py")));
      cpSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/genet_builtin"), join(root, "tools/genet_builtin"), { recursive: true });
    rmSync(join(root, "tools/genet_builtin/board.py"));
    // A legitimate customized Team without identity or board-server modules:
    // isolate the Markdown overview and native hook's progress decision.
    const manifest = (name: string) => ({ schema: "agent-space.v1", name, tags: ["team"], agents: ["genet"], skills: [], skillProviders: [], folders: [{ path: "." }], children: { scanDepth: 2 } });
    writeFileSync(join(root, "agent-space.genet.json"), JSON.stringify(manifest("overview-team")));
    for (const role of ["leader", "reflect", ...Array.from({ length: 32 }, (_, i) => `work${i}`)]) {
      const dir = join(root, "spaces", role); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agent-space.genet.json"), JSON.stringify(manifest(role)));
    }
    mkdirSync(join(root, ".genethub/team"), { recursive: true });
    writeFileSync(join(root, ".genethub/open.env"), "TEAM_MODE=1\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=100000\nTEAM_WAKE_GAP=0\nTEAM_WAKE_CHECK=0\n");
    const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    t.assertions.assert(initialized.status === 0, initialized.stderr);
    // Restored owned project state: its platform was just checked. No upgrade
    // or automatic reflection should distract from counting actual progress.
    writeFileSync(join(root, ".genethub/team/platform-check.json"), JSON.stringify({ atMs: Date.now() }));
    await t.flows.main.configureMockProvider(o.client, o.mock);
    await cli(["space", "open", root]);
    const spaces = (await cli(["workspace", "list"])).workspaces;
    const create = async (role: string) => {
      const w = spaces.find((w: any) => w.root === join(root, "spaces", role));
      t.assertions.assert(w, `Native ${role} workspace absent`);
      return t.flows.main.createBuiltinSession(o.client, w.id);
    };
    const business = await create("leader"), reflection = await create("reflect");
    o.mock.script({ text: "Completed native round", repeat: 2 });
    for (const sid of [business, reflection]) {
      await cli(["session", "send", sid, "Complete one bounded check"]);
      await t.tools.waitUntil(async () => {
        const s = (await cli(["session", "inspect", sid])).inspection.summary;
        return s.status === "idle" && !!s.latestReply;
      }, 15_000);
    }
    const calls = join(t.env.root, "overview-calls.jsonl"), mode = join(t.env.root, "overview-mode"), recorder = join(t.env.root, "overview-cli");
    writeFileSync(mode, "normal");
    writeFileSync(recorder, `#!${python}
import json,pathlib,subprocess,sys
with pathlib.Path(${JSON.stringify(calls)}).open('a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
r=subprocess.run([${JSON.stringify(o.daemon.genet)},*sys.argv[1:]],capture_output=True,text=True)
out=r.stdout
if sys.argv[1:3]==['session','list'] and r.returncode==0 and pathlib.Path(${JSON.stringify(mode)}).read_text()!='normal':
 d=json.loads(out.strip().splitlines()[-1]);d['data'].pop('sessions',None);out=json.dumps(d)+'\\n'
sys.stdout.write(out);sys.stderr.write(r.stderr);sys.exit(r.returncode)
`, { mode: 0o755 });
    const command = (...args: string[]) => {
      writeFileSync(calls, "");
      return spawnSync(python, [join(root, "tools/team.py"), ...args], { cwd: root, env: { ...o.daemon.env, GENEHUB_CLI: recorder }, encoding: "utf8", timeout: 100_000, maxBuffer: 4 * 1024 * 1024 });
    };
    const listQueries = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s) as string[]).filter(a => a[0] === "session" && a[1] === "list");
    const board = command("board", "refresh");
    t.assertions.assert(board.status === 0, board.stderr);
    const status = join(root, ".pm/trunk/status-live.md"), before = readFileSync(status, "utf8");
    const roles = ["root", "leader", "reflect", ...Array.from({ length: 32 }, (_, n) => `work${n}`)];
    t.assertions.assert(roles.every(role => before.includes(`**${role}**`)), "Native membership was lost from the 35-role overview");
    t.assertions.assert(!before.includes(business) && !before.includes(reflection), "Current-work overview expanded completed history");
    let queries = listQueries();
    t.assertions.assert(queries.length === 1 && queries[0]!.includes("--lean") && queries[0]!.includes("--active"), `Board query amplification: ${JSON.stringify(queries)}`);
    const modelRequestsBeforeHook = o.mock.requests.length;
    const hook = command("hook"); t.assertions.assert(hook.status === 0, hook.stderr);
    const progress = JSON.parse(readFileSync(join(root, ".genethub/team/reflect.json"), "utf8"));
    t.assertions.assert(progress.seen.rounds === 1, `Reflection counted as business progress: ${JSON.stringify(progress.seen)}`);
    queries = listQueries();
    const scopes = new Set(spaces.filter((w: any) => w.root === root || w.root.startsWith(join(root, "spaces") + "/")).map((w: any) => w.id));
    const history = queries.filter(a => !a.includes("--active"));
    t.assertions.assert(queries.filter(a => a.includes("--active")).length <= 1 && queries.length <= scopes.size + 1
      && history.every(a => scopes.has(a[a.indexOf("--workspace") + 1]) && a.includes("--limit")
        && Number(a[a.indexOf("--limit") + 1]) > 0 && Number(a[a.indexOf("--limit") + 1]) <= 500),
      `Hook used unbounded or unrelated history: ${JSON.stringify(queries)}`);
    t.assertions.assert(o.mock.requests.length === modelRequestsBeforeHook, "Hook unexpectedly started automatic model work");
    writeFileSync(mode, "missing-sessions");
    command("board", "refresh");
    t.assertions.assert(readFileSync(status, "utf8") === before, "Malformed snapshot replaced last good status with partial or empty data");
    t.note(JSON.stringify({ roles: scopes.size, activeBoardQueries: 1, hookQueries: queries.length, boundedHistoryPages: history.length, businessRounds: progress.seen.rounds, additionalModelWork: 0, malformedPreservedLastGood: true }));
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

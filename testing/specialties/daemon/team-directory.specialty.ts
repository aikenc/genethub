import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-directory",
  title: "A Team directory groups real sessions with one lean snapshot instead of querying every role",
  oracle: "Two actual Team workspaces retain their native leader sessions and --team filtering; the shipped tool makes one lean session-list invocation regardless of role count. Invalid public CLI response shapes fail instead of reporting an empty directory.",
  catches: ["per-role CLI amplification blocks the front", "sessions grouped under another Team", "filter drops an existing leader", "an uncertain list becomes no sessions"],
  tags: ["core", "expert", "performance"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/team.py directory", "genet session list --lean", "session.create"],
  surfaces: ["team-template", "daemon", "genet-cli"], expectedDurationMs: 20_000, timeoutMs: 180_000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const python = process.env.GENEHUB_PYTHON!;
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const teams: Array<{ root: string; name: string; session: string }> = [];
    for (const name of ["directory-alpha", "directory-beta"]) {
      const root = join(t.env.root, "spaces", name);
      mkdirSync(join(root, "spaces", "leader"), { recursive: true });
      mkdirSync(join(root, "tools"));
      writeFileSync(join(root, "tools", "team.py"), readFileSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/team.py")));
      writeFileSync(join(root, "agent-space.genet.json"), JSON.stringify({ schema: "agent-space.v1", name, tags: ["team"], children: ["spaces/leader"], folders: [{ path: "." }] }));
      writeFileSync(join(root, "spaces", "leader", "agent-space.genet.json"), JSON.stringify({ schema: "agent-space.v1", name: "leader", folders: [{ path: "." }] }));
      const opened = await o.client.call({ type: "workspace.open", payload: { root } });
      t.assertions.assert(opened?.type === "workspace", "Team workspace did not open");
      const listed = await o.client.call({ type: "workspace.list" });
      if (listed?.type !== "workspaces") throw new Error("workspace.list did not return workspaces");
      const leader = listed.data.find(w => w.folders[0]?.root === join(root, "spaces", "leader"));
      t.assertions.assert(leader, "actual leader workspace missing");
      const session = await t.flows.main.createBuiltinSession(o.client, leader!.id);
      teams.push({ root, name, session });
    }
    // A transparent process-boundary recorder forwards every call to the real CLI.
    // Fault modes mutate only its public response envelope, after the real query.
    const calls = join(t.env.root, "directory-calls.jsonl"), mode = join(t.env.root, "response-mode");
    const recorder = join(t.env.root, "record-cli");
    writeFileSync(mode, "normal");
    writeFileSync(recorder, `#!${python}
import json,pathlib,subprocess,sys
with pathlib.Path(${JSON.stringify(calls)}).open('a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
r=subprocess.run([${JSON.stringify(o.daemon.genet)},*sys.argv[1:]],capture_output=True,text=True)
out=r.stdout
if sys.argv[1:3]==['session','list'] and r.returncode==0:
 m=pathlib.Path(${JSON.stringify(mode)}).read_text()
 if m!='normal':
  d=json.loads(out.strip().splitlines()[-1]);v=d['data']
  if m=='missing':v.pop('sessions',None)
  elif m=='wrong-scope':v['workspaceId']='w_other'
  elif m=='invalid-row':v['sessions']=[None]
  out=json.dumps(d)+'\\n'
sys.stdout.write(out);sys.stderr.write(r.stderr);sys.exit(r.returncode)
`, { mode: 0o755 });
    const command = (...args: string[]) => {
      writeFileSync(calls, "");
      return spawnSync(python, [join(teams[0]!.root, "tools", "team.py"), "directory", ...args], { cwd: teams[0]!.root, env: { ...o.daemon.env, GENEHUB_CLI: recorder }, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    };
    const all = command();
    t.assertions.assert(all.status === 0, `directory failed: ${all.stdout} ${all.stderr}`);
    for (const team of teams) t.assertions.assert(all.stdout.includes(`${team.name}/leader ${team.session}`), `native leader lost or grouped incorrectly: ${team.name}`);
    const invocations = readFileSync(calls, "utf8").trim().split("\n").map(s => JSON.parse(s) as string[]);
    const queries = invocations.filter(a => a[0] === "session" && a[1] === "list");
    t.assertions.assert(queries.length === 1 && queries[0]!.includes("--lean"), `directory amplified session queries: ${JSON.stringify(queries)}`);
    const filtered = command("--team", teams[0]!.name);
    t.assertions.assert(filtered.status === 0 && filtered.stdout.includes(teams[0]!.session) && !filtered.stdout.includes(teams[1]!.session), "--team filtering changed native session membership");
    for (const fault of ["missing", "wrong-scope", "invalid-row"]) {
      writeFileSync(mode, fault);
      const bad = command();
      t.assertions.assert(bad.status !== 0 && bad.stderr.includes("目录会话快照") && !bad.stdout.includes("没有团队") && !bad.stdout.includes(teams[0]!.session), `${fault} response was interpreted as a known directory: ${bad.stderr}`);
    }
    t.note("Two real leader sessions grouped; one public lean snapshot; three public envelope faults remain unknown.");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, openTeam, type CaseContext } from "../../framework/public.ts";
type Team = Awaited<ReturnType<typeof openTeam>>;
function fileCase(id: string, oracle: string, run: (t: CaseContext, r: Team) => Promise<void>) {
  defineSpecialty({ id: `specialty.daemon.${id}`, title: id, oracle, catches: [oracle], tags: ["core", "expert", "merge-remediation"],
    llm: { default: "none" }, expectedDurationMs: 20000, timeoutMs: 120000, surfaces: ["tools/team.py", "daemon", "git"],
  }, async t => { const r = await openTeam(t); try { await run(t, r); } finally { await r.dispose(); } });
}
const read = (r: Team, file: string) => readFileSync(path.join(r.root, file), "utf8");
function git(t: CaseContext, r: Team, ...args: string[]) {
  const result = spawnSync("git", ["-C", r.root, ...args], { env: r.env, encoding: "utf8" });
  t.assertions.assert(result.status === 0, `git ${args[0]}: ${result.stderr}`); return result.stdout.trim();
}
fileCase("expert-git-root", "snapshot tracks team sources on main/platform, excludes runtime and nested repositories, and drift distinguishes product changes from local additions", async (t, r) => {
  r.ok(["snapshot"]);
  t.assertions.assert(git(t, r, "branch", "--format=%(refname:short)").split("\n").sort().join() === "main,platform", "template snapshot branches missing");
  mkdirSync(path.join(r.root, "datas/nested"), { recursive: true }); writeFileSync(path.join(r.root, "datas/nested/private"), "keep");
  r.ok(["snapshot"]);
  t.assertions.assert(!git(t, r, "ls-files").split("\n").some(file => file.startsWith("datas/") || file.startsWith(".genethub/")), "snapshot tracked runtime/works");
  mkdirSync(path.join(r.root, "tools/local"), { recursive: true });
  writeFileSync(path.join(r.root, "tools/local/tool.py"), "# local\n");
  const localDrift = r.ok(["drift"]);
  t.assertions.assert(git(t, r, "ls-files", "--", "tools/local/tool.py") === "tools/local/tool.py", "local source was not included in the snapshot");
  t.assertions.assert(!localDrift.includes("tools/local/tool.py"), "local addition treated as platform drift");
  writeFileSync(path.join(r.root, "skills/expert-core/SKILL.md"), read(r, "skills/expert-core/SKILL.md") + "\nChanged locally.\n");
  t.assertions.assert(r.ok(["drift"]).includes("skills/expert-core/SKILL.md"), "real product-source drift hidden");
});
fileCase("expert-writer-lock-scope", "two plain work directories beneath a team Git root acquire separate writer markers through real spawn, without a fake lock resolver", async (t, r) => {
  r.ok(["snapshot"]);
  for (const folder of ["datas/a", "datas/b"]) {
    mkdirSync(path.join(r.root, folder), { recursive: true });
    r.ok(["spawn", "--kind", "work", "--desc", folder, "--dir", path.join(r.root, folder), "--model", "fixture", "work"], { TEAM_AGENT: "ctl-accept-then-silent", GENEHUB_SESSION_ID: r.front });
  }
  const rows = readdirSync(r.state("pending")).map(file => JSON.parse(readFileSync(r.state("pending", file), "utf8")));
  const locks = rows.filter(row => row.lock).map(row => row.lock as string);
  t.assertions.assert(locks.length === 2 && new Set(locks).size === 2 && locks.some(lock => lock.includes("datas/a")) && locks.some(lock => lock.includes("datas/b")), `writer markers ${JSON.stringify(locks)}`);
});
fileCase("expert-notes", "notes reference a genuine Session round and remain idempotent through notes done", async (t, r) => {
  await r.send(r.front, "a genuine user round");
  await t.tools.waitUntil(async () => (await r.snapshot(r.front)).summary.status === "idle", 20000);
  const args = ["note", "--kind", "unhappy", "--quote", "请保留设置", "--context", "列表简化不能丢入口"];
  r.ok(args, { GENEHUB_SESSION_ID: r.front }); r.ok(args, { GENEHUB_SESSION_ID: r.front });
  const files = readdirSync(r.state("notes"));
  t.assertions.assert(files.length === 1, "retry duplicated note");
  const note = JSON.parse(readFileSync(r.state("notes", files[0]!), "utf8"));
  t.assertions.assert(note.session === r.front && note.turn?.roundId && note.ref?.startsWith(`ghref:item:${r.front}:`), "note lost real round provenance");
  r.ok(["notes", "done", note.id, "--result", "已保留"]);
  t.assertions.assert(!existsSync(r.state("notes", files[0]!)), "handled note stayed pending");
});
fileCase("expert-soul-mirror", "sole soul authority and shared memory reach root and child instruction files; role index updates remain local", async (t, r) => {
  t.assertions.assert(!existsSync(path.join(r.template, "charter.md")), "duplicate core identity shipped");
  writeFileSync(path.join(r.root, "soul.md"), "# Identity\nShared authoritative identity.\n");
  writeFileSync(path.join(r.root, "memory.md"), "Shared learned rule.\n"); r.ok(["sync-identity"]);
  for (const file of ["front/AGENTS.md", "front/CLAUDE.md", "spaces/leader/AGENTS.md"]) {
    t.assertions.assert(read(r, file).includes("Shared authoritative identity.") && read(r, file).includes("Shared learned rule."), `${file} lost shared sources`);
  }
  writeFileSync(path.join(r.root, "spaces/leader/index.md"), "Leader-only observation.\n"); r.ok(["sync-identity"]);
  t.assertions.assert(read(r, "spaces/leader/AGENTS.md").includes("Leader-only observation.") && !read(r, "spaces/qa/AGENTS.md").includes("Leader-only observation."), "role-local identity leaked");
});
fileCase("expert-reset-with-git", "explicit reset keeps the previous identity in Git and restores template authority; a dry plan never overwrites it", async (t, r) => {
  r.ok(["snapshot"]); writeFileSync(path.join(r.root, "soul.md"), "# Customized identity\n");
  r.ok(["reset"]); t.assertions.assert(read(r, "soul.md").includes("Customized"), "dry reset overwrote identity");
  r.ok(["reset", "--apply"]);
  t.assertions.assert(git(t, r, "show", "HEAD~1:soul.md").includes("Customized") && read(r, "soul.md") === readFileSync(path.join(r.template, "soul.md"), "utf8"), "reset lost recovery snapshot or template identity");
});

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

const REFERENCES = "apps/daemon/builtin-skills/genehub/references";

defineSpecialty({
  id: "specialty.daemon.team-deployed-runtime",
  title: "A deployed Team binds local worktrees without rewriting artifacts and refuses partial role definitions",
  oracle: "The shipped CLI refuses employee add before creating a role or Git worktree on a real independent output; bind and retire only change local configuration while public artifact verification stays green; the original source still adds and compiles a role.",
  catches: ["remote employee add leaves Provider descriptors without instructions", "worktree binding corrupts a compiled descriptor", "standby removes generated folders", "a runtime timer recompiles deployed output", "source role editing is accidentally disabled"],
  tags: ["core", "expert", "agent-space"],
  llm: { default: "none" },
  expectedDurationMs: 8_000,
  timeoutMs: 90_000,
  requiredArtifacts: [],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  surfaces: ["tools/team.py", "spacebuilder.py", "git"],
  productInterfaces: ["tools/team.py employee", "tools/team.py worktree bind", "spacebuilder.py verify --artifacts-only"],
}, async (t) => {
  const data = join(t.env.root, "team-runtime");
  const source = join(data, "spaces", "source");
  const output = join(data, "spaces", "output");
  const references = join(data, "builtin-skills", "genehub", "references");
  mkdirSync(references, { recursive: true });
  symlinkSync(join(t.openRoot, REFERENCES, "spacebuilder"), join(references, "spacebuilder"));
  cpSync(join(t.openRoot, REFERENCES, "team-template"), source, { recursive: true });
  const python = process.env.GENEHUB_PYTHON!;
  const env = { PATH: process.env.PATH ?? "", HOME: data };
  const build = (...args: string[]) => spawnSync(python, [join(references, "spacebuilder", "spacebuilder.py"), ...args, "--format", "json"], { env, encoding: "utf8", timeout: 30_000 });
  const built = build("build", source, "--output", output, "--require-no-post-commands");
  t.assertions.assert(built.status === 0, `independent build: ${built.stdout} ${built.stderr}`);
  // These are shipped runtime resources; the separate builder output owns the descriptors and instructions.
  for (const entry of ["tools", "skills", "soul.md", "memory.md"]) cpSync(join(source, entry), join(output, entry), { recursive: true });
  mkdirSync(join(output, "artifacts"));
  writeFileSync(join(output, "artifacts", "PROVENANCE.json"), JSON.stringify({ sourcePath: source }));
  const cli = (root: string, ...args: string[]) => spawnSync(python, [join(root, "tools", "team.py"), ...args], { cwd: join(root, "front"), env, encoding: "utf8", timeout: 30_000 });
  const verified = () => {
    const result = build("verify", output, "--artifacts-only");
    t.assertions.assert(result.status === 0, `runtime artifact drift: ${result.stdout} ${result.stderr}`);
  };
  const repo = join(t.env.root, "business");
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
  t.assertions.assert(git("init").status === 0, "business repository init failed");
  t.assertions.assert(git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "baseline").status === 0, "business baseline commit failed");

  const refused = cli(output, "employee", "add", "extra", "--desc", "remote worker", "--repo", repo);
  t.assertions.assert(refused.status !== 0 && refused.stderr.includes(source), `deployed add did not identify its definition source: ${refused.status} ${refused.stdout} ${refused.stderr}`);
  t.assertions.assert(!existsSync(join(output, "spaces", "extra")) && !existsSync(join(output, "worktrees", "extra-wt")), "refused operation left a partial role or Git worktree");
  verified();
  const descriptor = readFileSync(join(output, "spaces", "qa", "agent-space.genet.json"));
  const bound = cli(output, "worktree", "bind", "qa", repo);
  t.assertions.assert(bound.status === 0, `bind: ${bound.stdout} ${bound.stderr}`);
  const config = join(output, "spaces", "qa", ".genethub", "open.env");
  t.assertions.assert(readFileSync(config, "utf8").includes(`WORKTREE_DIR=${repo}`), "binding not stored in local configuration");
  t.assertions.assert(readFileSync(join(output, "spaces", "qa", "agent-space.genet.json")).equals(descriptor), "binding rewrote the compiled workspace descriptor");
  verified();
  const retired = cli(output, "employee", "retire", "qa");
  t.assertions.assert(retired.status === 0 && !readFileSync(config, "utf8").includes("WORKTREE_DIR="), `standby failed: ${retired.stdout} ${retired.stderr}`);
  verified();
  writeFileSync(join(output, "memory.md"), "# Runtime memory\n\nKeep the user's existing results.\n");
  const sync = cli(output, "sync-identity");
  t.assertions.assert(sync.status === 0 && sync.stdout.trim() === "unchanged", `runtime sync: ${sync.stdout} ${sync.stderr}`);
  verified();
  const added = cli(source, "employee", "add", "source-only", "--desc", "source worker", "--no-worktree");
  t.assertions.assert(added.status === 0 && existsSync(join(source, "spaces", "source-only", "AGENTS.md")), `source add: ${added.stdout} ${added.stderr}`);
  const sourceVerified = build("verify", source);
  t.assertions.assert(sourceVerified.status === 0, `source verification: ${sourceVerified.stdout} ${sourceVerified.stderr}`);
});

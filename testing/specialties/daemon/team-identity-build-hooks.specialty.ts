import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-identity-build-hooks",
  title: "Automatic identity refresh cannot run deployment hooks; explicit builds still can",
  oracle: "A real team identity sync rejects Space pre/post and Provider post with SB018 before side effects or generated identity changes; a repeated failing digest does not rerun; explicit SpaceBuilder build still runs the configured hook",
  catches: ["timer identity refresh unexpectedly publishes a deployment", "command rejection happens after pre side effects", "guard removes explicit build hooks"],
  tags: ["core", "expert", "agent-space", "identity-build-hooks"], llm: { default: "none" },
  requiredArtifacts: [],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/team.py", "spacebuilder.py"], surfaces: ["team-template", "spacebuilder"],
  expectedDurationMs: 6000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
}, async t => {
  const python = process.env.GENEHUB_PYTHON!;
  const refs = join(t.openRoot, "apps/daemon/builtin-skills/genehub/references");
  const root = join(t.env.root, "data/spaces/team");
  const builtin = join(t.env.root, "data/builtin-skills/genehub/references");
  mkdirSync(builtin, { recursive: true });
  symlinkSync(join(refs, "spacebuilder"), join(builtin, "spacebuilder"));
  cpSync(join(refs, "team-template"), root, { recursive: true });
  const env = { ...t.env.env, GENEHUB_PYTHON: python };
  const sync = () => spawnSync(python, ["tools/team.py", "sync-identity"], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  const descriptor = (dir: string) => JSON.parse(readFileSync(join(dir, "agent-space.genet.json"), "utf8"));
  const save = (dir: string, value: unknown) => writeFileSync(join(dir, "agent-space.genet.json"), JSON.stringify(value));
  const initial = sync();
  t.assertions.assert(initial.status === 0 && initial.stdout.trim() === "rebuilt", "baseline team did not compile");
  const before = readFileSync(join(root, "front/AGENTS.md"), "utf8");
  const marker = join(root, "deployment-ran");
  const args = ["{python}", "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('published')", marker];
  const child = join(root, "spaces/qa");
  const baseRoot = descriptor(root), baseChild = descriptor(child);
  for (const variant of ["pre", "post", "child-post", "provider-post"]) {
    const parent = structuredClone(baseRoot), member = structuredClone(baseChild);
    if (variant === "provider-post") {
      parent.skillProviders[0].command = { args: [python, ...args.slice(1)] };
    } else if (variant === "child-post") {
      member.buildHooks = { post: [{ args }] };
    } else {
      parent.buildHooks = { [variant]: [{ args }] };
    }
    save(root, parent); save(child, member);
    writeFileSync(join(root, "soul.md"), `# Identity\nChanged for ${variant}.\n`);
    const refused = sync();
    t.assertions.assert(refused.status === 1 && refused.stderr.includes("SB018"), `identity sync ran ${variant}: ${refused.stdout} ${refused.stderr}`);
    t.assertions.assert(!existsSync(marker) && readFileSync(join(root, "front/AGENTS.md"), "utf8") === before, `automatic ${variant} had side effects`);
    const repeated = sync();
    t.assertions.assert(repeated.status === 0 && repeated.stdout.trim() === "unchanged" && !existsSync(marker), "failing digest reran its hook");
  }
  save(root, { ...baseRoot, buildHooks: { post: [{ args }] } }); save(child, baseChild);
  const explicit = spawnSync(python, [join(refs, "spacebuilder/spacebuilder.py"), "build", root, "--format", "json"], { env, encoding: "utf8", timeout: 30000 });
  t.assertions.assert(explicit.status === 0 && existsSync(marker), `explicit build lost its hook: ${explicit.stdout} ${explicit.stderr}`);
  const recovered = sync();
  t.assertions.assert(recovered.status === 1 && recovered.stderr.includes("SB018"), "an explicit build silently enabled automatic publishing");
  t.note("automatic identity sync refused Space pre/post, child post and Provider post; explicit build executed its configured hook");
});

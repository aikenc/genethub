// An expert made from the template stays on that template; the product never rewrites it behind the owner's back.
// A reset happens only when the user asks, through `tools/expert.py reset`: an expert resets itself or another one,
// soul.md included. A team made before the template's Skills were renamed still selects `expert-core`; a reset or
// the timer's identity sync moves it onto `team-core`. These cases run the real script and the real SpaceBuilder on experts laid out as the daemon lays
// them out (<data>/spaces/<name> next to <data>/builtin-skills), with no daemon and no model.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

const GENEHUB = "apps/daemon/builtin-skills/genehub";
const OLD_SKILL = "---\nname: team-core\ndescription: 旧版本的技能\n---\n";
// The same Skill as the template shipped it before `expert-*` became `team-*`.
const LEGACY_SKILL = "---\nname: expert-core\ndescription: 改名前的技能\n---\n";

function digest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      hash.update(full.slice(dir.length) + (lstatSync(full).isDirectory() ? "/" : ""));
      if (lstatSync(full).isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

defineSpecialty(
  {
    id: "specialty.daemon.expert-reset",
    title: "An expert is reset only on request, to the template with soul.md included, and what is the owner's stays",
    oracle:
      "without --apply the command prints the plan and the expert directory is byte-identical afterwards; with --apply the expert's own skill and tool files, its soul.md and its compiled AGENTS.md/CLAUDE.md are the template's, the replaced files are kept under .genethub/team/reset/<time>/, memory.md survives unless --with-memory, and name, description, an added skill, posts, datas and temp are untouched; the descriptor selects team-core instead of the pre-rename expert-core, and sync-identity moves a member descriptor that still names expert-core/expert-work onto team-core/team-work and builds; one expert can reset another by name or directory name and the other expert's files do not change; a second reset reports nothing to do; an unknown name exits 1 with the next step and changes nothing",
    catches: [
      "a reset that leaves the old soul.md behind",
      "a reset that runs without the user's confirmation step",
      "a reset that deletes posts, datas or the owner's chosen name",
      "an overwrite with no way back",
      "a new soul.md that never reaches the Agents' instruction files",
      "a reset of expert A that changes expert B",
      "a team made before the Skill rename that no longer builds, or selects the same Skill twice, after upgrading",
    ],
    tags: ["core", "expert"],
    llm: { default: "none" },
    expectedDurationMs: 8_000,
    timeoutMs: 90_000,
    requiredArtifacts: [],
    resources: { environments: 1, cpu: 1 },
    surfaces: ["tools/expert.py", "spacebuilder.py"],
    productInterfaces: ["tools/expert.py", "spacebuilder.py"],
  },
  async (t) => {
    const data = join(t.env.root, "expert-reset");
    const references = join(data, "builtin-skills", "genehub", "references");
    mkdirSync(references, { recursive: true });
    symlinkSync(join(t.openRoot, GENEHUB, "references", "spacebuilder"), join(references, "spacebuilder"));
    cpSync(join(t.openRoot, GENEHUB, "references", "team-template"), join(references, "team-template"), { recursive: true });
    const template = join(references, "team-template");
    const env = { PATH: process.env.PATH ?? "", HOME: data };
    const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
    const templateText = (file: string) => readFileSync(join(template, file), "utf8");

    const make = (dir: string, name: string, soul: string) => {
      const expert = join(data, "spaces", dir);
      cpSync(template, expert, { recursive: true });
      const descriptor = JSON.parse(read(expert, "agent-space.genet.json"));
      descriptor.name = name;
      descriptor.description = `${name}的描述`;
      descriptor.skills = [...descriptor.skills, "expert-core", "my-extra-skill"];
      writeFileSync(join(expert, "agent-space.genet.json"), JSON.stringify(descriptor, null, 2));
      mkdirSync(join(expert, "skills", "my-extra-skill"), { recursive: true });
      writeFileSync(join(expert, "skills", "my-extra-skill", "SKILL.md"), "---\nname: my-extra-skill\ndescription: x\n---\n");
      writeFileSync(join(expert, "soul.md"), soul);
      writeFileSync(join(expert, "memory.md"), `${name}的记忆\n`);
      writeFileSync(join(expert, "skills", "team-core", "SKILL.md"), OLD_SKILL);
      mkdirSync(join(expert, "skills", "expert-core"), { recursive: true });
      writeFileSync(join(expert, "skills", "expert-core", "SKILL.md"), LEGACY_SKILL);
      mkdirSync(join(expert, "posts"), { recursive: true });
      writeFileSync(join(expert, "posts", "p.md"), "https://example.com/a/b\n");
      mkdirSync(join(expert, "datas", "g", "p"), { recursive: true });
      writeFileSync(join(expert, "datas", "g", "p", "file.txt"), "keep\n");
      mkdirSync(join(expert, "temp", "261013", "1405_x_abcd"), { recursive: true });
      writeFileSync(join(expert, "temp", "261013", "1405_x_abcd", "f"), "keep\n");
      const built = spawnSync("python3", [join(references, "spacebuilder", "spacebuilder.py"), "build", expert], { env, encoding: "utf8" });
      t.assertions.assert(built.status === 0, `build ${dir}: ${built.stdout}${built.stderr}`);
      return expert;
    };
    const alpha = make("alpha", "小满", "# 灵魂\n\n我叫小满，只说方言。\n");
    const beta = make("beta", "老二", "# 灵魂\n\n我是老二，爱抬杠。\n");
    t.assertions.assert(read(alpha, "front/AGENTS.md").includes("只说方言"), "the soul was not compiled before the reset");

    const reset = (from: string, ...args: string[]) => {
      const done = spawnSync("python3", ["tools/expert.py", "reset", ...args], { cwd: from, env, encoding: "utf8" });
      return { code: done.status ?? -1, out: done.stdout.trim(), err: done.stderr };
    };

    // Without --apply: a plan, and nothing else.
    const before = digest(alpha);
    const plan = reset(alpha);
    t.assertions.assert(plan.code === 0 && plan.out.includes("预演") && plan.out.includes("soul.md") && plan.out.includes("skills/team-core/SKILL.md") && plan.out.includes("--apply"), `plan: ${plan.out} ${plan.err}`);
    t.assertions.assert(!plan.out.includes("覆盖 memory.md"), "memory.md was listed without --with-memory");
    t.assertions.assert(digest(alpha) === before, "the plan changed the expert");

    // Reset itself.
    const done = reset(alpha, "--apply");
    t.assertions.assert(done.code === 0 && done.out.includes("已重置自己"), `apply: ${done.out} ${done.err}`);
    t.assertions.assert(read(alpha, "soul.md") === templateText("soul.md"), "soul.md was not reset");
    t.assertions.assert(read(alpha, "skills/team-core/SKILL.md") === templateText("skills/team-core/SKILL.md"), "a product file was not restored");
    t.assertions.assert(read(alpha, "memory.md") === "小满的记忆\n", "memory.md was reset without --with-memory");
    const descriptor = JSON.parse(read(alpha, "agent-space.genet.json"));
    t.assertions.assert(descriptor.name === "小满" && descriptor.description === "小满的描述" && descriptor.skills.includes("my-extra-skill") && descriptor.skills.includes("team-core") && !descriptor.skills.includes("expert-core"), `descriptor: ${JSON.stringify(descriptor)}`);
    t.assertions.assert(existsSync(join(alpha, "skills", "my-extra-skill", "SKILL.md")), "an added skill was removed");
    t.assertions.assert(read(alpha, "posts/p.md") === "https://example.com/a/b\n" && read(alpha, "datas/g/p/file.txt") === "keep\n" && read(alpha, "temp/261013/1405_x_abcd/f") === "keep\n", "posts, datas or temp changed");
    for (const file of ["front/AGENTS.md", "front/CLAUDE.md"]) {
      t.assertions.assert(!read(alpha, file).includes("只说方言"), `${file} still carries the old soul`);
    }
    const backups = join(alpha, ".genethub", "team", "reset");
    const stamps = readdirSync(backups);
    t.assertions.assert(stamps.length === 1 && read(join(backups, stamps[0]!), "soul.md").includes("只说方言") && read(join(backups, stamps[0]!), "skills/team-core/SKILL.md") === OLD_SKILL, "the replaced files were not kept");
    t.assertions.assert(!existsSync(join(backups, stamps[0]!, "memory.md")), "memory.md was backed up though it was not touched");
    t.assertions.assert(existsSync(join(alpha, ".genethub", "team", "reset.log")), "the reset left no log");
    const again = reset(alpha);
    t.assertions.assert(again.code === 0 && again.out.includes("一致"), `a second reset: ${again.out}`);

    // Reset another expert, by name, with its memory; the one asking is not touched.
    const alphaNow = digest(alpha);
    const betaPlan = reset(alpha, "--expert", "beta");
    t.assertions.assert(betaPlan.code === 0 && betaPlan.out.includes("团队 老二") && read(beta, "soul.md").includes("爱抬杠"), `plan for another: ${betaPlan.out} ${betaPlan.err}`);
    const other = reset(alpha, "--team", "老二", "--with-memory", "--apply");
    t.assertions.assert(other.code === 0 && other.out.includes("团队 老二"), `another: ${other.out} ${other.err}`);
    t.assertions.assert(read(beta, "soul.md") === templateText("soul.md") && read(beta, "memory.md") === templateText("memory.md"), "the other expert's soul or memory was not reset");
    t.assertions.assert(!read(beta, "front/AGENTS.md").includes("爱抬杠") && JSON.parse(read(beta, "agent-space.genet.json")).name === "老二", "the other expert's instructions or name");
    t.assertions.assert(read(alpha, "soul.md") === templateText("soul.md") && digest(alpha) === alphaNow, "resetting another expert changed the one that asked");
    t.assertions.assert(readdirSync(join(beta, ".genethub", "team", "reset")).length === 1, "the other expert has no backup");

    // A name that is no expert: refused, nothing changes.
    mkdirSync(join(data, "spaces", "plain"));
    writeFileSync(join(data, "spaces", "plain", "agent-space.genet.json"), JSON.stringify({ name: "不是专家", tags: ["other"] }));
    const unknown = digest(join(data, "spaces"));
    for (const name of ["没有这位", "不是专家"]) {
      const missing = reset(alpha, "--team", name, "--apply");
      t.assertions.assert(missing.code === 1 && missing.err.includes("找不到团队") && missing.err.includes("下一步"), `unknown ${name}: ${missing.code} ${missing.err}`);
    }
    t.assertions.assert(digest(join(data, "spaces")) === unknown, "a refused reset changed something");

    // A member added before the rename (as `employee add` wrote it) still names the old Skills; the identity sync the
    // timer runs moves it onto the renamed ones, and the team builds again.
    const member = join(beta, "spaces", "leader", "agent-space.genet.json");
    const memberDescriptor = JSON.parse(read(join(beta, "spaces", "leader"), "agent-space.genet.json"));
    memberDescriptor.skills = ["expert-core", "expert-work"];
    writeFileSync(member, JSON.stringify(memberDescriptor, null, 2));
    const synced = spawnSync("python3", ["tools/team.py", "sync-identity"], { cwd: beta, env, encoding: "utf8" });
    t.assertions.assert(synced.status === 0 && synced.stdout.trim() === "rebuilt", `sync-identity: ${synced.stdout} ${synced.stderr}`);
    t.assertions.assert(JSON.stringify(JSON.parse(readFileSync(member, "utf8")).skills) === JSON.stringify(["team-core", "team-work"]), `member skills: ${readFileSync(member, "utf8")}`);
  },
);

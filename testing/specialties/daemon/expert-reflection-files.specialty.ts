// What the reflect session works on, as files: the expert's own git repository at its root, the `platform` branch that
// records the template, the notes the front leaves, the copy of soul.md the reflect Space reads, and the writer lock
// that must stay per folder once a repository sits above `datas/`. These cases run the real script (and for the soul
// copy the real SpaceBuilder) on a copy of the shipped expert template, laid out as the daemon lays experts out
// (<data>/spaces/<name> next to <data>/builtin-skills). `genet` is a small fake that answers `session rounds`.
// No daemon and no model are involved.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const GENEHUB = "apps/daemon/builtin-skills/genehub";
const SPACEBUILDER = "spacebuilder.py";

const FAKE_GENET = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:2] == ["session", "rounds"]:
    rounds = json.load(open(os.environ["FAKE_ROUNDS"])) if os.environ.get("FAKE_ROUNDS") else []
    print(json.dumps({"data": {"page": {"rounds": rounds}}}))
else:
    print(json.dumps({"error": {"message": "fake genet: " + " ".join(args)}}))
    sys.exit(1)
`;

const DRIVER = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("expert", os.path.join(os.environ["EXPERT"], "tools", "expert.py"))
expert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expert)
root = os.environ["EXPERT"]
out = []
for step in json.loads(os.environ["STEPS"]):
    try:
        if step["do"] == "lock":
            out.append({"lock": expert.writer_lock(os.path.join(root, step["path"]))})
        elif step["do"] == "watch":
            marker = expert.state_dir(root, "platform-check.json")
            if os.path.exists(marker):
                os.remove(marker)
            expert.platform_watch(root)
            out.append({})
    except expert.ExpertError as error:
        out.append({"error": error.what, "next": error.next})
print(json.dumps(out))
`;

const base = {
  tags: ["core", "expert"],
  llm: { default: "none" as const },
  expectedDurationMs: 6_000,
  timeoutMs: 90_000,
  requiredArtifacts: [],
  resources: { environments: 1, cpu: 1 },
  surfaces: ["tools/expert.py"],
  productInterfaces: ["tools/expert.py"],
};

type Rig = {
  data: string;
  expert: string;
  template: string;
  env: Record<string, string>;
  cli: (args: string[], extra?: Record<string, string>) => { code: number; out: string; err: string };
  git: (...args: string[]) => string;
  drive: (steps: unknown[]) => Array<{ lock?: string; error?: string; next?: string }>;
};

function rig(t: CaseContext, name: string, build = false): Rig {
  const data = join(t.env.root, name);
  const references = join(data, "builtin-skills", "genehub", "references");
  mkdirSync(references, { recursive: true });
  symlinkSync(join(t.openRoot, GENEHUB, "references", "spacebuilder"), join(references, "spacebuilder"));
  const template = join(references, "expert-template");
  cpSync(join(t.openRoot, GENEHUB, "references", "expert-template"), template, { recursive: true });
  const expert = join(data, "spaces", "alice");
  cpSync(template, expert, { recursive: true });
  const fake = join(data, "genet");
  writeFileSync(fake, FAKE_GENET, { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "", HOME: data, GENEHUB_CLI: fake, GENEHUB_SESSION_ID: "s_front" };
  if (build) {
    const built = spawnSync("python3", [join(references, "spacebuilder", SPACEBUILDER), "build", expert], { env, encoding: "utf8" });
    t.assertions.assert(built.status === 0, `build: ${built.stdout}${built.stderr}`);
  }
  const git = (...args: string[]) => {
    const done = spawnSync("git", ["-C", expert, ...args], { env, encoding: "utf8" });
    t.assertions.assert(done.status === 0, `git ${args.join(" ")}: ${done.stderr}`);
    return done.stdout.trim();
  };
  return {
    data,
    expert,
    template,
    env,
    cli: (args, extra = {}) => {
      const done = spawnSync("python3", ["tools/expert.py", ...args], { cwd: expert, env: { ...env, ...extra }, encoding: "utf8" });
      return { code: done.status ?? -1, out: done.stdout.trim(), err: done.stderr.trim() };
    },
    git,
    drive: (steps) => {
      const done = spawnSync("python3", ["-c", DRIVER], { env: { ...env, EXPERT: expert, STEPS: JSON.stringify(steps) }, encoding: "utf8" });
      t.assertions.assert(done.status === 0, `driver: ${done.stderr}`);
      return JSON.parse(done.stdout);
    },
  };
}

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-git-root",
    title: "The expert's root is a git repository that tracks only its own files, with a platform branch that shows what differs from the template",
    oracle:
      "after one snapshot the root has branches main and platform, a .gitignore that allows only soul.md, memory.md, skills/, tools/, posts/, docs/ and the descriptors; repositories nested in datas/ and temp/, runtime state, generated files and compiled Python are not tracked and produce no warning; drift is empty at first, names an edited platform file, and does not name the expert's own skills/local-* and tools/local files, soul.md or memory.md; a new template version leaves exactly one upgrade note and drift then says so; with no git installed the script reports it and touches nothing",
    catches: [
      "a repository that swallows nested repositories under datas/ or temp/ as embedded gitlinks",
      "runtime state or generated files committed",
      "a platform branch that does not match the template, so drift is noise",
      "the expert's own additions reported as drift",
      "a template upgrade nobody is told about, or told about on every tick",
      "a missing git that breaks the whole timer",
    ],
  },
  async (t) => {
    const r = rig(t, "git-root", true);
    const first = r.cli(["snapshot"]);
    t.assertions.assert(first.code === 0 && first.err === "", `snapshot: ${first.out} ${first.err}`);
    const branches = r.git("branch", "--format=%(refname:short)").split("\n").sort();
    t.assertions.assert(branches.join() === "main,platform", `branches ${branches}`);
    t.assertions.assert(r.git("log", "-1", "--format=%s", "platform").startsWith("platform: "), "the platform commit does not name its template version");
    const ignore = readFileSync(join(r.expert, ".gitignore"), "utf8");
    t.assertions.assert(ignore.includes("\n/*\n") && ignore.includes("!/soul.md") && ignore.includes("!/skills/") && ignore.includes("/spaces/*/*"), "the .gitignore is not an allowlist");

    // Nested repositories under datas/ and temp/, runtime state and generated files stay out, silently.
    for (const nested of ["datas/g/proj", "temp/261013/1405_x_abcd"]) {
      mkdirSync(join(r.expert, nested), { recursive: true });
      spawnSync("git", ["init", "-q", join(r.expert, nested)]);
      writeFileSync(join(r.expert, nested, "f.txt"), "x");
    }
    mkdirSync(join(r.expert, "tools/__pycache__"), { recursive: true }); // what importing the script leaves behind
    writeFileSync(join(r.expert, "tools/__pycache__/expert.cpython-39.pyc"), "x");
    // Runtime work artifacts inside spaces/work/ stay out of git too.
    mkdirSync(join(r.expert, "spaces/work/qa-shots"), { recursive: true });
    writeFileSync(join(r.expert, "spaces/work/index.html"), "<html>game</html>");
    writeFileSync(join(r.expert, "spaces/work/qa-shots/shot.png"), "png");
    const second = r.cli(["snapshot"]);
    t.assertions.assert(second.err === "" && second.out.includes("没有需要提交"), `snapshot with nested repositories: ${second.out} ${second.err}`);
    const tracked = r.git("ls-files").split("\n");
    for (const forbidden of ["datas/", "temp/", ".genethub/", ".spacebuilder/", "front/AGENTS.md", "spaces/work/AGENTS.md", "spaces/work/index.html", "spaces/work/qa-shots/", "tools/__pycache__/"]) {
      t.assertions.assert(!tracked.some((file) => file.startsWith(forbidden)), `${forbidden} is tracked: ${tracked.filter((f) => f.startsWith(forbidden)).slice(0, 3)}`);
    }
    t.assertions.assert(tracked.includes("skills/expert-core/SKILL.md") && tracked.includes("spaces/reflect/agent-space.genet.json") && tracked.includes("soul.md"), "own files are not tracked");

    // Drift: empty, then the edited platform file; the expert's own files are not drift.
    t.assertions.assert(r.cli(["drift"]).out === "平台文件与 platform 分支一致", `fresh drift: ${r.cli(["drift"]).out}`);
    writeFileSync(join(r.expert, "skills/expert-core/SKILL.md"), readFileSync(join(r.expert, "skills/expert-core/SKILL.md"), "utf8") + "\n多一行\n");
    mkdirSync(join(r.expert, "skills/local-style"), { recursive: true });
    writeFileSync(join(r.expert, "skills/local-style/SKILL.md"), "---\nname: local-style\ndescription: x\n---\n");
    mkdirSync(join(r.expert, "tools/local"), { recursive: true });
    writeFileSync(join(r.expert, "tools/local/policy.json"), "{}");
    writeFileSync(join(r.expert, "soul.md"), "# 灵魂\n\n我改过了。\n");
    writeFileSync(join(r.expert, "memory.md"), "记过了\n");
    const drift = r.cli(["drift"]).out;
    t.assertions.assert(drift.split("\n").join("|") === "M\tskills/expert-core/SKILL.md", `drift: ${drift}`);
    t.assertions.assert(r.git("log", "-1", "--format=%s") === "snapshot: drift 之前", "drift did not commit what had changed first");

    // A new template version: one upgrade note, then silence; drift says the template is newer; once platform branch catches up, the note is auto-cleaned.
    t.assertions.assert(r.drive([{ do: "watch" }])[0]!.error === undefined, "platform_watch failed");
    t.assertions.assert(!existsSync(join(r.expert, ".genethub/expert/notes")), "a note was written though the template did not change");
    t.assertions.assert(r.git("merge-base", "main", "platform").length > 0, "main and platform do not share a merge-base");
    writeFileSync(join(r.template, "skills/expert-work/SKILL.md"), readFileSync(join(r.template, "skills/expert-work/SKILL.md"), "utf8") + "\n新版本多一行\n");
    r.drive([{ do: "watch" }]);
    r.drive([{ do: "watch" }]);
    const notes = readdirSync(join(r.expert, ".genethub/expert/notes"));
    const note = JSON.parse(readFileSync(join(r.expert, ".genethub/expert/notes", notes[0]!), "utf8"));
    t.assertions.assert(notes.length === 1 && note.kind === "upgrade", `upgrade notes ${JSON.stringify(notes)}`);
    t.assertions.assert(r.cli(["drift"]).out.includes("平台模板有新版本"), `drift after a template change: ${r.cli(["drift"]).out}`);
    r.cli(["snapshot", "--refresh-platform"]);
    r.drive([{ do: "watch" }]);
    t.assertions.assert(readdirSync(join(r.expert, ".genethub/expert/notes")).length === 0, "upgrade note was not auto-cleaned after platform branch caught up");

    // 3-way merge in temp/ (as upgrade.md prescribes): template updates front/style.md while expert customized soul.md and skills/expert-core/SKILL.md.
    writeFileSync(join(r.template, "front/style.md"), `${readFileSync(join(r.template, "front/style.md"), "utf8")}\n- 平台新增前台规范条目\n`);
    r.drive([{ do: "watch" }]);
    t.assertions.assert(readdirSync(join(r.expert, ".genethub/expert/notes")).length === 1, "second template update did not create upgrade note");
    const workdir = r.cli(["temp", "new", "upgrade-platform", "--purpose", "三方合并升级平台模板"]).out;
    t.assertions.assert(workdir.includes("/temp/"), `temp new for upgrade: ${workdir}`);
    spawnSync("git", ["clone", "-q", r.expert, join(workdir, "repo")], { env: r.env });
    const cloneDir = join(workdir, "repo");
    spawnSync("git", ["-C", cloneDir, "branch", "-f", "platform", "origin/platform"], { env: r.env });
    const refreshInClone = spawnSync("python3", ["tools/expert.py", "snapshot", "--refresh-platform", "-m", "before merge"], {
      cwd: cloneDir,
      env: { ...r.env, EXPERT_TEMPLATE: r.template },
      encoding: "utf8",
    });
    t.assertions.assert(refreshInClone.status === 0, `refresh in clone: ${refreshInClone.stderr}`);
    const merged = spawnSync(
      "git",
      ["-C", cloneDir, "-c", "user.name=expert", "-c", "user.email=expert@genethub.local", "merge", "--no-edit", "platform"],
      { env: r.env, encoding: "utf8" },
    );
    t.assertions.assert(merged.status === 0, `3-way git merge platform in clone failed: ${merged.stdout} ${merged.stderr}`);
    r.git("fetch", "-q", cloneDir, "main:refs/remotes/upgrade/main", "platform:platform");
    r.git("merge", "--ff-only", "refs/remotes/upgrade/main");
    t.assertions.assert(
      readFileSync(join(r.expert, "front/style.md"), "utf8").includes("平台新增前台规范条目") &&
        readFileSync(join(r.expert, "soul.md"), "utf8").includes("我改过了") &&
        readFileSync(join(r.expert, "skills/expert-core/SKILL.md"), "utf8").includes("多一行") &&
        readFileSync(join(r.expert, "skills/expert-work/SKILL.md"), "utf8").includes("新版本多一行"),
      "3-way merge did not preserve both platform update and expert customization",
    );
    r.drive([{ do: "watch" }]);
    t.assertions.assert(readdirSync(join(r.expert, ".genethub/expert/notes")).length === 0, "upgrade note was not auto-cleaned after 3-way merge");

    // No git: said once with the next step; nothing else breaks.
    const python = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
    const noGit = spawnSync(python, ["tools/expert.py", "snapshot"], { cwd: r.expert, env: { ...r.env, PATH: "/nonexistent" }, encoding: "utf8" });
    t.assertions.assert(noGit.status === 1 && noGit.stderr.includes("没有 git") && noGit.stderr.includes("下一步"), `without git: ${noGit.stdout} ${noGit.stderr}`);
  },
);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-writer-lock-scope",
    title: "A repository at the expert's root does not make every folder under datas/ share one writer lock",
    oracle:
      "with the expert's root a repository, writer_lock of two plain folders under datas/ are two different directories, each inside its own folder; a folder that is itself a repository keeps its marker in its own .git",
    catches: [
      "every plain folder under datas/ sharing the root repository's lock, so one write session blocks all others",
      "a folder's repository marker moved out of its own .git",
    ],
  },
  async (t) => {
    const r = rig(t, "writer-lock");
    r.cli(["snapshot"]);
    for (const folder of ["datas/g/a", "datas/g/b", "datas/g/c"]) mkdirSync(join(r.expert, folder), { recursive: true });
    spawnSync("git", ["init", "-q", join(r.expert, "datas/g/c")]);
    const [a, b, c] = r.drive([{ do: "lock", path: "datas/g/a" }, { do: "lock", path: "datas/g/b" }, { do: "lock", path: "datas/g/c" }]).map((step) => step.lock!);
    t.assertions.assert(a !== b, `two plain folders share one lock directory: ${a}`);
    t.assertions.assert(a!.startsWith(join(r.expert, "datas/g/a")) && b!.startsWith(join(r.expert, "datas/g/b")), `locks are not inside their folders: ${a} ${b}`);
    t.assertions.assert(!a!.startsWith(join(r.expert, ".git")), "a plain folder's lock is in the root repository");
    t.assertions.assert(c!.endsWith(join("datas/g/c", ".git")), `a repository's own marker moved: ${c}`);
  },
);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-notes",
    title: "A note records the session, the turn and a reference the reflect session can follow, and is kept even when fields are missing",
    oracle:
      "note --quote --context writes one file under .genethub/expert/notes with the session, the newest round's id and user message id, and ghref:item:<session>:<message>; the same note twice is written once; a note with no quote or context is still kept and the output names what is missing; without a session id it is kept with a hint; `notes` lists it, `notes done` moves it to the handled set with the result, and a handled note is not written again",
    catches: [
      "a note that cannot be traced back to the round that caused it",
      "a note refused for a missing field, so the unhappiness goes unrecorded",
      "the same complaint recorded on every retry",
      "a handled note that reappears",
    ],
  },
  async (t) => {
    const r = rig(t, "notes");
    const rounds = join(r.data, "rounds.json");
    writeFileSync(rounds, JSON.stringify([{ roundId: "r1", userItemId: "u.1" }, { roundId: "r2", userItemId: "u.2" }]));
    const withRounds = { FAKE_ROUNDS: rounds };
    const noted = r.cli(["note", "--kind", "unhappy", "--quote", "不对，不是这个意思", "--context", "把评审开成了 work"], withRounds);
    t.assertions.assert(noted.code === 0 && noted.out.startsWith("已留言") && !noted.out.includes("；"), `note: ${noted.out} ${noted.err}`);
    const dir = join(r.expert, ".genethub/expert/notes");
    const files = readdirSync(dir);
    const note = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    t.assertions.assert(
      files.length === 1 && note.session === "s_front" && note.turn.roundId === "r2" && note.turn.userItemId === "u.2" && note.ref === "ghref:item:s_front:u.2" && note.quote === "不对，不是这个意思" && note.kind === "unhappy",
      `note ${JSON.stringify(note)}`,
    );
    t.assertions.assert(r.cli(["note", "--kind", "unhappy", "--quote", "不对，不是这个意思", "--context", "把评审开成了 work"], withRounds).out.includes("记过了") && readdirSync(dir).length === 1, "the same note was written twice");

    const bare = r.cli(["note", "随便记一下"], withRounds);
    t.assertions.assert(bare.code === 0 && bare.out.includes("--quote") && readdirSync(dir).length === 2, `a note without a quote: ${bare.out} ${bare.err}`);
    const noSession = r.cli(["note", "--quote", "x", "没有会话"], { GENEHUB_SESSION_ID: "" });
    t.assertions.assert(noSession.code === 0 && noSession.out.includes("没有会话 id") && readdirSync(dir).length === 3, `a note without a session: ${noSession.out} ${noSession.err}`);
    const noRounds = r.cli(["note", "--quote", "y", "取不到轮次"]);
    t.assertions.assert(noRounds.code === 0 && noRounds.out.includes("取不到这个会话的轮次") && readdirSync(dir).length === 4, `a note with no rounds: ${noRounds.out} ${noRounds.err}`);

    const listed = r.cli(["notes"]);
    t.assertions.assert(listed.out.includes(files[0]!.replace(".json", "")) && listed.out.includes("ghref:item:s_front:u.2") && listed.out.includes("不对，不是这个意思"), `notes: ${listed.out}`);
    const id = files[0]!.replace(".json", "");
    t.assertions.assert(r.cli(["notes", "done", id, "--result", "改了前台 Skill"]).out === "已处理 1 条留言", "notes done");
    t.assertions.assert(!existsSync(join(dir, files[0]!)), "a handled note is still pending");
    const handled = JSON.parse(readFileSync(join(r.expert, ".genethub/expert/notes-done", files[0]!), "utf8"));
    t.assertions.assert(handled.result === "改了前台 Skill" && typeof handled.handledAtMs === "number", `handled note ${JSON.stringify(handled)}`);
    t.assertions.assert(r.cli(["note", "--kind", "unhappy", "--quote", "不对，不是这个意思", "--context", "把评审开成了 work"], withRounds).out.includes("记过了") && !existsSync(join(dir, files[0]!)), "a handled note came back");
    const missing = r.cli(["notes", "done", "nope"]);
    t.assertions.assert(missing.code === 1 && missing.err.includes("下一步"), `notes done with a bad id: ${missing.err}`);
  },
);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-soul-mirror",
    title: "All four Spaces compile soul.md and memory.md directly without a mirror copy, plus their own style.md and index.md",
    oracle:
      "the template has no spaces/reflect/soul.mirror.md; after the first build front/, research/, work/ and reflect/ all carry the soul, memory and their own style; after sync-identity with an edited soul.md and spaces/work/index.md, all four Spaces carry the new soul and work/ carries its index; with no change the next sync reports unchanged",
    catches: [
      "a child Space that does not know who the expert is or misses the shared memory",
      "a stale mirror copy left in spaces/reflect/",
      "a Space's own style.md or index.md not compiled into its instruction file",
      "an unchanged identity rebuilding on every tick",
    ],
  },
  async (t) => {
    const r = rig(t, "soul-mirror", true);
    t.assertions.assert(!existsSync(join(r.template, "spaces/reflect/soul.mirror.md")), "spaces/reflect/soul.mirror.md still exists in the template");
    for (const dir of ["front", "spaces/research", "spaces/work", "spaces/reflect"]) {
      const agents = readFileSync(join(r.expert, dir, "AGENTS.md"), "utf8");
      t.assertions.assert(agents.includes("我做的一切只有一个目的：让用户满意"), `${dir}/AGENTS.md does not carry the soul after the first build`);
      t.assertions.assert(agents.includes("全局核心记忆与铁律"), `${dir}/AGENTS.md does not carry memory.md after the first build`);
    }
    r.cli(["sync-identity"]);
    t.assertions.assert(r.cli(["sync-identity"]).out === "unchanged", "an unchanged identity rebuilt");

    writeFileSync(join(r.expert, "soul.md"), "# 灵魂\n\n我叫小满，只说方言。\n");
    writeFileSync(join(r.expert, "spaces/work/index.md"), "# 行动经验索引\n\n- 改前先跑测试\n");
    const synced = r.cli(["sync-identity"]);
    t.assertions.assert(synced.out === "rebuilt", `sync after an edit: ${synced.out} ${synced.err}`);
    for (const dir of ["front", "spaces/research", "spaces/work", "spaces/reflect"]) {
      t.assertions.assert(readFileSync(join(r.expert, dir, "AGENTS.md"), "utf8").includes("只说方言"), `the new soul did not reach ${dir}/AGENTS.md`);
    }
    t.assertions.assert(readFileSync(join(r.expert, "spaces/work/AGENTS.md"), "utf8").includes("改前先跑测试"), "work/index.md did not reach spaces/work/AGENTS.md");
    t.assertions.assert(!readFileSync(join(r.expert, "spaces/research/AGENTS.md"), "utf8").includes("改前先跑测试"), "work/index.md leaked into spaces/research/AGENTS.md");
  },
);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-reset-with-git",
    title: "A reset of an expert that has a repository commits the old state first and records the new template, and the plan points to the reflect session",
    oracle:
      "the plan text says to let the reflect session do the upgrade and only reset on the user's authority; applying a reset on an expert with a repository leaves a snapshot commit before it and a reset commit after it, the platform branch holds the template's version, and the old files can be restored from the snapshot",
    catches: [
      "a reset with no way back in git",
      "a platform branch left on the old template after a reset, so drift is wrong",
      "a plan that tells the user to reset instead of upgrading through the reflect session",
    ],
  },
  async (t) => {
    const r = rig(t, "reset-git", true);
    r.cli(["snapshot"]);
    writeFileSync(join(r.expert, "skills/expert-core/SKILL.md"), "---\nname: expert-core\ndescription: 我改过的\n---\n");
    writeFileSync(join(r.expert, "soul.md"), "# 灵魂\n\n我叫小满。\n");
    const plan = r.cli(["reset"]);
    t.assertions.assert(plan.out.includes("预演") && plan.out.includes("reflect now") && plan.out.includes("反思会话"), `plan: ${plan.out}`);
    const done = r.cli(["reset", "--apply"]);
    t.assertions.assert(done.code === 0 && done.out.includes("已重置自己"), `apply: ${done.out} ${done.err}`);
    const subjects = r.git("log", "--format=%s", "main").split("\n");
    t.assertions.assert(subjects[0] === "reset: 恢复为平台模板" && subjects[1] === "snapshot: 重置之前", `main log ${subjects}`);
    t.assertions.assert(r.git("show", "HEAD~1:skills/expert-core/SKILL.md").includes("我改过的") && r.git("show", "HEAD~1:soul.md").includes("我叫小满"), "the old files are not in the snapshot");
    t.assertions.assert(r.cli(["drift"]).out === "平台文件与 platform 分支一致", `drift after a reset: ${r.cli(["drift"]).out}`);
  },
);

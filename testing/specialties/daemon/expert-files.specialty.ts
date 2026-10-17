// An expert keeps its files in its own directory: `datas/` for what it wants to maintain, `temp/` for what may
// be cleaned at any time. Names in `temp/` are the only index the expert has, so they are made by the script
// (`tools/expert.py temp new`) and checked there. These cases run the real script on a copy of the shipped
// expert template, in-process where time or a second caller has to be controlled, and through the command
// line where the Agent's own interface is what is under test. No daemon and no model are involved.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const TEMPLATE = "apps/daemon/builtin-skills/genehub/references/team-template";
const DAY = 86400;

const DRIVER = `
import json, os, sys, time
sys.path.insert(0, os.path.join(os.environ["EXPERT"], "tools"))
import expert
steps = json.loads(os.environ["STEPS"])
root = os.environ["EXPERT"]
out = []
for step in steps:
    try:
        if step["do"] == "new":
            out.append({"path": expert.temp_new(root, step["slug"], step.get("purpose", "p"), step["now"], step["caller"])})
        elif step["do"] == "clean":
            removed = expert.temp_clean(root, step.get("keep"), step.get("dry", False), step["now"])
            out.append({"removed": sorted(os.path.relpath(p, root) for p, _ in removed)})
        elif step["do"] == "age":
            target = os.path.join(root, step["path"])
            for current, dirs, files in os.walk(target):
                for name in dirs + files:
                    os.utime(os.path.join(current, name), (step["at"], step["at"]))
            os.utime(target, (step["at"], step["at"]))
            out.append({})
        elif step["do"] == "settle":
            # a directory is as old as the newest thing in it, as it would be had the files been written then
            for current, dirs, files in os.walk(os.path.join(root, "temp"), topdown=False):
                times = [os.lstat(os.path.join(current, name)).st_mtime for name in dirs + files]
                if times:
                    os.utime(current, (max(times), max(times)))
            out.append({})
        elif step["do"] == "touch":
            target = os.path.join(root, step["path"])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            open(target, "w").write("x")
            os.utime(target, (step["at"], step["at"]))
            out.append({})
    except expert.ExpertError as error:
        out.append({"error": error.what, "next": error.next})
print(json.dumps(out))
`;

type Outcome = { path?: string; error?: string; next?: string; removed?: string[] };

function setup(t: CaseContext, name: string): { expert: string; run: (steps: unknown[]) => Outcome[]; cli: (args: string[], session?: string) => { code: number; out: string; err: string } } {
  const expert = join(t.env.root, name, "expert");
  cpSync(join(t.openRoot, TEMPLATE), expert, { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: join(t.env.root, name) };
  return {
    expert,
    run: (steps) => {
      const done = spawnSync("python3", ["-c", DRIVER], { env: { ...env, EXPERT: expert, STEPS: JSON.stringify(steps) }, encoding: "utf8" });
      t.assertions.assert(done.status === 0, `driver: ${done.stderr}`);
      return JSON.parse(done.stdout) as Outcome[];
    },
    cli: (args, session = "s_aaaa") => {
      const done = spawnSync("python3", ["tools/expert.py", ...args], { cwd: expert, env: { ...env, GENEHUB_SESSION_ID: session }, encoding: "utf8" });
      return { code: done.status ?? -1, out: done.stdout.trim(), err: done.stderr };
    },
  };
}

const base = {
  tags: ["core", "expert"],
  llm: { default: "none" as const },
  expectedDurationMs: 4_000,
  timeoutMs: 60_000,
  requiredArtifacts: [],
  resources: { environments: 1, cpu: 1 },
  surfaces: ["tools/expert.py"],
  productInterfaces: ["tools/expert.py"],
};

// 2026-10-13 14:05:00 local time; only differences and the printed date parts matter.
const NOW = Math.floor(new Date(2026, 9, 13, 14, 5, 0).getTime() / 1000);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-temp-naming",
    title: "A scratch directory is named temp/YYMMDD/hhmm_slug_hash4, the same caller gets the same one back, and a bad slug creates nothing",
    oracle:
      "temp new gives temp/261013/1405_fix-login_xxxx with four hex characters and a .temp.json holding the purpose and the creator; the same caller in the same minute gets the same directory, another caller or another minute gets another; an empty, uppercase, Chinese, over-long, slash-containing or dash-ended slug, and a missing purpose, are refused with the rule in the message and no directory is created",
    catches: [
      "two sessions sharing one scratch directory",
      "a retry creating a second directory for the same job",
      "a name that cannot be told from its neighbours",
      "a path-like slug placing the directory outside temp/",
      "a scratch directory nobody can say the purpose of",
    ],
  },
  async (t) => {
    const { expert, run, cli } = setup(t, "expert-temp-naming");
    const [first, again, other, later, ...bad] = run([
      { do: "new", slug: "fix-login", purpose: "复现登录问题", now: NOW, caller: "s_one" },
      { do: "new", slug: "fix-login", purpose: "ignored on the second call", now: NOW + 20, caller: "s_one" },
      { do: "new", slug: "fix-login", now: NOW, caller: "s_two" },
      { do: "new", slug: "fix-login", now: NOW + 120, caller: "s_one" },
      ...["", "Fix-Login", "中文", "x".repeat(31), "a/b", "../x", "fix-", "-fix", "fix--login"].map((slug) => ({ do: "new", slug, now: NOW, caller: "s_one" })),
      { do: "new", slug: "ok-slug", purpose: "   ", now: NOW, caller: "s_one" },
    ]);
    t.assertions.assert(
      /\/temp\/261013\/1405_fix-login_[0-9a-f]{4}$/.test(first!.path ?? ""),
      `name ${first?.path}`,
    );
    const meta = JSON.parse(readFileSync(join(first!.path!, ".temp.json"), "utf8"));
    t.assertions.assert(meta.purpose === "复现登录问题" && meta.creator === "s_one" && meta.slug === "fix-login", `meta ${JSON.stringify(meta)}`);
    t.assertions.assert(again!.path === first!.path, "the same caller in the same minute got another directory");
    t.assertions.assert(JSON.parse(readFileSync(join(first!.path!, ".temp.json"), "utf8")).purpose === "复现登录问题", "a repeat rewrote the purpose");
    t.assertions.assert(other!.path !== first!.path && other!.path?.includes("1405_fix-login_"), `another caller: ${other?.path} vs ${first?.path}`);
    t.assertions.assert(later!.path?.includes("1407_fix-login_"), `two minutes later: ${later?.path}`);
    for (const [index, outcome] of bad.entries()) {
      t.assertions.assert(outcome.error !== undefined && !outcome.path, `bad slug #${index} was accepted: ${JSON.stringify(outcome)}`);
    }
    t.assertions.assert(bad[0]!.next?.includes("小写字母"), `the message does not state the rule: ${bad[0]?.next}`);
    t.assertions.assert(!existsSync(join(expert, "temp", "261013", "1405_ok-slug_0000")) && readdirSync(join(expert, "temp", "261013")).length === 3, "a refused call left a directory behind");

    // The command line is the Agent's interface: the purpose is required, the path is printed, `ls` shows who and why.
    t.assertions.assert(cli(["temp", "new", "no-purpose"]).code !== 0, "temp new without --purpose succeeded");
    const made = cli(["temp", "new", "review-pr-42", "--purpose", "评审 PR 42"], "s_cli");
    t.assertions.assert(made.code === 0 && made.out.startsWith(join(expert, "temp")), `cli new: ${made.out} ${made.err}`);
    const listing = cli(["temp", "ls", "--slug", "review"]);
    t.assertions.assert(listing.out.includes("s_cli") && listing.out.includes("评审 PR 42") && !listing.out.includes("fix-login"), `ls: ${listing.out}`);
    t.assertions.assert(cli(["temp", "ls", "--mine"], "s_cli").out.includes("review-pr-42") && !cli(["temp", "ls", "--mine"], "s_cli").out.includes("fix-login"), "ls --mine");
  },
);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-temp-remove-and-clean",
    title: "temp rm cannot leave temp/, and cleaning removes only what has not changed for the keep time and never what changed in the last day",
    oracle:
      "temp rm of ../datas/x, of an absolute path outside temp/, and of a fragment naming two directories removes nothing; rm of a symlink inside temp/ removes the link and not what it points at; rm of a unique fragment removes that directory. Cleaning with a 7-day keep time removes a 10-day-old tree and a 8-day tree, keeps a tree created 10 days ago but touched an hour ago and a tree whose one nested file changed 2 hours ago, keeps temp/README.md, deletes a date directory that became empty, writes one log line, and removes nothing with --dry-run; with a keep time of 0 a 30-hour-old tree goes and a 1-hour-old tree stays",
    catches: [
      "an rm that follows a path out of temp/ into datas/",
      "a symlink in temp/ used to delete a project",
      "a tree still in use cleaned because its name carries an old date",
      "a clean with no floor that removes what was written minutes ago",
      "empty date directories piling up",
      "a dry run that deletes",
    ],
  },
  async (t) => {
    const { expert, run, cli } = setup(t, "expert-temp-remove-and-clean");
    mkdirSync(join(expert, "datas", "g", "x"), { recursive: true });
    writeFileSync(join(expert, "datas", "g", "x", "keep.txt"), "project");

    const [a, b] = run([
      { do: "new", slug: "alpha-job", now: NOW, caller: "s_one" },
      { do: "new", slug: "alpha-other", now: NOW, caller: "s_one" },
    ]);
    t.assertions.assert(cli(["temp", "rm", join(expert, "datas", "g", "x")]).code !== 0, "rm of a path outside temp/ succeeded");
    t.assertions.assert(cli(["temp", "rm", "../datas"]).code !== 0, "rm ../datas succeeded");
    t.assertions.assert(cli(["temp", "rm", join(expert, "temp")]).code !== 0, "rm of temp/ itself succeeded");
    const ambiguous = cli(["temp", "rm", "alpha"]);
    t.assertions.assert(ambiguous.code !== 0 && existsSync(a!.path!) && existsSync(b!.path!), `an ambiguous fragment removed something: ${ambiguous.err}`);
    symlinkSync(join(expert, "datas", "g", "x"), join(a!.path!, "link-to-project"));
    t.assertions.assert(cli(["temp", "rm", join(a!.path!, "link-to-project")]).code === 0, "rm of a symlink inside temp/ failed");
    t.assertions.assert(existsSync(join(expert, "datas", "g", "x", "keep.txt")), "rm of the symlink deleted the project behind it");
    t.assertions.assert(!existsSync(join(a!.path!, "link-to-project")) && lstatSafe(a!.path!), "the link is still there, or its directory is gone");
    const removed = cli(["temp", "rm", "alpha-other"]);
    t.assertions.assert(removed.code === 0 && !existsSync(b!.path!) && existsSync(a!.path!), `unique fragment: ${removed.err}`);

    // Cleaning, with times set by hand relative to NOW.
    const old = (days: number) => NOW - days * DAY;
    const hours = (count: number) => NOW - count * 3600;
    const made = run([
      { do: "touch", path: "temp/README.md", at: old(30) },
      { do: "touch", path: "temp/261003/1000_old-tree_aaaa/a.txt", at: old(10) },
      { do: "touch", path: "temp/261005/0900_eight-days_bbbb/a.txt", at: old(8) },
      { do: "touch", path: "temp/261003/1100_touched-today_cccc/a.txt", at: hours(1) },
      { do: "touch", path: "temp/261003/1200_nested_dddd/deep/er/a.txt", at: old(9) },
      { do: "touch", path: "temp/261003/1200_nested_dddd/deep/er/b.txt", at: hours(2) },
      { do: "touch", path: "temp/261011/0800_thirty-hours_eeee/a.txt", at: hours(30) },
      { do: "touch", path: "temp/261013/1300_one-hour_ffff/a.txt", at: hours(1) },
      { do: "touch", path: "temp/stray.txt", at: old(20) },
      { do: "settle" },
    ]);
    t.assertions.assert(made.length === 10, "fixture steps");
    const everything = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);
    const before = everything(join(expert, "temp"));
    const dry = run([{ do: "clean", now: NOW, dry: true }])[0]!;
    t.assertions.assert(JSON.stringify(everything(join(expert, "temp"))) === JSON.stringify(before), "--dry-run removed something");
    t.assertions.assert(
      dry.removed?.includes("temp/261003/1000_old-tree_aaaa") && dry.removed?.includes("temp/261005/0900_eight-days_bbbb") && dry.removed?.includes("temp/stray.txt"),
      `dry-run list ${JSON.stringify(dry.removed)}`,
    );
    const cleaned = run([{ do: "clean", now: NOW }])[0]!;
    const left = everything(join(expert, "temp"));
    t.assertions.assert(!left.some((item) => item.includes("old-tree") || item.includes("eight-days") || item.includes("stray")), `old things remain: ${left}`);
    t.assertions.assert(
      left.includes("README.md") && left.some((item) => item.includes("touched-today")) && left.some((item) => item.includes("nested_dddd/deep/er/b.txt")) && left.some((item) => item.includes("thirty-hours")),
      `things in use or younger than the keep time were removed: ${left}`,
    );
    t.assertions.assert(!left.includes("261005") && left.includes("261003"), `date directories: ${left}`);
    t.assertions.assert(cleaned.removed?.length === 3, `removed ${JSON.stringify(cleaned.removed)}`);
    const log = readFileSync(join(expert, ".genethub/expert/temp-clean.log"), "utf8").trim().split("\n");
    t.assertions.assert(log.length === 1 && log[0]!.includes("清理 3 项"), `log ${log}`);

    // A keep time of 0 still keeps what changed within a day.
    const zero = run([{ do: "clean", now: NOW, keep: 0 }])[0]!;
    t.assertions.assert(zero.removed?.length === 1 && zero.removed[0]!.includes("thirty-hours"), `keep 0 removed ${JSON.stringify(zero.removed)}`);
    t.assertions.assert(everything(join(expert, "temp")).some((item) => item.includes("one-hour")), "keep 0 removed what was written an hour ago");
  },
);

function lstatSafe(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-datas-paths",
    title: "An expert's datas/ path comes from the script as group/name, from a git address or by hand, and never leaves datas/",
    oracle:
      "path datas --from gives datas/<group>/<name> for an https address, an ssh address, an address ending .git and one with a trailing slash; path datas group/folder gives the same shape for anything else and --create makes the directory; an absolute path, .., a backslash and an empty segment are refused and nothing is created; path temp is temp/ itself and refuses a spec; datas ls lists group/name entries; the shipped READMEs for datas/ and temp/ exist in the template and state the rules",
    catches: [
      "a project cloned somewhere the expert does not own",
      "an address form that yields a different path each time",
      "a spec with .. writing outside datas/",
      "an Agent left to guess the rules because the READMEs are missing",
    ],
  },
  async (t) => {
    const { expert, cli } = setup(t, "expert-datas-paths");
    const same = join(expert, "datas", "aikenc", "genethub");
    for (const address of ["https://github.com/aikenc/genethub", "https://github.com/aikenc/genethub.git", "https://github.com/aikenc/genethub/", "git@github.com:aikenc/genethub.git", "ssh://git@host.example/aikenc/genethub.git"]) {
      const answer = cli(["path", "datas", "--from", address]);
      t.assertions.assert(answer.code === 0 && answer.out === same, `${address} → ${answer.out} ${answer.err}`);
    }
    const folder = cli(["path", "datas", "research/competitors", "--create"]);
    t.assertions.assert(folder.out === join(expert, "datas", "research", "competitors") && existsSync(folder.out), `folder: ${folder.out} ${folder.err}`);
    t.assertions.assert(!existsSync(same), "a path without --create made a directory");
    for (const spec of ["/etc", "a/../../b", "a\\b", "a//b", ".."]) {
      const refused = cli(["path", "datas", spec, "--create"]);
      t.assertions.assert(refused.code !== 0 && refused.err.includes("下一步"), `spec ${JSON.stringify(spec)} accepted: ${refused.out}`);
    }
    t.assertions.assert(!existsSync(join(expert, "b")) && !existsSync(join(expert, "datas", "a")), "a refused spec created something");
    t.assertions.assert(cli(["path", "temp"]).out === join(expert, "temp"), "path temp");
    t.assertions.assert(cli(["path", "temp", "x"]).code !== 0, "path temp accepted a spec");
    t.assertions.assert(cli(["datas", "ls"]).out.includes("research/competitors"), "datas ls");
    for (const [file, words] of [["datas/README.md", ["datas/<group>", "temp/", "只读"]], ["temp/README.md", ["随时会被清理", "temp new", "24 小时"]]] as const) {
      const text = readFileSync(join(expert, file), "utf8");
      t.assertions.assert(words.every((word) => text.includes(word)), `${file} does not state its rules`);
    }

    // `expert.py init`: refuses bad names/existing directories, and scaffolds a complete expert with git + compiled identity.
    const builder = join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py");
    const initEnv = {
      PATH: process.env.PATH ?? "",
      HOME: join(t.env.root, "expert-datas-paths"),
      EXPERT_TEMPLATE: join(t.openRoot, TEMPLATE),
      EXPERT_SPACEBUILDER: builder,
    };
    for (const badName of ["", "expert", "../escape", ".hidden"]) {
      const refused = spawnSync("python3", ["tools/expert.py", "init", badName, "--desc", "x"], { cwd: expert, env: initEnv, encoding: "utf8" });
      t.assertions.assert(refused.status !== 0 && refused.stderr.includes("不合法"), `init accepted bad name ${JSON.stringify(badName)}: ${refused.stdout}`);
    }
    const inited = spawnSync(
      "python3",
      ["tools/expert.py", "init", "game-qa", "--desc", "QA自动化专家", "--soul", "使用Playwright真实操作与截图核验"],
      { cwd: expert, env: initEnv, encoding: "utf8" },
    );
    t.assertions.assert(inited.status === 0 && inited.stdout.includes("已创建并初始化专家 game-qa"), `init game-qa: ${inited.stdout} ${inited.stderr}`);
    const qaDir = join(t.env.root, "expert-datas-paths", "game-qa");
    const dupInit = spawnSync("python3", ["tools/expert.py", "init", "game-qa", "--desc", "x"], { cwd: expert, env: initEnv, encoding: "utf8" });
    t.assertions.assert(dupInit.status !== 0 && dupInit.stderr.includes("已存在"), "duplicate init succeeded");
    const qaSoul = readFileSync(join(qaDir, "soul.md"), "utf8");
    t.assertions.assert(
      qaSoul.includes("我做的一切只有一个目的：让用户满意") && qaSoul.includes("使用Playwright真实操作与截图核验") && qaSoul.includes("（以下由反思会话按证据维护"),
      `qaSoul: ${qaSoul}`,
    );
    t.assertions.assert(existsSync(join(qaDir, ".git")) && existsSync(join(qaDir, "front", "AGENTS.md")) && existsSync(join(qaDir, "spaces", "leader", "AGENTS.md")), "qaDir git or compiled AGENTS.md missing");
  },
);

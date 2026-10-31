// An expert owns its soul.md and rewrites it while it reflects; Agents only see it through the AGENTS.md and
// CLAUDE.md that SpaceBuilder compiles from it. `tools/team.py sync-identity` (run by the timer hook) is what
// keeps the two in step. These cases run the real script on a copy of the expert template laid out as the
// daemon lays experts out (<data>/spaces/<name> next to <data>/builtin-skills), with no daemon and no model.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

const GENEHUB = "apps/daemon/builtin-skills/genehub";
const CODEX_LIMIT = 32 * 1024;

defineSpecialty(
  {
    id: "specialty.daemon.expert-identity-sync",
    title: "A changed soul.md is compiled into the front's AGENTS.md and CLAUDE.md once, and a failure keeps the old identity and says why",
    oracle:
      "the first sync builds and reports rebuilt, a second reports unchanged without rebuilding, a changed soul.md reaches both front/AGENTS.md and front/CLAUDE.md, a soul.md that pushes AGENTS.md past the Codex limit exits 1 with the SB019 text while the files keep the previous soul and the failing digest is not retried within the minute, a corrected soul.md is compiled at once, and a missing SpaceBuilder is an error that names the path",
    catches: [
      "an edited soul.md that new sessions never see",
      "a rebuild on every five-second tick",
      "a failed rebuild wiping the previous identity or failing silently",
      "a retry storm on a soul.md that cannot compile",
      "a missing builder reported as success",
    ],
    tags: ["core", "expert", "agent-space"],
    llm: { default: "none" },
    expectedDurationMs: 6_000,
    timeoutMs: 90_000,
    requiredArtifacts: [],
    resources: { environments: 1, cpu: 1 },
    surfaces: ["tools/team.py", "spacebuilder.py"],
    productInterfaces: ["tools/team.py", "spacebuilder.py"],
  },
  async (t) => {
    const data = join(t.env.root, "expert-identity-sync");
    const expert = join(data, "spaces", "expert");
    mkdirSync(join(data, "builtin-skills", "genehub", "references"), { recursive: true });
    symlinkSync(join(t.openRoot, GENEHUB, "references", "spacebuilder"), join(data, "builtin-skills", "genehub", "references", "spacebuilder"));
    cpSync(join(t.openRoot, GENEHUB, "references", "team-template"), expert, { recursive: true });

    const sync = (extraEnv: Record<string, string> = {}) =>
      spawnSync("python3", ["tools/team.py", "sync-identity"], {
        cwd: expert,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: data, ...extraEnv },
      });
    const soul = (text: string) => writeFileSync(join(expert, "soul.md"), text);
    const read = (file: string) => readFileSync(join(expert, file), "utf8");

    const timerFile = join(expert,"skills","team-front","hooks","timer.genet.json");
    const legacyTimer = {schema:"genet.hook.v1",event:"timer",every:"7s",exec:["${GENEHUB_PYTHON}","tools/expert.py","hook"],cwd:".",timeout:17};
    writeFileSync(timerFile,JSON.stringify(legacyTimer));
    soul("# 灵魂\n\n我叫小满。\n");
    const first = sync();
    t.assertions.assert(first.status === 0 && first.stdout.trim() === "rebuilt", `first sync: ${first.status} ${first.stdout} ${first.stderr}`);
    const migratedTimer = JSON.parse(readFileSync(timerFile,"utf8"));
    t.assertions.assert(migratedTimer.exec[1]==="tools/team.py"&&migratedTimer.every==="7s"&&migratedTimer.timeout===17,"legacy hook migration changed cadence or timeout");
    t.assertions.assert(readFileSync(join(expert,".genethub","team","hook-name-backups","team-front.json"),"utf8").includes("tools/expert.py"),"original timer was not backed up");

    for (const file of ["front/AGENTS.md", "front/CLAUDE.md"]) t.assertions.assert(read(file).includes("我叫小满"), `${file} lacks the soul`);

    const stamp = readFileSync(join(expert, "front/AGENTS.md")).length;
    const second = sync();
    t.assertions.assert(second.status === 0 && second.stdout.trim() === "unchanged", `second sync must not rebuild: ${second.stdout}`);
    t.assertions.assert(readFileSync(join(expert, "front/AGENTS.md")).length === stamp, "AGENTS.md changed without a new soul");

    soul("# 灵魂\n\n我叫小满，学会了先问再做。\n");
    const changed = sync();
    t.assertions.assert(changed.status === 0 && changed.stdout.trim() === "rebuilt", `changed sync: ${changed.stdout} ${changed.stderr}`);
    for (const file of ["front/AGENTS.md", "front/CLAUDE.md"]) t.assertions.assert(read(file).includes("先问再做"), `${file} did not pick up the change`);

    soul("字".repeat(CODEX_LIMIT));
    const failed = sync();
    t.assertions.assert(failed.status === 1 && failed.stderr.includes("SB019") && failed.stderr.includes("下一步"), `oversized soul: ${failed.status} ${failed.stderr}`);
    for (const file of ["front/AGENTS.md", "front/CLAUDE.md"]) t.assertions.assert(read(file).includes("先问再做"), `${file} lost the previous soul after a failed build`);
    const again = sync();
    t.assertions.assert(again.status === 0 && again.stdout.trim() === "unchanged", `a failing digest was retried inside the minute: ${again.status} ${again.stderr}`);

    soul("# 灵魂\n\n我叫小满，写短一点。\n");
    const fixed = sync();
    t.assertions.assert(fixed.status === 0 && fixed.stdout.trim() === "rebuilt" && read("front/CLAUDE.md").includes("写短一点"), `corrected soul: ${fixed.status} ${fixed.stderr}`);

    writeFileSync(join(expert, "memory.md"), "# 共同记忆\n\n用户在意简洁。\n");
    writeFileSync(join(expert, "spaces/research/index.md"), "# 调查经验索引\n\n- 先查本地仓库\n");
    const layered = sync();
    t.assertions.assert(layered.status === 0 && layered.stdout.trim() === "rebuilt", `layered sync: ${layered.status} ${layered.stderr}`);
    t.assertions.assert(read("front/AGENTS.md").includes("用户在意简洁") && read("spaces/research/AGENTS.md").includes("用户在意简洁") && read("spaces/research/AGENTS.md").includes("先查本地仓库"), "memory.md or index.md did not reach the compiled AGENTS.md");

    const customTimer={...legacyTimer,exec:["python3","tools/custom_timer.py","hook"]};
    writeFileSync(join(expert,"tools/custom_timer.py"),"print('custom')\n");
    writeFileSync(timerFile,JSON.stringify(customTimer));
    const custom=sync();
    t.assertions.assert(custom.status===0,"custom timer made identity upgrade fail");
    t.assertions.assert(JSON.stringify(JSON.parse(readFileSync(timerFile,"utf8")))===JSON.stringify(customTimer),"upgrade rewrote a custom timer command");

    const stranded = join(t.env.root, "expert-identity-sync-stranded");
    mkdirSync(join(stranded, "spaces"), { recursive: true });
    cpSync(expert, join(stranded, "spaces", "expert"), { recursive: true });
    const lonely = spawnSync("python3", ["tools/team.py", "sync-identity"], {
      cwd: join(stranded, "spaces", "expert"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: stranded },
    });
    writeFileSync(join(stranded, "spaces", "expert", "soul.md"), "# 灵魂\n\n另一个。\n");
    const missing = spawnSync("python3", ["tools/team.py", "sync-identity"], {
      cwd: join(stranded, "spaces", "expert"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: stranded },
    });
    t.assertions.assert(lonely.status === 0, `an unchanged soul needs no builder: ${lonely.stderr}`);
    t.assertions.assert(missing.status === 1 && missing.stderr.includes("找不到 SpaceBuilder") && missing.stderr.includes("builtin-skills"), `missing builder: ${missing.status} ${missing.stderr}`);
    t.assertions.assert(existsSync(join(stranded, "spaces", "expert", "front", "AGENTS.md")), "the previous AGENTS.md vanished");
  },
);

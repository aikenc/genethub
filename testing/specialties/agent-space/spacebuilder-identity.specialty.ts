// An expert's soul.md has to reach the Agent without the Agent being told to go and read it: Claude Code reads
// CLAUDE.md (and ignores AGENTS.md), Codex, Cursor and CodeBuddy read AGENTS.md. `identity` in agent-space.genet.json
// names the source file and SpaceBuilder compiles a full copy into each Agent's own instruction file. These cases
// run the shipped script on small Spaces; no daemon and no model are involved.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const SCRIPT = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";
const CODEX_LIMIT = 32 * 1024;

type Run = { code: number; report: { status: string; diagnostics: Array<{ code: string; message: string }> } };

function builder(t: CaseContext, root: string): (command: string) => Run {
  return (command) => {
    const result = spawnSync("python3", [path.join(t.openRoot, SCRIPT), command, root, "--format", "json"], { encoding: "utf8" });
    return { code: result.status ?? -1, report: JSON.parse(result.stdout) };
  };
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function space(root: string, agents: string[], extra: Record<string, unknown> = {}): void {
  write(
    path.join(root, "agent-space.genet.json"),
    JSON.stringify({ schema: "agent-space.v1", name: "soulful", agents, skills: [], tags: [], skillProviders: [], folders: [{ path: "." }], ...extra }),
  );
}

function identityCase(name: string, title: string, oracle: string, catches: string[], run: (t: CaseContext, root: string, build: (command: string) => Run) => void): void {
  defineSpecialty(
    {
      id: `specialty.agent-space.spacebuilder.identity.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent-space", "spacebuilder"],
      llm: { default: "none" },
      expectedDurationMs: 3_000,
      timeoutMs: 60_000,
      surfaces: ["spacebuilder"],
      productInterfaces: ["spacebuilder.py"],
    },
    async (t) => {
      const root = path.join(t.env.root, "soulful");
      run(t, root, builder(t, root));
    },
  );
}

const SOUL = "# 灵魂\n\n我叫小满，说话先说结论。\n";

identityCase(
  "compiles-a-full-copy-for-each-agent",
  "soul.md is compiled, in full and first, into AGENTS.md for Codex, Cursor and CodeBuddy and into CLAUDE.md for Claude Code, under agentCwd",
  "with all four Agents declared, front/AGENTS.md and front/CLAUDE.md each contain the whole soul text before any other section, CLAUDE.md has no import of AGENTS.md and none of the workspace folder rule, the Space root has neither file, a changed soul.md changes both after the next build, and verify passes before and after",
  [
    "Claude Code getting no identity because it never reads AGENTS.md",
    "CLAUDE.md written as an @AGENTS.md import that drags the other Agents' text into Claude's context",
    "the identity placed after other rules, or only a pointer to read soul.md",
    "the identity written at the Space root while Agents start in agentCwd",
  ],
  (t, root, build) => {
    space(root, ["codex", "cursor", "codebuddy", "claude-code"], { agentCwd: "front", identity: "soul.md" });
    write(path.join(root, "soul.md"), SOUL);
    const built = build("build");
    t.assertions.assert(built.code === 0 && built.report.status === "ok", `build: ${JSON.stringify(built.report.diagnostics)}`);
    t.assertions.assert(!existsSync(path.join(root, "AGENTS.md")) && !existsSync(path.join(root, "CLAUDE.md")), "instruction files written at the Space root");
    const agents = readFileSync(path.join(root, "front/AGENTS.md"), "utf8");
    const claude = readFileSync(path.join(root, "front/CLAUDE.md"), "utf8");
    for (const [label, text] of [["AGENTS.md", agents], ["CLAUDE.md", claude]] as const) {
      t.assertions.assert(text.includes(SOUL.trim()), `${label} lacks the whole soul text`);
    }
    t.assertions.assert(agents.indexOf("我叫小满") < agents.indexOf("Folders (declared order)"), "the identity is not ahead of the workspace rule in AGENTS.md");
    t.assertions.assert(!claude.includes("@AGENTS.md") && !claude.includes("Folders (declared order)"), "CLAUDE.md imports or repeats AGENTS.md content");
    t.assertions.assert(build("verify").code === 0, "verify after build");

    write(path.join(root, "soul.md"), SOUL + "新增一条：不确定时先问。\n");
    t.assertions.assert(build("build").code === 0, "rebuild after soul.md changed");
    for (const file of ["front/AGENTS.md", "front/CLAUDE.md"]) {
      t.assertions.assert(readFileSync(path.join(root, file), "utf8").includes("不确定时先问"), `${file} did not pick up the new soul`);
    }
    t.assertions.assert(build("verify").code === 0, "verify after rebuild");
  },
);

identityCase(
  "writes-only-the-file-each-agent-reads",
  "a Space that declares only Claude Code gets only CLAUDE.md, and one that declares no Claude Code gets only AGENTS.md; no identity key writes neither",
  "claude-code alone yields CLAUDE.md and no AGENTS.md, cursor+codebuddy yield AGENTS.md and no CLAUDE.md, and a Space without identity writes no instruction file with soul text",
  [
    "every Agent's file written regardless of what the Space declares",
    "a Space that does not declare identity picking up a stray soul.md",
  ],
  (t, root, build) => {
    write(path.join(root, "soul.md"), SOUL);
    space(root, ["claude-code"], { identity: "soul.md" });
    t.assertions.assert(build("build").code === 0, "claude-code build");
    t.assertions.assert(existsSync(path.join(root, "CLAUDE.md")) && !existsSync(path.join(root, "AGENTS.md")), "claude-code alone must write CLAUDE.md only");

    space(root, ["cursor", "codebuddy"], { identity: "soul.md" });
    t.assertions.assert(build("build").code === 0, "cursor+codebuddy build");
    t.assertions.assert(existsSync(path.join(root, "AGENTS.md")) && !existsSync(path.join(root, "CLAUDE.md")), "cursor+codebuddy must write AGENTS.md only, and the old CLAUDE.md must be removed");
    t.assertions.assert(readFileSync(path.join(root, "AGENTS.md"), "utf8").includes("我叫小满"), "AGENTS.md lacks the soul");

    space(root, ["cursor", "codebuddy"]);
    t.assertions.assert(build("build").code === 0, "build without identity");
    const without = existsSync(path.join(root, "AGENTS.md")) ? readFileSync(path.join(root, "AGENTS.md"), "utf8") : "";
    t.assertions.assert(!without.includes("我叫小满"), "a Space with no identity key still compiled soul.md");
  },
);

identityCase(
  "refuses-an-unusable-identity",
  "a missing, oversized, escaping or symlinked identity file is refused and nothing is written",
  "a missing file, a symlink, a file that makes Codex's AGENTS.md exceed 32 KiB, and a path with .. or an absolute path each fail the build (SB019 or SB001) without writing a lock; the same oversized text is accepted when Codex is not declared",
  [
    "Codex silently reading a truncated identity",
    "an identity path that escapes the Space",
    "a half-built tree after a refused identity",
  ],
  (t, root, build) => {
    const refused = (what: string, codes: string[]): void => {
      const result = build("build");
      t.assertions.assert(
        result.code !== 0 && result.report.diagnostics.some((item) => codes.includes(item.code)),
        `${what} was not refused: ${JSON.stringify(result.report)}`,
      );
      t.assertions.assert(!existsSync(path.join(root, ".spacebuilder", "lock.json")), `${what} left a lock`);
    };

    space(root, ["codex"], { identity: "soul.md" });
    refused("a missing identity file", ["SB019"]);

    write(path.join(root, "real.md"), SOUL);
    symlinkSync(path.join(root, "real.md"), path.join(root, "soul.md"));
    refused("a symlinked identity file", ["SB019"]);

    for (const bad of ["../soul.md", "/etc/hostname", ".spacebuilder/x.md"]) {
      space(root, ["codex"], { identity: bad });
      refused(`identity ${bad}`, ["SB001"]);
    }

    space(root, ["codex"], { identity: "big.md" });
    write(path.join(root, "big.md"), "字".repeat(CODEX_LIMIT / 3 + 100));
    refused("an identity that pushes AGENTS.md over the Codex limit", ["SB019"]);

    space(root, ["claude-code"], { identity: "big.md" });
    const accepted = build("build");
    t.assertions.assert(accepted.code === 0, `the same text must be accepted without Codex: ${JSON.stringify(accepted.report.diagnostics)}`);
  },
);

identityCase(
  "supports-an-identity-array-and-parent-references-within-the-top-space",
  "identity accepts an array of files, allows child Spaces to reference parent files within the top Space, and detects drift in verify",
  "a top Space with identity [soul.md, memory.md, front/style.md, front/index.md] and a child Space under spaces/reflect with [../../soul.md, ../../memory.md, style.md, index.md] compile the non-empty files in order, verify fails with SB017 when soul.md is edited without rebuilding, and a child path that escapes above the top Space fails with SB001",
  [
    "child Spaces forced to maintain mirror copies because .. is forbidden even inside the same expert",
    "verify passing after an identity source file was edited without rebuilding",
    "a child Space escaping above the enclosing top Space",
  ],
  (t, root, build) => {
    write(path.join(root, "soul.md"), SOUL);
    write(path.join(root, "memory.md"), "# 记忆\n\n用户喜欢简洁。\n");
    write(path.join(root, "front/style.md"), "# 风格\n\n前台风格。\n");
    write(path.join(root, "front/index.md"), "\n");
    space(root, ["codex", "claude-code"], {
      spaceBuilder: "tools/spacebuilder.py",
      agentCwd: "front",
      identity: ["soul.md", "memory.md", "front/style.md", "front/index.md"],
      children: { scanDepth: 2 },
    });
    const reflect = path.join(root, "spaces", "reflect");
    write(path.join(reflect, "style.md"), "# 风格\n\n反思风格。\n");
    write(path.join(reflect, "index.md"), "# 索引\n\n- 经验一\n");
    space(reflect, ["codex", "claude-code"], {
      identity: ["../../soul.md", "../../memory.md", "style.md", "index.md"],
    });

    const built = build("build");
    t.assertions.assert(built.code === 0 && built.report.status === "ok", `build array identity: ${JSON.stringify(built.report.diagnostics)}`);
    const frontAgents = readFileSync(path.join(root, "front/AGENTS.md"), "utf8");
    t.assertions.assert(
      frontAgents.indexOf("我叫小满") < frontAgents.indexOf("用户喜欢简洁") && frontAgents.indexOf("用户喜欢简洁") < frontAgents.indexOf("前台风格"),
      "front/AGENTS.md did not concatenate identity files in order",
    );
    const reflectAgents = readFileSync(path.join(reflect, "AGENTS.md"), "utf8");
    t.assertions.assert(
      reflectAgents.includes("我叫小满") && reflectAgents.includes("用户喜欢简洁") && reflectAgents.includes("反思风格") && reflectAgents.includes("经验一"),
      "spaces/reflect/AGENTS.md lacks parent or local identity parts",
    );
    t.assertions.assert(build("verify").code === 0, "verify right after build");

    write(path.join(root, "soul.md"), SOUL + "漂移测试。\n");
    const drifted = build("verify");
    t.assertions.assert(
      drifted.code !== 0 && drifted.report.diagnostics.some((item) => item.code === "SB017"),
      `verify did not report SB017 after soul.md changed: ${JSON.stringify(drifted.report.diagnostics)}`,
    );

    space(reflect, ["codex"], { identity: ["../../../outside.md"] });
    const escaped = build("build");
    t.assertions.assert(
      escaped.code !== 0 && escaped.report.diagnostics.some((item) => item.code === "SB001"),
      `child escaping top Space was not refused: ${JSON.stringify(escaped.report.diagnostics)}`,
    );
  },
);

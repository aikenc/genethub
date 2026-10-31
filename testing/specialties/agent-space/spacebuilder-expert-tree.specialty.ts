// SpaceBuilder is a Python script that turns Space descriptors and Skills into the files Agents read. These
// cases run the shipped script (the one the daemon materializes under builtin-skills/genehub/references)
// on a tree shaped like an expert: a root whose `agentCwd` is front/, and think and work children.
// No daemon and no model are involved; the script is the unit under test.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const SCRIPT = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";

type Run = { code: number; report: { status: string; summary?: Record<string, number>; diagnostics: Array<{ code: string; message: string }> } };

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

function space(dir: string, name: string, skills: string[], extra: Record<string, unknown> = {}): void {
  write(
    path.join(dir, "agent-space.genet.json"),
    JSON.stringify({ schema: "agent-space.v1", name, agents: ["codex"], skills, tags: [], skillProviders: [], folders: [{ path: "." }], ...extra }),
  );
  for (const skill of skills) {
    write(path.join(dir, ".spacebuilder", "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} skill used by the tests\n---\n\n# ${skill}\n`);
  }
}

/** Every file below `dir`, relative, excluding the Space's own sources. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

function expertTree(t: CaseContext): string {
  const root = path.join(t.env.root, "admin");
  space(root, "admin", ["core"], { agentCwd: "front", children: { scanDepth: 2 } });
  space(path.join(root, "spaces", "think"), "think", ["thinker"]);
  space(path.join(root, "spaces", "work"), "work", ["worker"]);
  write(
    path.join(root, ".spacebuilder", "skills", "core", "hooks", "tick.genet.json"),
    JSON.stringify({ event: "timer", every: "5s", exec: ["python3", "tools/team.py", "hook"] }),
  );
  return root;
}

function treeCase(name: string, title: string, oracle: string, catches: string[], run: (t: CaseContext, root: string, build: (command: string) => Run) => void): void {
  defineSpecialty(
    {
      id: `specialty.agent-space.spacebuilder.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent-space", "spacebuilder"],
      llm: { default: "none" },
      expectedDurationMs: 4_000,
      timeoutMs: 60_000,
      surfaces: ["spacebuilder"],
      productInterfaces: ["spacebuilder.py"],
    },
    async (t) => {
      const root = expertTree(t);
      run(t, root, builder(t, root));
    },
  );
}

treeCase(
  "agent-cwd-and-hooks",
  "rules and Skills go to agentCwd, a Skill's hooks become the Space's hook files, and the root stays clean",
  "after build the root has no AGENTS.md or .agents, front/ and each child have their own, no Agent Skill copy contains hooks/, the hook is written to .genethub/hooks with its owner, a ${VAR} or missing folder is skipped without a .code-workspace, and verify passes",
  [
    "rules generated at the Space root, so think and work read the front desk's rules",
    "a Skill's hooks/ directory copied into every Agent's Skill folder",
    "a hook file with no owner, or one not covered by the ownership lock",
    "a build that needs a .code-workspace although the descriptor lists its folders",
  ],
  (t, root, build) => {
    // Unusable entries in `folders` are skipped, not an error.
    const descriptor = JSON.parse(readFileSync(path.join(root, "agent-space.genet.json"), "utf8"));
    descriptor.folders = [{ path: "." }, { path: "${HOME}/elsewhere" }, { path: "missing" }];
    writeFileSync(path.join(root, "agent-space.genet.json"), JSON.stringify(descriptor));
    const built = build("build");
    t.assertions.assert(built.code === 0 && built.report.status === "ok", `build: ${JSON.stringify(built.report.diagnostics)}`);
    const generated = files(root).filter((file) => !file.startsWith(".spacebuilder/skills/") && !file.includes("/.spacebuilder/skills/") && !file.endsWith("agent-space.genet.json"));
    t.assertions.assert(!existsSync(path.join(root, "AGENTS.md")) && !existsSync(path.join(root, ".agents")), `root has rules: ${generated}`);
    for (const dir of ["front", "spaces/think", "spaces/work"]) {
      t.assertions.assert(existsSync(path.join(root, dir, "AGENTS.md")), `${dir}/AGENTS.md missing`);
    }
    t.assertions.assert(existsSync(path.join(root, "front/.agents/skills/core/SKILL.md")), "the root Skill is not under front/");
    t.assertions.assert(!generated.some((file) => file.includes("/hooks/") && file.includes(".agents/")), `hooks/ copied into an Agent Skill: ${generated}`);
    const hook = JSON.parse(readFileSync(path.join(root, ".genethub/hooks/core.tick.genet.json"), "utf8"));
    t.assertions.assert(hook.owner === "spacebuilder:core/tick" && hook.event === "timer" && hook.schema === "genet.hook.v1" && hook.cwd === ".", `hook ${JSON.stringify(hook)}`);
    t.assertions.assert(!files(root).some((file) => file.endsWith(".code-workspace")), "a .code-workspace was written");
    const verified = build("verify");
    t.assertions.assert(verified.code === 0 && verified.report.status === "ok", `verify: ${JSON.stringify(verified.report.diagnostics)}`);
  },
);

treeCase(
  "drift-and-clean",
  "verify reports a changed rule or hook file, build repairs it, and clean removes only what the Builder wrote",
  "an edit to front/AGENTS.md and to the generated hook are each reported as drifted; a second build restores both and verify passes; clean removes every generated file and leaves the descriptors and Skill sources",
  [
    "a hand-edited hook file that nothing notices",
    "clean leaving generated files behind, or deleting a Skill source",
  ],
  (t, root, build) => {
    t.assertions.assert(build("build").code === 0, "build failed");
    const sources = files(root).filter((file) => file.endsWith("agent-space.genet.json") || file.includes(".spacebuilder/skills/"));
    for (const target of ["front/AGENTS.md", ".genethub/hooks/core.tick.genet.json"]) {
      const file = path.join(root, target);
      const original = readFileSync(file);
      writeFileSync(file, "tampered\n");
      const drifted = build("verify");
      t.assertions.assert(
        drifted.code !== 0 && drifted.report.diagnostics.some((item) => item.message.includes("drifted") && item.message.includes(path.basename(target))),
        `${target} drift not reported: ${JSON.stringify(drifted.report.diagnostics)}`,
      );
      t.assertions.assert(build("build").code === 0 && readFileSync(file).equals(original), `${target} not repaired by build`);
      t.assertions.assert(build("verify").code === 0, `verify after repairing ${target}`);
    }
    const cleaned = build("clean");
    t.assertions.assert(cleaned.code === 0, `clean: ${JSON.stringify(cleaned.report.diagnostics)}`);
    const left = files(root);
    t.assertions.assert(JSON.stringify(left) === JSON.stringify(sources), `clean left ${JSON.stringify(left)}; expected only ${JSON.stringify(sources)}`);
    t.assertions.assert(!existsSync(path.join(root, "front")) || statSync(path.join(root, "front")).isDirectory(), "front/ is not a directory");
  },
);

treeCase(
  "refuses-an-unsafe-agent-cwd",
  "agentCwd that escapes the Space or names its own bookkeeping is refused at check time",
  "an absolute path, a path with .., and .spacebuilder each fail check with SB001 and nothing is written",
  ["generated rules written outside the Space through a crafted agentCwd"],
  (t, root, build) => {
    for (const bad of ["/etc", "../elsewhere", "a/../../b", ".spacebuilder", ".genethub/x", "."]) {
      const descriptor = JSON.parse(readFileSync(path.join(root, "agent-space.genet.json"), "utf8"));
      descriptor.agentCwd = bad;
      writeFileSync(path.join(root, "agent-space.genet.json"), JSON.stringify(descriptor));
      const checked = build("build");
      t.assertions.assert(
        checked.code !== 0 && checked.report.diagnostics.some((item) => item.code === "SB001" && item.message.includes("agentCwd")),
        `agentCwd ${JSON.stringify(bad)} was accepted: ${JSON.stringify(checked.report)}`,
      );
      t.assertions.assert(!existsSync(path.join(root, ".spacebuilder", "lock.json")), `agentCwd ${bad} wrote a lock`);
    }
  },
);

treeCase(
  "a-space-may-be-named-in-any-language",
  "a Space's name is for people, so a non-ASCII name builds and verifies, and an unsafe one is refused",
  "a root named 办公室-Mac 管理员 builds, verifies and cleans; a name with a slash, a backslash, a newline, or longer than 64 characters fails with SB002",
  [
    "the built-in administrator, named after the machine, failing to build",
    "a name that cannot be put safely in a path or a line being accepted",
  ],
  (t, root, build) => {
    const rename = (name: string): void => {
      const descriptor = JSON.parse(readFileSync(path.join(root, "agent-space.genet.json"), "utf8"));
      descriptor.name = name;
      writeFileSync(path.join(root, "agent-space.genet.json"), JSON.stringify(descriptor));
    };
    rename("办公室-Mac 管理员");
    const built = build("build");
    t.assertions.assert(built.code === 0, `build with a Chinese name: ${JSON.stringify(built.report.diagnostics)}`);
    t.assertions.assert(build("verify").code === 0, "verify with a Chinese name");
    t.assertions.assert(build("clean").code === 0, "clean with a Chinese name");
    for (const bad of ["a/b", "a\\b", "a\nb", "x".repeat(65), " padded"]) {
      rename(bad);
      const refused = build("build");
      t.assertions.assert(
        refused.code !== 0 && refused.report.diagnostics.some((item) => item.code === "SB002"),
        `name ${JSON.stringify(bad)} was accepted: ${JSON.stringify(refused.report)}`,
      );
    }
  },
);

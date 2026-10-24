import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const SCRIPT = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";
type Report = { status: string; diagnostics: Array<{ code: string; message: string }> };

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function space(root: string, extra: Record<string, unknown> = {}): void {
  write(path.join(root, "agent-space.genet.json"), JSON.stringify({ schema: "agent-space.v1", name: path.basename(root),
    agents: ["codex"], skills: [], tags: [], skillProviders: [], folders: [{ path: "." }], ...extra }));
}

function invoke(t: CaseContext, command: string, root: string, ...args: string[]): { code: number; report: Report } {
  const result = spawnSync(process.env.GENEHUB_PYTHON!, [path.join(t.openRoot, SCRIPT), command, root, ...args, "--format", "json"],
    { encoding: "utf8", timeout: 30_000 });
  return { code: result.status ?? -1, report: JSON.parse(result.stdout) as Report };
}

function scenario(name: string, oracle: string, catches: string[], run: (t: CaseContext, source: string, output: string) => void): void {
  defineSpecialty({ id: `specialty.agent-space.spacebuilder.output.${name}`, title: `Portable Space build: ${name}`, oracle, catches,
    tags: ["core", "agent-space", "spacebuilder", "spacebuilder-output"], llm: { default: "none" },
    expectedDurationMs: 3_000, timeoutMs: 60_000, surfaces: ["spacebuilder"], productInterfaces: ["spacebuilder.py"],
    requiredArtifacts: [],
    requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }] },
  async (t) => run(t, path.join(t.env.root, "source"), path.join(t.env.root, "artifact")));
}

scenario("relocate-without-source", "Compiled identity and Skill survive deletion of the source; explicit artifact verification succeeds at a new root, source verification cannot silently downgrade, and target-only folders/variables remain declared.",
  ["build-machine paths leaked into instructions", "missing target folders omitted", "remote verification requires source providers", "agentCwd base is wrong"],
  (t, source, output) => {
    space(source, { agents: ["codex", "claude-code"], agentCwd: "front/ui", identity: "soul.md",
      folders: [{ path: "." }, { name: "project", path: "../../projects/qa" }, { name: "worktree", path: "${WORKTREE_DIR}" }] });
    write(path.join(source, "soul.md"), "# Identity\n\nQA checks the final result.\n");
    write(path.join(source, ".spacebuilder/skills/review/SKILL.md"), "---\nname: review\ndescription: Review the delivered output\n---\n# Review\n");
    const built = invoke(t, "build", source, "--output", output);
    t.assertions.assert(built.code === 0, JSON.stringify(built.report));
    t.assertions.assert(!existsSync(path.join(source, "front/ui/AGENTS.md")) && !existsSync(path.join(source, ".spacebuilder/lock.json")), "output build changed source-owned generated files");
    const instructions = readFileSync(path.join(output, "front/ui/AGENTS.md"), "utf8");
    t.assertions.assert(instructions.includes("QA checks the final result") && instructions.includes("../../projects/qa") && instructions.includes("${WORKTREE_DIR}") && instructions.includes("`../..`"), "identity, target folder or Space-root base was lost");
    t.assertions.assert(!instructions.includes(source) && !instructions.includes(output), "absolute build paths embedded");
    t.assertions.assert(instructions.includes("source Space owner") && instructions.includes("verify --artifacts-only") && !instructions.includes("Edit `.spacebuilder/agents`"), "artifact instructs remote Agents to edit build sources");
    const input = JSON.parse(readFileSync(path.join(source, "agent-space.genet.json"), "utf8"));
    write(path.join(source, "source.code-workspace"), JSON.stringify({ folders: input.folders }));
    delete input.folders; writeFileSync(path.join(source, "agent-space.genet.json"), JSON.stringify(input));
    t.assertions.assert(invoke(t, "build", source, "--output", output).code === 0, "code-workspace input cannot export");
    const exported = readFileSync(path.join(output, "front/ui/AGENTS.md"), "utf8");
    t.assertions.assert(exported.includes("Workspace: `agent-space.genet.json`") && !exported.includes("Workspace: `source.code-workspace`"), "portable rules point at a source-only workspace file");
    t.assertions.assert(existsSync(path.join(output, "front/ui/.agents/skills/review/SKILL.md")), "selected Skill missing");
    const descriptor = JSON.parse(readFileSync(path.join(output, "agent-space.genet.json"), "utf8"));
    t.assertions.assert(!descriptor.identity && !descriptor.buildHooks && descriptor.skillProviders.length === 0, "runtime descriptor still requires build sources");
    const moved = path.join(t.env.root, "target-machine", "qa"); mkdirSync(path.dirname(moved)); renameSync(output, moved); rmSync(source, { recursive: true });
    t.assertions.assert(invoke(t, "verify", moved, "--artifacts-only").code === 0, "artifact cannot verify after moving and deleting source");
    t.assertions.assert(invoke(t, "verify", moved).code !== 0, "source verify silently downgraded");
    write(path.join(moved, "front/ui/AGENTS.md"), "tampered");
    const tampered = invoke(t, "verify", moved, "--artifacts-only");
    t.assertions.assert(tampered.code !== 0 && tampered.report.diagnostics.some((d) => d.code === "SB017"), "tampered instructions accepted");
  });

scenario("tree-hook-order-and-in-place", "Pre prepares identity before planning; both output and in-place builds run child post before root post only after all artifacts exist; native interpreter argv is used and each mode verifies.",
  ["pre runs after planning", "root post publishes incomplete child tree", "hook python depends on PATH", "new hooks break original in-place verification"],
  (t, source, output) => {
    const pre = "from pathlib import Path; Path('soul.md').write_text('QA identity')";
    const post = "from pathlib import Path; import sys; p=Path(sys.argv[1]); assert (p/'spaces/qa/AGENTS.md').is_file(); assert (p/'child-post').is_file(); (p/'root-post').write_text(sys.executable)";
    space(source, { identity: "soul.md", buildHooks: { pre: [{ args: ["{python}", "-c", pre] }], post: [{ args: ["{python}", "-c", post, "{outputRoot}"] }] } });
    const child = path.join(source, "spaces/qa");
    space(child, { buildHooks: { post: [{ args: ["{python}", "-c", "from pathlib import Path; import sys; (Path(sys.argv[1])/'../../child-post').resolve().write_text('complete')", "{outputRoot}"] }] } });
    for (const args of [["--output", output], []]) {
      const result = invoke(t, "build", source, ...args);
      t.assertions.assert(result.code === 0, JSON.stringify(result.report));
      const target = args.length ? output : source;
      t.assertions.assert(existsSync(path.join(target, "root-post")), "root post did not finish");
      t.assertions.assert(invoke(t, "verify", target, ...(args.length ? ["--artifacts-only"] : [])).code === 0, "build cannot verify");
    }
  });

scenario("no-execution-on-planning-or-command-refusal", "Planning never invokes hooks; the fail-closed flag rejects pre/post before Provider build can create an external marker.",
  ["dry-run or check runs hook", "command guard happens after provider side effects"],
  (t, source, output) => {
    space(source, { buildHooks: { pre: [{ args: ["{python}", "-c", "from pathlib import Path; Path('hook-ran').write_text('bad')"] }] } });
    for (const command of ["check", "explain"]) t.assertions.assert(invoke(t, command, source).code === 0, command);
    t.assertions.assert(invoke(t, "build", source, "--output", output, "--dry-run").code === 0, "dry-run");
    t.assertions.assert(!existsSync(path.join(source, "hook-ran")) && !existsSync(output), "planning ran hooks or created output");
    const provider = path.join(t.env.root, "provider"); mkdirSync(provider);
    const marker = path.join(provider, "builder-ran");
    space(source, { skillProviders: [{ type: "folder", path: "../provider", build: { args: [process.env.GENEHUB_PYTHON!, "-c", `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('bad')`], output: "dist" } }],
      buildHooks: { post: [{ args: ["{python}", "-c", "raise SystemExit(0)"] }] } });
    const refused = invoke(t, "build", source, "--output", output, "--require-no-post-commands");
    t.assertions.assert(refused.code !== 0 && refused.report.diagnostics.some((d) => d.code === "SB018"), JSON.stringify(refused.report));
    t.assertions.assert(!existsSync(marker) && !existsSync(output), "guard allowed side effects");
  });

scenario("ownership-and-stale-removal", "Repeated output builds remove obsolete owned agent files while preserving user files and original source artifacts; a fresh output refuses an unowned conflicting target.",
  ["stale AGENTS.md left after agent change", "output cleanup deletes unrelated user files", "output adopts Human-owned files"],
  (t, source, output) => {
    space(source, { identity: "soul.md" }); write(path.join(source, "soul.md"), "Owned identity");
    t.assertions.assert(invoke(t, "build", source).code === 0, "original build");
    const original = readFileSync(path.join(source, "AGENTS.md"), "utf8");
    t.assertions.assert(invoke(t, "build", source, "--output", output).code === 0, "first output build");
    write(path.join(output, "user.txt"), "keep");
    space(source, { agents: ["claude-code"], identity: "soul.md" });
    t.assertions.assert(invoke(t, "build", source, "--output", output).code === 0, "rebuild");
    t.assertions.assert(!existsSync(path.join(output, "AGENTS.md")) && existsSync(path.join(output, "CLAUDE.md")), "obsolete agent output remains");
    t.assertions.assert(readFileSync(path.join(output, "user.txt"), "utf8") === "keep" && readFileSync(path.join(source, "AGENTS.md"), "utf8") === original, "unowned/source content changed");
    const fresh = path.join(t.env.root, "conflict"); write(path.join(fresh, "CLAUDE.md"), "user instructions");
    t.assertions.assert(invoke(t, "build", source, "--output", fresh).code !== 0 && readFileSync(path.join(fresh, "CLAUDE.md"), "utf8") === "user instructions", "unowned target overwritten");
    space(source, { agents: ["claude-code"], agentCwd: "empty" });
    t.assertions.assert(invoke(t, "build", source, "--output", output).code === 0, "empty agentCwd build");
    t.assertions.assert(existsSync(path.join(output, "empty")) && invoke(t, "verify", output, "--artifacts-only").code === 0, "runtime agentCwd was not created");
  });

scenario("hook-failure-and-unsafe-targets", "Pre failure prevents generation, post failure reports failure, and output overlap or symlink cannot overwrite source/user data.",
  ["hook failure returns success", "unsafe independent output overwrites inputs"],
  (t, source, output) => {
    space(source, { buildHooks: { pre: [{ args: ["{python}", "-c", "raise SystemExit(7)"] }] } });
    t.assertions.assert(invoke(t, "build", source, "--output", output).code !== 0 && !existsSync(path.join(output, ".spacebuilder/output-lock.json")), "pre failure generated a successful artifact");
    space(source, { buildHooks: { post: [{ args: ["{python}", "-c", "raise SystemExit(9)"] }] } });
    const failed = invoke(t, "build", source, "--output", output);
    t.assertions.assert(failed.code !== 0 && failed.report.diagnostics.some((d) => d.code === "SB016"), "post failure hidden");
    space(source);
    for (const unsafe of [source, path.join(source, "output"), path.dirname(source)]) t.assertions.assert(invoke(t, "build", source, "--output", unsafe).code !== 0, `overlap ${unsafe} accepted`);
    const alias = path.join(t.env.root, "alias"); symlinkSync(output, alias);
    t.assertions.assert(invoke(t, "build", source, "--output", alias).code !== 0, "symlink output accepted");
  });

scenario("receipt-cannot-claim-arbitrary-files", "Corrupt receipts are refused with structured diagnostics before cleanup can remove a user file; an escaping artifact target never reaches the filesystem.",
  ["malformed lock causes a traceback", "forged output receipt claims unowned data", "cleanup follows an escaping path"],
  (t, source, output) => {
    space(source);
    t.assertions.assert(invoke(t, "build", source, "--output", output).code === 0, "build");
    const lock = path.join(output, ".spacebuilder/output-lock.json");
    const original = readFileSync(lock, "utf8");
    write(path.join(output, "user.txt"), "keep");
    for (const patch of [{ logicalType: [] }, { target: "user.txt", logicalType: "project-instructions" }, { target: "../../outside", logicalType: "project-instructions" }]) {
      const receipt = JSON.parse(original); Object.assign(receipt.artifacts[0], patch); writeFileSync(lock, JSON.stringify(receipt));
      const refused = invoke(t, "build", source, "--output", output);
      t.assertions.assert(refused.code !== 0 && refused.report.status === "error", "invalid receipt accepted or unstructured failure");
      t.assertions.assert(readFileSync(path.join(output, "user.txt"), "utf8") === "keep", "receipt deleted user file");
    }
  });

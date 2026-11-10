import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

// A reflection candidate is a real portable build, subsequently relocated below its
// definition source. Its output lock, files and child roles remain execution artifacts.
defineSpecialty({
  id: "specialty.daemon.spacebuilder-discovery.nested-portable-output",
  title: "Definition discovery excludes nested portable runtimes while preserving sources and ownership guards",
  tags: ["core", "spacebuilder", "team-classes"], llm: { default: "none" },
  expectedDurationMs: 2000, timeoutMs: 60000,
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  surfaces: ["spacebuilder", "filesystem"], productInterfaces: ["spacebuilder.py"], requiredArtifacts: [],
  oracle: "Public build/explain sees ordinary definitions but never relocated runtime descendants; runtime bytes are unchanged and independently verifiable; real unowned AGENTS and explicit runtime builds still reject.",
  catches: ["temporary execution artifact scanned as definition causes SB010", "all temporary definitions skipped", "source build rewrites nested runtime", "ownership conflict guard weakened"],
}, async t => {
  const source = join(t.env.root, "source"), external = join(t.env.root, "runtime-output");
  const nested = join(source, "temp", "reflect-candidate-artifact");
  const template = join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template");
  const builder = join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py");
  cpSync(template, source, { recursive: true });
  const invoke = (args: string[]) => {
    const result = spawnSync(process.env.GENEHUB_PYTHON!, [builder, ...args, "--format", "json"], { encoding: "utf8" });
    t.assertions.assert(!result.error && !result.signal, String(result.error ?? result.signal));
    return { code: result.status, report: JSON.parse(result.stdout) };
  };
  const built = invoke(["build", source, "--output", external]);
  t.assertions.assert(built.code === 0 && built.report.status === "ok", JSON.stringify(built.report));
  mkdirSync(dirname(nested), { recursive: true }); renameSync(external, nested);
  const snapshot = (root: string): Record<string, string> => {
    const files: Record<string, string> = {};
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__pycache__") continue;
        const file = join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (entry.isFile()) files[relative(root, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
      }
    };
    scan(root); return Object.fromEntries(Object.entries(files).sort());
  };
  const before = snapshot(nested);
  const descriptor = JSON.parse(readFileSync(join(source, "agent-space.genet.json"), "utf8"));
  const ordinary = join(source, "temp", "ordinary-child"); mkdirSync(ordinary);
  const child = { ...descriptor, name: "ordinary-child", folders: [{ path: "." }],
    skills: [], skillProviders: [], identity: ["identity.md"], tags: [], children: { scanDepth: 0 } };
  delete child.agentCwd;
  writeFileSync(join(ordinary, "agent-space.genet.json"), JSON.stringify(child));
  writeFileSync(join(ordinary, "identity.md"), "Ordinary definition source.\n");
  for (const command of ["explain", "build"]) {
    const result = invoke([command, source]);
    t.assertions.assert(result.code === 0 && result.report.status === "ok", JSON.stringify(result.report));
    t.assertions.assert(result.report.summary.members === built.report.summary.members + 1,
      "ordinary child was lost or runtime descendants were treated as definition sources");
  }
  const verified = invoke(["verify", nested, "--artifacts-only"]);
  t.assertions.assert(verified.code === 0 && verified.report.status === "ok", JSON.stringify(verified.report));
  const inPlace = invoke(["build", nested]);
  t.assertions.assert(inPlace.code !== 0 && inPlace.report.status === "error", "execution runtime was rebuilt as a source");
  t.assertions.assert(JSON.stringify(snapshot(nested)) === JSON.stringify(before), "parent discovery or rejected in-place build changed runtime bytes");
  const unowned = join(source, "temp", "unowned-child"); mkdirSync(unowned);
  writeFileSync(join(unowned, "agent-space.genet.json"), JSON.stringify({ ...child, name: "unowned-child" }));
  writeFileSync(join(unowned, "identity.md"), "User identity.\n");
  const userFile = join(unowned, "AGENTS.md"), content = "User-authored file; retain it.\n";
  writeFileSync(userFile, content);
  const conflict = invoke(["explain", source]);
  t.assertions.assert(conflict.code !== 0 && conflict.report.diagnostics.some((d: { code: string }) => d.code === "SB010"),
    "real unowned AGENTS file was silently adopted");
  t.assertions.assert(readFileSync(userFile, "utf8") === content, "user file was overwritten");
});

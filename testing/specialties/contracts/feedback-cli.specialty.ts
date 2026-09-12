import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.feedback-cli",
  title: "CLI feedback selection, early dependency blocking, progress and safe resume",
  oracle: "Real CLI processes on isolated Git fixtures: no work before failed preflight, live inspection, exact-input passed reuse, failure and drift rejection",
  catches: ["601 cases selected for a narrow feedback", "late Python prerequisite failure", "inspect unavailable until completion", "rerun turns a failure green", "reused stale input"],
  tags: ["core", "contract", "feedback-tooling"], expectedDurationMs: 20000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 1 }, surfaces: ["testctl", "git", "os-process"],
}, async t => {
  const repo = join(t.env.root, "cli-repo"), space = join(t.env.root, "cli-space");
  for (const dir of [repo, space]) {
    mkdirSync(dir); execFileSync("git", ["init", dir], { stdio: "ignore" });
    writeFileSync(join(dir, ".gitignore"), "target/\nruns/\n");
  }
  mkdirSync(join(repo, "testing")); mkdirSync(join(repo, "target", "iterate"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"type":"module"}');
  const artifact = join(repo, "target", "iterate", "genet-local");
  writeFileSync(artifact, "artifact-one");
  const marker = (name: string) => join(repo, "target", name);
  const file = join(repo, "testing", "probe.specialty.ts");
  writeFileSync(file, `import {defineSpecialty,BlockedError} from ${JSON.stringify(pathToFileURL(join(t.openRoot, "testing/framework/public.ts")).href)};
    import {appendFileSync,existsSync} from 'node:fs';
    const meta={title:'CLI fixture',oracle:'observable marker',catches:[],tags:['fixture'],expectedDurationMs:10,timeoutMs:10000,surfaces:['fixture']};
    for(const name of ['passed','blocked','failed','slow','python','timeout']) defineSpecialty({...meta,id:'fixture.'+name,
      ...(name==='timeout'?{timeoutMs:100}:{}),
      ...(name==='python'?{requirements:[{kind:'python',env:'TESTCTL_FIXTURE_PYTHON',minVersion:[3,0],modules:['json']}]}:{})},async()=>{
      if(name==='slow'||name==='timeout') await new Promise(r=>setTimeout(r,2000));
      if(name==='blocked'&&!existsSync(${JSON.stringify(marker("ready"))})) throw new BlockedError('fixture service unavailable');
      if(name==='failed') throw new Error('intentional assertion failure');
      appendFileSync(${JSON.stringify(marker("executions"))},name+'\\n');
    });
    for(let i=0;i<300;i++) defineSpecialty({...meta,id:'fixture.catalog'+i},async()=>{});`);
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { stdio: "ignore" });
  const require = createRequire(import.meta.url);
  const prefix = ["--import", pathToFileURL(require.resolve("tsx")).href, join(t.openRoot, "testing/bin/testctl.ts")];
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("TESTCTL_REQUIRE_") || ["GENET_E2E_DAEMON", "GENEHUB_HOST", "GENEHUB_LOCAL_COMPONENT", "GENEHUB_LOCAL_DAEMON_COMPONENT", "GENET_APP_WASM", "TESTCTL_FIXTURE_PYTHON"].includes(key)) delete env[key];
  const cli = (args: string[], overrides: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; out: string; err: string }>(resolve => {
    execFile(process.execPath, [...prefix, ...args], { cwd: repo, env: { ...env, ...overrides }, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
      (error, out, err) => resolve({ code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code) || 1 : 0, out, err }));
  });
  const runArgs = (ids: string[]) => ["run", "--space", space, "--open", repo, "--gate", "dev-feedback", "--topic", "fixture", "--environments", "1", "--reason", "CLI fixture behavior", ...ids.flatMap(id => ["--case", `fixture.${id}`])];
  const directory = (out: string) => out.trim().split("\n")[0]!;
  const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const assert = t.assertions.assert;

  assert((await cli(["plan", "--open", repo, "--gate", "dev-feedback"])).code !== 0, "implicit feedback scope accepted");
  assert((await cli(["plan", "--open", repo, "--gate", "typo"])).code !== 0, "unknown gate accepted");
  assert((await cli(["plan", "--open", repo, "--case", "missing"])).code !== 0, "unknown case accepted");
  const large = await cli(["plan", "--open", repo, "--gate", "dev-feedback", "--tags", "fixture", "--reason", "catalog output fixture"]);
  assert(large.code === 0 && large.out.length > 8192 && JSON.parse(large.out).units.length === 306, "large plan JSON was truncated in pipe");
  const missingDocs = await cli(["governance", "check", "--open", repo]);
  assert(missingDocs.code !== 0 && JSON.parse(missingDocs.out).findings.length > 0, "missing governance documents reported success");
  const blocked = await cli(runArgs(["passed", "python"]));
  assert(blocked.code !== 0 && blocked.err.includes("blocked before execution"), `prerequisite did not block early: ${blocked.err}`);
  assert(!existsSync(marker("executions")), "a test ran despite failed dependency preflight");
  assert(manifest(directory(blocked.out)).counts.blocked === 2, "unstarted cases were misreported as pass");
  const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
  const repaired = await cli(runArgs(["python"]), { TESTCTL_FIXTURE_PYTHON: python });
  assert(repaired.code === 0 && manifest(directory(repaired.out)).preflight.checked === 1, `repaired preflight failed: ${repaired.err}`);

  // inspect must return a useful record before manifest.json exists.
  const before = new Set(readdirSync(join(space, "runs")));
  const child = spawn(process.execPath, [...prefix, ...runArgs(["slow"])], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  let live = "";
  try {
    await t.tools.waitUntil(async () => {
      const name = readdirSync(join(space, "runs")).find(name => !before.has(name));
      if (!name) return false;
      live = join(space, "runs", name);
      const progress = join(live, "progress.json");
      return existsSync(progress) && JSON.parse(readFileSync(progress, "utf8")).active.length > 0;
    }, 10000);
    const inspected = await cli(["inspect", "--run", live]);
    const view = JSON.parse(inspected.out);
    assert(inspected.code === 0 && !view.finalized && view.qualification === null && view.progress.active.length === 1, "live inspect invented final evidence or omitted active case");
    assert(await exited === 0, "live fixture failed");
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); }

  const base = await cli(runArgs(["passed", "blocked"]));
  const baseDir = directory(base.out), oldBytes = readFileSync(join(baseDir, "manifest.json"), "utf8");
  assert(base.code !== 0 && manifest(baseDir).counts.passed === 1, "partial base was not retained");
  writeFileSync(marker("ready"), "ready");
  const resumed = await cli([...runArgs(["passed", "blocked"]), "--resume", baseDir]);
  const next = manifest(directory(resumed.out));
  assert(resumed.code === 0 && next.resumedFrom.reused.length === 1 && next.qualification.scope === "feedback", `safe resume failed: ${resumed.err}`);
  assert(readFileSync(marker("executions"), "utf8").split("\n").filter(x => x === "passed").length === 1, "passed case was unnecessarily repeated");
  assert(readFileSync(join(baseDir, "manifest.json"), "utf8") === oldBytes, "resume rewrote prior evidence");

  const resumeArgs = [...runArgs(["passed", "blocked"]), "--resume", baseDir];
  writeFileSync(artifact, "artifact-two");
  assert((await cli(resumeArgs)).err.includes("resume inputs differ"), "changed artifact reused old pass");
  writeFileSync(artifact, "artifact-one");
  writeFileSync(join(repo, "new-source"), "changed");
  assert((await cli(resumeArgs)).err.includes("resume inputs differ"), "changed source reused old pass");
  const failed = await cli(runArgs(["failed"]));
  const retry = await cli([...runArgs(["failed"]), "--resume", directory(failed.out)]);
  assert(retry.code !== 0 && retry.err.includes("cannot be retried into a green run"), "assertion failure washed green by resume");
  const timedOut = await cli(runArgs(["timeout"]));
  assert((await cli([...runArgs(["timeout"]), "--resume", directory(timedOut.out)])).err.includes("cannot be retried into a green run"), "started timeout was retried into green");
  const narrowed = await cli(["run", "--space", space, "--open", repo, "--gate", "dev", "--case", "fixture.passed"]);
  const partial = manifest(directory(narrowed.out));
  assert(narrowed.code !== 0 && !partial.qualification.qualified && partial.qualification.reasons.includes("filtered selection is not the complete release gate"), "scoped dev falsely qualified or exited successfully");
  t.note("Real CLI: explicit scope, selected preflight, live inspection, passed reuse, immutable prior evidence, source/artifact mismatch rejection, failed retry rejection and full-gate boundary passed.");
});

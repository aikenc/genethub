import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

const references = "apps/daemon/builtin-skills/genehub/references";
const common = {
  tags: ["core", "team", "platform-feedback"], llm: { default: "none" as const },
  requirements: [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }],
  productInterfaces: ["tools/run.py", "spacebuilder.py"], surfaces: ["team-template", "spacebuilder", "filesystem"],
  requiredArtifacts: [] as string[], expectedDurationMs: 5000, timeoutMs: 60000,
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" as const },
};

defineSpecialty({ ...common, id: "specialty.daemon.team-platform-feedback.durable-lifecycle",
  title: "Portable Team feedback deduplicates original retries and reopens the same evidence history on recurrence",
  oracle: "Actual public CLI receipts and files show one stable issue, distinct observations, conflict-safe retries, adopted-version verification and recurrence without erasing earlier evidence after a source-free artifact relocation.",
  catches: ["duplicate reports create separate issues", "unknown retry duplicates occurrence", "old retry reopens fixed issue", "recurrence erases verification", "portable output omits the feedback command"] }, async t => {
  const python = process.env.GENEHUB_PYTHON!, source = join(t.env.root, "source"), output = join(t.env.root, "output"), moved = join(t.env.root, "installed");
  cpSync(join(t.openRoot, references, "team-template"), source, { recursive: true });
  const build = spawnSync(python, [join(t.openRoot, references, "spacebuilder/spacebuilder.py"), "build", source, "--output", output, "--require-no-post-commands", "--format", "json"], { encoding: "utf8", env: t.env.env, timeout: 30000 });
  t.assertions.assert(build.status === 0, build.stdout + build.stderr);
  renameSync(output, moved);
  renameSync(source, join(t.env.root, "retired-definition"));
  const invoke = (args: string[]) => spawnSync(python, [join(moved, "tools/run.py"), ...args], { encoding: "utf8", env: t.env.env, cwd: t.env.root, timeout: 10000 });
  const ok = (args: string[]) => {
    const r = invoke(args); t.assertions.assert(r.status === 0, r.stdout + r.stderr); return JSON.parse(r.stdout);
  };
  const report = (request: string, evidence: string) => ["feedback", "add", "--kind", "template", "--title", "SB010 generated file ownership conflict", "--ref", "SB010", "--fingerprint", "sb010:workspace-rule.md", "--evidence", evidence, "--request-id", request];
  const first = ok(report("observation-A", "ghref:item:observation-A"));
  const file = join(moved, first.path), original = readFileSync(file, "utf8");
  const repeat = ok(report("observation-A", "ghref:item:observation-A"));
  t.assertions.assert(repeat.id === first.id && repeat.occurrences === 1 && readFileSync(file, "utf8") === original, "accepted observation was written twice");
  const conflict = invoke(report("observation-A", "ghref:item:changed-evidence"));
  t.assertions.assert(conflict.status !== 0 && readFileSync(file, "utf8") === original, "conflicting original intent changed evidence");
  const second = ok(report("observation-B", "ghref:item:observation-B"));
  t.assertions.assert(second.id === first.id && second.occurrences === 2 && readdirSync(join(moved, "datas/platform-feedback")).filter(p => p.endsWith(".json")).length === 1, "same cause/object did not aggregate evidence");
  const verify = ["feedback", "verify", first.id, "--result", "fixed", "--version", "dev-accepted-candidate", "--evidence", "ghref:item:adoption-and-recheck", "--request-id", "verification-A"];
  const fixed = ok(verify), verified = readFileSync(file, "utf8");
  t.assertions.assert(fixed.state === "fixed" && fixed.verifiedIn.version === "dev-accepted-candidate" && /^sha256:[a-f0-9]{64}$/.test(fixed.verifiedIn.templateVersion), "verification lost actual loaded-template identity or adopted version");
  t.assertions.assert(ok(["feedback", "ls", "--open"]).length === 0, "verified issue remained open");
  ok(verify);
  ok(report("observation-A", "ghref:item:observation-A"));
  t.assertions.assert(readFileSync(file, "utf8") === verified, "an original retry changed a later verified state");
  const recurrence = ok(report("observation-C", "ghref:item:observation-C"));
  const record = JSON.parse(readFileSync(file, "utf8"));
  t.assertions.assert(recurrence.id === first.id && recurrence.state === "recurred" && record.occurrences.length === 3 && record.verifications.length === 1, "recurrence did not preserve the issue and verification history");
  ok(verify);
  t.assertions.assert(JSON.parse(readFileSync(file, "utf8")).state === "recurred", "replayed old verification incorrectly closed a new occurrence");
  t.assertions.assert(ok(["feedback", "ls", "--open"])[0].id === first.id, "recurrence not visible through public listing");
  const verifyArtifact = spawnSync(python, [join(t.openRoot, references, "spacebuilder/spacebuilder.py"), "verify", moved, "--artifacts-only", "--format", "json"], { encoding: "utf8", env: t.env.env, timeout: 30000 });
  t.assertions.assert(verifyArtifact.status === 0, verifyArtifact.stdout + verifyArtifact.stderr);
  t.note("One portable issue retained three observations and its adoption verification; replays/conflicts preserved original bytes and later recurrence.");
});

defineSpecialty({ ...common, id: "specialty.daemon.team-platform-feedback.storage-failures",
  title: "Feedback preserves corrupt or unavailable storage and read-only listing does not mutate Team inboxes",
  oracle: "Public CLI returns failure for malformed records, blocked storage and traversal IDs, preserves the original bytes, and leaves an existing Team inbox untouched; empty listing creates no feedback records.",
  catches: ["corrupt record interpreted as empty and overwritten", "storage failure reported as success", "feedback command drains unrelated inbox", "verification ID escapes feedback directory"] }, async t => {
  const python = process.env.GENEHUB_PYTHON!, root = join(t.env.root, "team");
  cpSync(join(t.openRoot, references, "team-template"), root, { recursive: true });
  const invoke = (args: string[]) => spawnSync(python, [join(root, "tools/run.py"), ...args], { encoding: "utf8", env: t.env.env, cwd: t.env.root, timeout: 10000 });
  const directory = join(root, "datas/platform-feedback"), inbox = join(root, ".genethub/team/inbox/preserved.jsonl");
  mkdirSync(join(root, ".genethub/team/inbox"), { recursive: true }); writeFileSync(inbox, '{"text":"unread business input"}\n');
  const empty = invoke(["feedback", "ls"]);
  t.assertions.assert(empty.status === 0 && JSON.parse(empty.stdout).length === 0 && !existsSync(directory), "empty listing mutated feedback storage");
  const args = ["feedback", "add", "--kind", "kernel", "--title", "storage observation", "--fingerprint", "storage:object", "--evidence", "ghref:item:storage-A", "--request-id", "storage-A"];
  const first = invoke(args); t.assertions.assert(first.status === 0, first.stdout + first.stderr);
  const id = JSON.parse(first.stdout).id, file = join(directory, `${id}.json`), beforeInbox = readFileSync(inbox, "utf8");
  const valid = JSON.parse(readFileSync(file, "utf8"));
  for (const damaged of ['{"schema":', '[]', JSON.stringify({ schema: "team-platform-feedback/1", id, fingerprint: "storage:object", occurrences: [] }), JSON.stringify({ ...valid, occurrences: [null] })]) {
    writeFileSync(file, damaged);
    const add = invoke(args), listing = invoke(["feedback", "ls", "--open"]);
    t.assertions.assert(add.status !== 0 && listing.status !== 0 && readFileSync(file, "utf8") === damaged, "damaged evidence was overwritten or silently omitted");
  }
  renameSync(directory, join(root, "preserved-feedback")); writeFileSync(directory, "storage unavailable");
  const blocked = invoke(args);
  t.assertions.assert(blocked.status !== 0 && readFileSync(directory, "utf8") === "storage unavailable", "blocked storage was converted to accepted feedback");
  const traversal = invoke(["feedback", "verify", "../outside", "--result", "fixed", "--evidence", "ghref:item:invalid"]);
  t.assertions.assert(traversal.status !== 0 && !existsSync(join(root, "datas/outside.json")) && readFileSync(inbox, "utf8") === beforeInbox, "invalid feedback command changed unrelated Team data");
  t.note("Malformed records, blocked storage and traversal IDs failed closed without overwriting evidence or touching an unrelated inbox; no native fleet/LLM claim.");
});

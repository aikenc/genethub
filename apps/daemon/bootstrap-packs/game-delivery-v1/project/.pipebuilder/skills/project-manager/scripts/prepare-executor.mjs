// PM-owned preparation using public product commands. This receipt records
// prepared resources; Workflow Run state remains owned by the Executor.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Product JSON uses the guest filesystem spelling; Node runs natively.
const nativePath = (value) => process.platform === "win32" && /^\/[a-z](?:\/|$)/i.test(value)
  ? `${value[1]}:${value.slice(2) || "/"}` : value;
const cli = nativePath(process.env.GENEHUB_CLI ?? "");
const sessionId = process.env.GENEHUB_SESSION_ID;
if (!cli || !path.isAbsolute(cli) || !sessionId) throw new Error("Run inside the authorized PM Session with absolute GENEHUB_CLI");
const planFile = process.argv[2];
if (!planFile || process.argv.length !== 3) throw new Error("Usage: node prepare-executor.mjs <trial-plan.json>");
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
if (plan.schema !== "genehub.workflow-trial-plan.v1" || !namePattern.test(plan.name) || !namePattern.test(plan.testName)) {
  throw new Error("Trial plan needs schema, kebab-case name and testName");
}
if (!Array.isArray(plan.repositories)) throw new Error("Declare repositories explicitly; [] means ordinary test material");
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
function command(binary, args, cwd = process.cwd()) {
  const result = spawnSync(binary, args, { cwd, env: process.env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
function genet(args) {
  const lines = command(cli, args).split("\n").filter((line) => line.trim().startsWith("{"));
  for (const line of lines.reverse()) {
    let envelope;
    try { envelope = JSON.parse(line); } catch { continue; }
    if (envelope.data) return envelope.data;
  }
  throw new Error(`${args.join(" ")} returned no product result`);
}
function relative(value, label, allowDot = false) {
  if (typeof value !== "string" || (!allowDot && value === ".") || !value || path.isAbsolute(value)
      || value.split(/[\\/]/).some((part) => part === ".." || !part) || value.includes("\\")) {
    throw new Error(`${label} must be a project-relative path without traversal`);
  }
  return value;
}
function noLinks(root, target) {
  for (let current = target; current.startsWith(root + path.sep) || current === root; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Linked preparation path: ${current}`);
    if (current === root) break;
  }
}
const me = genet(["session", "inspect", sessionId]).inspection.summary;
const spaces = genet(["workspace", "list"]).workspaces.map((space) => ({ ...space, root: nativePath(space.root) }));
const project = spaces.find((space) => space.id === me.workspaceId);
if (me.managed || !project || project.agentSpace?.parentWorkspaceId
    || !project.agentSpace?.components.some((item) => item.componentId === "pm" && item.enabled)) {
  throw new Error("Only an ordinary project PM prepares a team; WM returns its plan to PM");
}
const projectRoot = realpathSync(project.root);
const sourceName = plan.sourceExecutor ?? "executor";
if (!namePattern.test(sourceName)) throw new Error("sourceExecutor must name a direct project Space");
const sourceRoot = realpathSync(path.join(projectRoot, "spaces", sourceName));
const source = spaces.find((space) => existsSync(space.root) && realpathSync(space.root) === sourceRoot);
if (!source || source.agentSpace?.parentWorkspaceId !== project.id
    || !source.agentSpace.components.some((item) => item.componentId === "executor" && item.enabled)) {
  throw new Error("sourceExecutor is not this project's registered Executor");
}
// No filesystem writes precede the product's existing management-authority check.
genet(["space", "builder", "build", "--workspace", project.id, "--name", sourceName, "--require-no-post-commands", "--plan"]);
const sourceMembers = [source, ...spaces.filter((space) => space.agentSpace?.parentWorkspaceId === source.id)];
if (sourceMembers.slice(1).some((member) => !member.agentSpace.components.some((item) => item.componentId === "worker" && item.enabled))) {
  throw new Error("The preparation helper copies an Executor and its direct Workers; describe other compositions separately");
}
const sourceManifest = JSON.parse(readFileSync(path.join(sourceRoot, "pipespace.json"), "utf8"));
const executorName = `${sourceManifest.name}-${plan.name}`;
if (!namePattern.test(executorName)) throw new Error("Invalid source Executor manifest name");
const executorRoot = path.join(projectRoot, "spaces", executorName);
const materialRoot = path.join(executorRoot, ".genethub", "temp", "exp", plan.testName);
const taskRoot = path.join(materialRoot, relative(plan.taskRoot ?? ".", "taskRoot", true));
const receiptFile = path.join(executorRoot, ".genethub", "temp", "exp", `.${plan.testName}.prepare.json`);
noLinks(projectRoot, receiptFile);
const inputDigest = hash(encode(plan));
const previous = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, "utf8")) : null;
if (previous && previous.inputDigest !== inputDigest) throw new Error("Preparation name already belongs to a different plan; retain it and choose a new name");

const files = [];
function collect(directory, destination) {
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`Linked source directory: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) collect(from, to);
    else if (entry.isFile()) files.push({ target: to, bytes: readFileSync(from) });
    else throw new Error(`Copy only regular source files: ${from}`);
  }
}
const members = sourceMembers.map((member, index) => {
  const root = realpathSync(member.root);
  if (path.dirname(root) !== path.join(projectRoot, "spaces")) throw new Error("Source team must use direct project Spaces");
  const manifest = JSON.parse(readFileSync(path.join(root, "pipespace.json"), "utf8"));
  const name = `${manifest.name}-${plan.name}`;
  if (!namePattern.test(name)) throw new Error("Invalid target Space name");
  const target = path.join(projectRoot, "spaces", name);
  if (!previous && existsSync(target)) throw new Error(`Target already exists; do not overwrite it: ${target}`);
  noLinks(projectRoot, target);
  for (const dir of ["skills", ".pipebuilder/skills", ".pipebuilder/agents"]) collect(path.join(root, dir), path.join(target, dir));
  // External/Git providers retain their declared source; Builder checks their
  // supported contract. Source paths at the same depth keep their meaning.
  manifest.name = name;
  files.push({ target: path.join(target, "pipespace.json"), bytes: Buffer.from(encode(manifest)) });
  const entries = readdirSync(root).filter((entry) => entry.endsWith(".code-workspace"));
  if (entries.length !== 1) throw new Error(`Expected one source workspace file: ${root}`);
  const workspace = JSON.parse(readFileSync(path.join(root, entries[0]), "utf8"));
  workspace.folders = [{ name, path: "." }, { name: "test-material", path: path.relative(target, taskRoot).split(path.sep).join("/") }];
  files.push({ target: path.join(target, `${name}.code-workspace`), bytes: Buffer.from(encode(workspace)) });
  return { name, root: target, sourceId: member.id, lifecycle: member.agentSpace.lifecycle, components: member.agentSpace.components, executor: index === 0 };
});
if (new Set(members.map((member) => member.name)).size !== members.length) {
  throw new Error("Source team contains duplicate manifest names; give each Space a unique name before preparation");
}
const sourceDigest = hash(encode(files.map((file) => [path.relative(projectRoot, file.target), hash(file.bytes)])));
if (previous && previous.sourceDigest !== sourceDigest) throw new Error("Source team changed since preparation; inspect the previous receipt and plan a new candidate");
const repositories = plan.repositories.map((repo) => {
  const rel = relative(repo.path, "repository.path");
  const root = realpathSync(path.resolve(projectRoot, repo.source ?? "."));
  if (realpathSync(nativePath(command("git", ["rev-parse", "--show-toplevel"], root).trim())) !== root) throw new Error("Source must identify a repository root");
  const baseline = command("git", ["rev-parse", "--verify", `${repo.ref ?? "HEAD"}^{commit}`], root).trim();
  const refs = command("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], root).trim();
  const branch = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root, encoding: "utf8" });
  return { path: rel, root, baseline, refs, branch: repo.branch ?? (branch.status === 0 ? branch.stdout.trim() : "trial") };
});
for (const left of repositories) for (const right of repositories) {
  if (left !== right && (left.path === right.path || left.path.startsWith(right.path + "/"))) throw new Error("Repository destinations must be disjoint");
}
if (previous && hash(encode(previous.repositories)) !== hash(encode(repositories))) throw new Error("Source repository baseline or refs changed; do not silently reuse a different experiment");
const configFile = path.join(projectRoot, ".genethub", "workflow", "project.yaml");
const configBefore = previous?.configBefore ?? readFileSync(configFile, "utf8");
const execution = /^execution:\s*\n((?:[ \t]+[^\n]*\n?)*)/m;
const block = configBefore.match(execution)?.[1];
if (!block || !/^  executorPath: /m.test(block) || !/^  root: /m.test(block)) throw new Error("Prepare project.yaml.execution explicitly in its supported block form first");
const binding = { executorPath: `spaces/${executorName}`, root: path.relative(projectRoot, taskRoot).split(path.sep).join("/") };
const configAfter = configBefore.replace(execution, `execution:\n${block.replace(/^  executorPath: .*$/m, `  executorPath: ${binding.executorPath}`).replace(/^  root: .*$/m, `  root: ${binding.root}`)}`);
const actualConfig = readFileSync(configFile, "utf8");
if (actualConfig !== configBefore && actualConfig !== configAfter) throw new Error("Workflow configuration changed; preserve it and reconcile the proposed execution binding");
const receipt = previous ?? { schema: "genehub.workflow-preparation.v1", inputDigest, sourceDigest, configBefore, binding, repositories, members: [], builds: {}, changes: {} };
function save() { mkdirSync(path.dirname(receiptFile), { recursive: true }); writeFileSync(receiptFile, encode(receipt), { mode: 0o600 }); }
save();
for (const file of files) {
  noLinks(projectRoot, file.target);
  if (existsSync(file.target)) {
    if (!readFileSync(file.target).equals(file.bytes)) throw new Error(`Prepared source changed; retain the customization: ${file.target}`);
  } else {
    mkdirSync(path.dirname(file.target), { recursive: true });
    writeFileSync(file.target, file.bytes, { flag: "wx" });
  }
}
mkdirSync(materialRoot, { recursive: true });
for (const repo of repositories) {
  const target = path.join(materialRoot, repo.path);
  noLinks(projectRoot, target);
  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
    command("git", ["clone", "--no-local", "--no-checkout", repo.root, target], materialRoot);
    for (const line of repo.refs.split("\n").filter(Boolean)) {
      const [oid, ref] = line.split(" ");
      command("git", ["update-ref", ref, oid], target);
    }
    command("git", ["checkout", "-B", repo.branch || "trial", repo.baseline], target);
    command("git", ["remote", "remove", "origin"], target);
    for (const key of ["user.name", "user.email"]) {
      const identity = spawnSync("git", ["config", "--get", key], { cwd: repo.root, encoding: "utf8" });
      if (identity.status === 0) command("git", ["config", key, identity.stdout.trim()], target);
    }
  }
  if (!existsSync(path.join(target, ".git")) || !lstatSync(path.join(target, ".git")).isDirectory()) throw new Error(`Incomplete independent clone: ${target}`);
  if (!receipt.prepared && command("git", ["rev-parse", "HEAD"], target).trim() !== repo.baseline) throw new Error(`Preparation baseline differs: ${target}`);
}
mkdirSync(taskRoot, { recursive: true });
const exclude = path.join(projectRoot, ".git", "info", "exclude");
if (existsSync(path.join(projectRoot, ".git")) && lstatSync(path.join(projectRoot, ".git")).isDirectory()) {
  const line = `\n/spaces/${executorName}/.genethub/temp/\n`;
  const old = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!old.includes(line.trim())) writeFileSync(exclude, old + line);
}
function configure(id, args, key) {
  const before = genet(["space", "inspect", "--workspace", id]).agentSpace;
  const change = genet(["space", ...args, "--workspace", id, "--revision", String(before?.revision ?? 0), "--plan"]);
  if (change.approval) throw new Error(`Missing management authority for ${key}; retain challenge ${change.approval.challengeId}`);
  const applied = genet(["space", ...args, "--workspace", id, "--revision", String(change.expectedRevision), "--plan-digest", change.planDigest, "--action-id", `${plan.name}-${key}-${change.expectedRevision}`]);
  receipt.changes[key] = { planDigest: change.planDigest, revision: applied.agentSpace.revision };
  save();
}
let executorId;
for (const member of members) {
  const args = ["space", "builder", "build", "--workspace", project.id, "--name", member.name, "--require-no-post-commands"];
  if (!receipt.builds[member.name]) {
    const preview = genet([...args, "--plan"]).managementPlan;
    if (!preview) throw new Error("Daemon lacks PM Builder plans");
    genet([...args, "--plan-digest", preview.planDigest, "--expected-revision", String(preview.expectedRevision), "--action-id", `${plan.name}-build-${member.name}`]);
    receipt.builds[member.name] = preview;
    save();
  }
  genet(["space", "builder", "verify", "--workspace", project.id, "--name", member.name]);
  const opened = genet(["space", "open", path.join(member.root, `${member.name}.code-workspace`)]).workspace;
  const id = opened.id, parent = member.executor ? project.id : executorId;
  if (opened.agentSpace?.parentWorkspaceId !== parent) configure(id, ["parent", "set", "--parent", parent], `${member.name}-parent`);
  for (const component of [...member.components].sort((a, b) => Number(b.componentId === "worker") - Number(a.componentId === "worker"))) {
    const current = genet(["space", "inspect", "--workspace", id]).agentSpace;
    if (current.components.some((item) => item.componentId === component.componentId && item.enabled === component.enabled && (item.role ?? null) === (component.role ?? null))) continue;
    configure(id, ["component", "set", "--component", component.componentId, ...(component.role ? ["--role", component.role] : []), ...(!component.enabled ? ["--disabled"] : [])], `${member.name}-${component.componentId}`);
  }
  if (genet(["space", "inspect", "--workspace", id]).agentSpace.lifecycle !== member.lifecycle) {
    configure(id, ["lifecycle", "set", "--lifecycle", member.lifecycle], `${member.name}-lifecycle`);
  }
  if (member.executor) executorId = id;
  if (!receipt.members.some((item) => item.workspaceId === id)) receipt.members.push({ name: member.name, workspaceId: id, sourceId: member.sourceId });
  save();
}
if (readFileSync(configFile, "utf8") !== actualConfig) throw new Error("Workflow binding changed during preparation; reconcile it before dispatch");
writeFileSync(configFile, configAfter);
const candidate = genet(["workflow", "inspect", "--workspace", project.id]);
if (!candidate.candidateDigest) throw new Error(candidate.candidateError ?? "Candidate did not compile");
receipt.prepared = true;
receipt.candidateDigest = candidate.candidateDigest;
receipt.executorWorkspaceId = executorId;
receipt.executionRoot = taskRoot;
save();
process.stdout.write(encode({ ...receipt, configBefore: undefined, receiptFile }));

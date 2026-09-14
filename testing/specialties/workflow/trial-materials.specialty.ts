import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { WorkflowRunStatus, WorkspaceInfo } from "@genehub/proto";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
for (const scenario of ["plain", "multiple-repos", "own-worktree", "parent-repo", "formal-metadata", "formal-alternates"] as const) defineSpecialty({
  id: `specialty.workflow.trial-materials.${scenario}`,
  title: `Candidate execution uses ${scenario} within its actual material boundary`,
  oracle: "Real candidate dispatch accepts ordinary data and independent Git layouts; Git-writing nodes never borrow the formal repository or its metadata/objects",
  catches: ["every trial must be one Git repository", "Executor private test directories are rejected", "Git traverses to a parent repository", "formal Git metadata or object alternates are reused", "valid experimental worktrees are rejected"],
  tags: ["core", "workflow", "workflow-trials"], llm: { default: "mock" },
  expectedDurationMs: 15000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "git", "workbench-client"],
  productInterfaces: ["workflow.inspect", "workflow.dispatch", "workflow.history", "agentSpace.configure", "genet space builder"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const git = (root: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    t.assertions.assert(result.status === 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await cli(["workflow", "init", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash"]);
    const root = opened.workspaceRoot;
    writeFileSync(path.join(root, "pipespace.json"), JSON.stringify({ schema: "pipespace.v1", name: "material-project", agents: ["codex"], skills: [], skillProviders: [], tags: [] }));
    writeFileSync(path.join(root, "material-project.code-workspace"), JSON.stringify({ folders: [{ path: "." }] }));
    await cli(["space", "builder", "build", "--workspace", opened.workspaceId, "--target-workspace", opened.workspaceId, "--name", "material-project", "--require-no-post-commands"]);
    await cli(["space", "lifecycle", "set", "--workspace", opened.workspaceId, "--lifecycle", "persistent"]);
    git(root, "add", "."); git(root, "commit", "-m", "formal baseline");
    const formalHead = git(root, "rev-parse", "HEAD");
    const material = path.join(root, "spaces/trial-executor/.genethub/temp/exp", scenario);
    mkdirSync(material, { recursive: true });
    const good = ["plain", "multiple-repos", "own-worktree"].includes(scenario);
    const repositories = scenario === "multiple-repos" ? ["front", "back"] : scenario === "plain" || scenario === "parent-repo" ? ["."] : ["work"];
    if (scenario === "multiple-repos" || scenario === "own-worktree") {
      for (const name of scenario === "own-worktree" ? ["repository"] : repositories) {
        const repo = path.join(material, name); mkdirSync(repo, { recursive: true }); t.data.git.init(repo);
        writeFileSync(path.join(repo, "seed.txt"), "fixed baseline"); git(repo, "add", "."); git(repo, "commit", "-m", "experimental baseline");
        git(repo, "branch", "release-canary"); git(repo, "tag", "baseline-v1");
      }
      if (scenario === "own-worktree") git(path.join(material, "repository"), "worktree", "add", "-b", "trial-branch", path.join(material, "work"));
    } else if (scenario === "formal-alternates") {
      git(root, "clone", "--shared", root, path.join(material, "work"));
    } else if (scenario === "formal-metadata") {
      mkdirSync(path.join(material, "work"));
      writeFileSync(path.join(material, "work/.git"), `gitdir: ${path.join(root, ".git")}\n`);
    }
    // Fixture source is supplied through the public Builder and composition
    // APIs. PM-owned preparation is covered by the separate improvement journey.
    const makeSpace = async (name: string, parent: string, component: string): Promise<WorkspaceInfo> => {
      const dir = path.join(root, "spaces", name); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "pipespace.json"), JSON.stringify({ schema: "pipespace.v1", name, agents: ["codex"], skills: [], skillProviders: [], tags: [] }));
      const entry = path.join(dir, `${name}.code-workspace`);
      writeFileSync(entry, JSON.stringify({ folders: [{ name, path: "." }, { name: "material", path: path.relative(dir, material) }] }));
      await cli(["space", "builder", "build", "--workspace", opened.workspaceId, "--name", name, "--require-no-post-commands"]);
      const openedSpace = await opened.client.call({ type: "workspace.open", payload: { root: entry } });
      if (openedSpace?.type !== "workspace") throw new Error("test carrier did not open");
      const attached = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: openedSpace.data.id, expectedRevision: 0, operation: { kind: "setParent", parentWorkspaceId: parent } } });
      if (attached?.type !== "workspace") throw new Error("test carrier did not attach");
      const configured = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: attached.data.id, expectedRevision: attached.data.agentSpace!.revision,
        operation: { kind: "setComponent", componentId: component, enabled: true, role: component === "worker" ? "worker" : null } } });
      if (configured?.type !== "workspace") throw new Error("test carrier component did not register");
      return configured.data;
    };
    const source = path.join(root, ".genethub/workflow");
    const formal = await makeSpace("formal-executor", opened.workspaceId, "executor");
    await makeSpace("formal-worker", formal.id, "worker");
    writeFileSync(path.join(source, "project.yaml"), JSON.stringify({ schema: "genehub.workflow.project.v1", defaultWorkflow: "direct-change", execution: { executorPath: "spaces/formal-executor", root: "." } }));
    await cli(["workflow", "activate", "--revision", "1"]);
    const executor = await makeSpace("trial-executor", opened.workspaceId, "executor");
    await makeSpace("trial-worker", executor.id, "worker");
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "TRIAL_MATERIAL_WORKER: verify and write only in the assigned material, preserving its branches.");
    writeFileSync(path.join(source, "project.yaml"), JSON.stringify({ schema: "genehub.workflow.project.v1", defaultWorkflow: "trial-data", execution: { executorPath: "spaces/trial-executor", root: path.relative(root, material) } }));
    writeFileSync(path.join(source, "workflows/catalog.yaml"), JSON.stringify({ schema: "genehub.workflow.catalog.v1", workflows: [{ id: "trial-data", path: "direct-change.yaml", match: { kind: "data", complexity: "batch" } }] }));
    writeFileSync(path.join(source, "workflows/direct-change.yaml"), JSON.stringify({ schema: "genehub.workflow.definition.v2", id: "trial-data", version: 2,
      nodes: repositories.map((repository, index) => ({ id: `work-${index}`, uses: "agent.session", with: { role: "worker", workspace: repository,
        ...(scenario === "plain" ? {} : { writeLease: { targetRef: "current", ttlSeconds: 900 } }) },
        completion: { all: [{ key: scenario === "plain" ? "done" : "commit", verify: scenario === "plain" ? "value.nonEmpty" : "git.commitOnTarget" }] } })),
      structure: { body: { id: "material-tasks", type: "sequence", steps: repositories.map((repository, index) => ({ id: `step-${index}`, type: "task", activity: `work-${index}`, input: { op: "literal", value: repository } })) } },
    }));
    const inspected = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    if (inspected?.type !== "workflowProject" || !inspected.data.candidateDigest) throw new Error("test Candidate did not compile");
    const selected = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId, candidateDigest: inspected.data.candidateDigest } });
    t.assertions.assert(selected?.type === "workflowProject" && selected.data.selectedDigest === inspected.data.candidateDigest && selected.data.defaultWorkflow === "trial-data" && inspected.data.defaultWorkflow === "direct-change", "explicit candidate inspection projected the Active catalog");
    const seen = new Set<string>();
    let dispatched = false;
    opened.mock.script(...Array.from({ length: 12 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (!body.includes("TRIAL_MATERIAL_WORKER")) {
        if (dispatched) return { text: "Observed the workflow result." };
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow dispatch --kind data --complexity batch --candidate ${q(inspected.data.candidateDigest!)} --task trial-material --message 'Verify actual experimental material' --no-wait` } } };
      }
      const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
      if (!operation) throw new Error("material node has no identity");
      if (seen.has(operation)) return { text: "Material result submitted." };
      const repository = repositories[seen.size]!; seen.add(operation);
      const cwd = path.join(material, repository);
      const checks = scenario === "plain" ? "" : "git show-ref --verify --quiet refs/heads/release-canary && git show-ref --verify --quiet refs/tags/baseline-v1 && ";
      const finish = scenario === "plain" ? '"$GENEHUB_CLI" workflow complete --evidence done=result.txt' : 'git add result.txt && git commit -m trial-result && "$GENEHUB_CLI" workflow complete --evidence commit="$(git rev-parse HEAD)"';
      return { tool: { name: "bash", arguments: { command: `cd ${q(cwd)} && ${checks}printf 'actual trial result' > result.txt && ${finish}` } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, pm);
    await t.flows.main.sendPrompt(opened.client, pm, "Verify experimental material with the explicit Candidate.");
    let run: WorkflowRunStatus | undefined;
    const toolResults = () => (opened.mock.requests as Array<{ messages?: Array<{ role?: string; content?: unknown }> }>).flatMap((request) => request.messages ?? []).filter((message) => message.role === "tool").map((message) => message.content);
    await t.tools.waitUntil(async () => {
      const history = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      run = history?.type === "workflowRuns" ? history.data.find((item) => item.taskId === "trial-material") : undefined;
      if (good && !run && dispatched && events.some((event) => event.type === "turnCompleted")) throw new Error(`Candidate dispatch returned without a Run: ${JSON.stringify(opened.mock.requests).slice(-5000)}`);
      return Boolean(run && ["completed", "blocked", "failed"].includes(run.status)) || (!good && !run && dispatched && events.some((event) => event.type === "turnCompleted"));
    }, 45000).catch((error) => { throw new Error(`${error}; Run=${JSON.stringify(run)}; actual tool results=${JSON.stringify(toolResults()).slice(-6000)}`); });
    if (good) {
      t.assertions.assert(run?.status === "completed" && run.workflowId === "trial-data" && run.dcgDigest === inspected.data.candidateDigest && run.executorWorkspaceId === executor.id && run.executionRoot === material, `material execution failed: ${JSON.stringify(run)}`);
      for (const repo of repositories) t.assertions.assert(readFileSync(path.join(material, repo, "result.txt"), "utf8") === "actual trial result", "Run completed without real material output");
    } else {
      t.assertions.assert(run?.status !== "completed", "formal repository reuse was accepted");
      const evidence = JSON.stringify(toolResults()) + JSON.stringify(run);
      t.assertions.assert(/gitRepositoryRequired|experimentIsolation/.test(evidence), `trial failed without a Git-boundary reason: ${evidence.slice(-5000)}`);
      t.assertions.assert(!evidence.includes("an inactive Candidate needs a distinct Executor"), "fixture failed before the Git boundary");
      t.assertions.assert(seen.size === 0 && repositories.every((repo) => !existsSync(path.join(material, repo, "result.txt"))), "a Worker ran before the Git boundary was enforced");
    }
    t.assertions.assert(git(root, "rev-parse", "HEAD") === formalHead, "trial changed the formal commit");
  } finally {
    opened.client.close(); await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env); await opened.mock.stop();
  }
});

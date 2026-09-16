import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { WorkflowRunStatus, WorkspaceInfo } from "@genehub/proto";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
for (const scenario of ["plain", "multiple-repos", "own-worktree", "parent-repo", "formal-metadata", "formal-alternates", "silence-wr", "silence-wr-start-failed", "readonly-unsupported"] as const) defineSpecialty({
  id: `specialty.workflow.trial-materials.${scenario}`,
  title: `Candidate execution uses ${scenario} within its actual material boundary`,
  oracle: "Real candidate dispatch accepts ordinary data and independent Git layouts; Git-writing nodes never borrow the formal repository or its metadata/objects",
  catches: ["every trial must be one Git repository", "Executor private test directories are rejected", "Git traverses to a parent repository", "formal Git metadata or object alternates are reused", "valid experimental worktrees are rejected", "automatic diagnosis resolves the formal root instead of the pinned trial material", "a failed pre-Session diagnosis prevents cancellation from settling"],
  tags: ["core", "workflow", "workflow-trials"], llm: { default: "mock" },
  expectedDurationMs: scenario.startsWith("silence-wr") ? 210000 : 15000, timeoutMs: scenario.startsWith("silence-wr") ? 300000 : 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "git", "workbench-client"],
  productInterfaces: ["workflow.inspect", "workflow.dispatch", "workflow.history", "workflow.check", "workflow.cancel", "session.get", "agentSpace.configure", "genet space builder"],
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
    const diagnosis = scenario.startsWith("silence-wr");
    const failedDiagnosticStart = scenario === "silence-wr-start-failed";
    const dataOnly = scenario === "plain" || diagnosis || scenario === "readonly-unsupported";
    const good = diagnosis || ["plain", "multiple-repos", "own-worktree"].includes(scenario);
    const repositories = scenario === "multiple-repos" ? ["front", "back"] : dataOnly || scenario === "parent-repo" ? ["."] : ["work"];
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
    const makeSpace = async (name: string, parent: string, component: string, role = "worker"): Promise<WorkspaceInfo> => {
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
        operation: { kind: "setComponent", componentId: component, enabled: true, role: component === "worker" ? role : null } } });
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
    const wr = diagnosis ? await makeSpace("trial-wr", executor.id, "worker", "wr") : undefined;
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "TRIAL_MATERIAL_WORKER: verify and write only in the assigned material, preserving its branches.");
    if (scenario === "readonly-unsupported") {
      writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({ schema: "genehub.workflow.role.v1", id: "worker", agentId: "tclaude", evidenceOnly: true, userInteraction: "readOnly", prompt: "prompts/direct-worker.md" }));
    }
    writeFileSync(path.join(source, "project.yaml"), JSON.stringify({ schema: "genehub.workflow.project.v1", defaultWorkflow: "trial-data", execution: { executorPath: "spaces/trial-executor", root: path.relative(root, material) }, ...(diagnosis ? { diagnosticRole: "wr" } : {}) }));
    writeFileSync(path.join(source, "workflows/catalog.yaml"), JSON.stringify({ schema: "genehub.workflow.catalog.v1", workflows: [{ id: "trial-data", path: "direct-change.yaml", match: { kind: "data", complexity: "batch" } }, ...(diagnosis ? [{ id: "diagnose", path: "diagnose.yaml" }] : [])] }));
    if (diagnosis) {
      writeFileSync(path.join(material, "evidence.txt"), "trial-material-evidence-canary");
      writeFileSync(path.join(source, "roles/wr.yaml"), JSON.stringify({ schema: "genehub.workflow.role.v1", id: "wr", agentId: failedDiagnosticStart ? "tclaude" : "genet", modelId: "deepseek/deepseek-v4-flash", evidenceOnly: true, userInteraction: "readOnly", prompt: "prompts/wr.md" }));
      writeFileSync(path.join(source, "prompts/wr.md"), "Only report evidence; do not modify or control the task.");
      writeFileSync(path.join(source, "workflows/diagnose.yaml"), JSON.stringify({ schema: "genehub.workflow.definition.v2", id: "diagnose", version: 2,
        nodes: [{ id: "review", uses: "agent.session", with: { role: "wr" } }], structure: { body: { id: "review-step", type: "task", activity: "review" } } }));
    }
    writeFileSync(path.join(source, "workflows/direct-change.yaml"), JSON.stringify({ schema: "genehub.workflow.definition.v2", id: "trial-data", version: 2,
      nodes: repositories.map((repository, index) => ({ id: `work-${index}`, uses: "agent.session", with: { role: "worker", workspace: repository,
        ...(dataOnly ? {} : { writeLease: { targetRef: "current", ttlSeconds: 900 } }) },
        completion: { all: [{ key: dataOnly ? "done" : "commit", verify: dataOnly ? "value.nonEmpty" : "git.commitOnTarget" }] } })),
      structure: { body: { id: "material-tasks", type: "sequence", steps: repositories.map((repository, index) => ({ id: `step-${index}`, type: "task", activity: `work-${index}`, input: { op: "literal", value: repository } })) } },
    }));
    const inspected = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    if (inspected?.type !== "workflowProject" || !inspected.data.candidateDigest) throw new Error("test Candidate did not compile");
    const selected = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId, candidateDigest: inspected.data.candidateDigest } });
    t.assertions.assert(selected?.type === "workflowProject" && selected.data.selectedDigest === inspected.data.candidateDigest && selected.data.defaultWorkflow === "trial-data" && inspected.data.defaultWorkflow === "direct-change", "explicit candidate inspection projected the Active catalog");
    const seen = new Set<string>();
    let dispatched = false;
    let diagnosticCalls = 0;
    opened.mock.script(...Array.from({ length: 24 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("bounded, read-only Workflow diagnosis")) {
        diagnosticCalls++;
        // A successful relative read proves the actual Session cwd, rather
        // than assuming a cwd field exists on the public Session summary.
        if (diagnosticCalls === 1) return { tool: { name: "read", arguments: { path: path.relative(path.join(root, "spaces/trial-wr"), path.join(material, "evidence.txt")) } } };
        if (diagnosticCalls === 2) return { tool: { name: "genet", arguments: { args: ["workflow", "check"] } } };
        return { text: "Evidence checked; the worker is silent, not cancelled." };
      }
      if (!body.includes("TRIAL_MATERIAL_WORKER")) {
        if (dispatched) return { text: "Observed the workflow result." };
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow dispatch --kind data --complexity batch --candidate ${q(inspected.data.candidateDigest!)} --task trial-material --message 'Verify actual experimental material' --no-wait` } } };
      }
      const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
      if (!operation) throw new Error("material node has no identity");
      if (diagnosis) { seen.add(operation); return { hang: true as const }; }
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
      return Boolean(run && (diagnosis ? seen.size > 0 : ["completed", "blocked", "failed"].includes(run.status))) || (!good && !run && dispatched && events.some((event) => event.type === "turnCompleted"));
    }, 45000).catch((error) => { throw new Error(`${error}; Run=${JSON.stringify(run)}; actual tool results=${JSON.stringify(toolResults()).slice(-6000)}`); });
    if (diagnosis) {
      const original = run!;
      const get = async () => {
        const reply = await opened.client.call({ type: "workflow.get", payload: { workspaceId: opened.workspaceId, runId: original.id } });
        if (reply?.type !== "workflowRun") throw new Error("missing trial Run");
        return reply.data;
      };
      // Real elapsed silence, not a patched clock or a private Run mutation.
      await t.tools.waitUntil(async () => {
        run = await get();
        return run.diagnostics?.some(d => ["finished", "failed", "limited"].includes(d.status)) === true;
      }, 210000);
      const diagnostic = run!.diagnostics?.[0];
      if (failedDiagnosticStart) {
        t.assertions.assert(diagnostic?.status === "failed" && diagnosticCalls === 0
          && JSON.stringify(diagnostic).includes("evidenceOnlyUnsupported"),
          `unsupported diagnostic backend did not fail before starting an Agent: ${JSON.stringify(diagnostic)}`);
        await t.assertions.expectProtocolCode(
          () => opened.client.call({ type: "session.get", payload: { sessionId: diagnostic!.sessionId } }),
          "notFound",
        );
      } else {
        t.assertions.assert(diagnostic?.status === "finished", `trial WR failed: ${JSON.stringify(diagnostic)}`);
        t.assertions.assert(diagnosticCalls === 3 && run!.diagnostics?.length === 1, "diagnosis did not consume exactly the scripted evidence operations");
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: diagnostic!.sessionId } });
        t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.workspaceId === wr!.id
          && reply.data.summary.managed?.evidenceScope?.root === root
          && reply.data.summary.managed?.userInteraction === "readOnly", "diagnosis lost its own Worker carrier or read-only scope");
        const results = JSON.stringify(toolResults());
        t.assertions.assert(results.includes("trial-material-evidence-canary"), `WR did not read the material relative to its own cwd: ${results.slice(-6000)}`);
        t.assertions.assert(results.includes("workflow.check") && results.includes("checkedAtMs"), `WR did not receive the public CLI checker envelope: ${results.slice(-6000)}`);
      }
      t.assertions.assert(run!.status === "running" && run!.executorWorkspaceId === executor.id && run!.executionRoot === material
        && run!.nodes.find(n => n.uses === "agent.session")?.sessionId === original.nodes.find(n => n.uses === "agent.session")?.sessionId,
        "diagnosis changed the pinned carrier, task or running Worker");
      await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: original.id, expectedRevision: run!.revision } });
      await t.tools.waitUntil(async () => (await get()).status === "cancelled", 30000);
      const cancelled = await get();
      t.assertions.assert(!cancelled.cleanupError && cancelled.activeNodes.length === 0,
        "cancelled trial retained cleanup errors or active nodes after diagnosis");
    } else if (scenario === "readonly-unsupported") {
      const node = run?.nodes.find(n => n.uses === "agent.session");
      t.assertions.assert(!!run && ["blocked", "failed"].includes(run.status)
        && JSON.stringify(run).includes("evidenceOnlyUnsupported") && !node?.sessionId && seen.size === 0,
        `unsupported read-only adapter was started or refused without a capability reason: ${JSON.stringify(run)}`);
    } else if (good) {
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

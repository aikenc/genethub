import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

// A project that is a plain folder, deliberately never `git init`-ed. Git
// projects are covered by the existing workflow specialties; this one exists
// because the platform now claims a project does not need a repository at
// all, and that claim is only worth what an actual run of it proves.
defineSpecialty({
  id: "specialty.workflow.directory-project.no-repository",
  title: "A project with no repository dispatches, leases and publishes",
  oracle:
    "A real daemon activates a package, dispatches a managed Worker, grants a directory write lease and accepts verified evidence in a workspace that has no Git repository anywhere above or below it",
  catches: [
    "activation or dispatch quietly requires a repository",
    "a write lease needs a branch or a clean Git status",
    "provenance failure is treated as an error instead of unknown",
    "evidence verification reaches for a commit",
    "a directory project is refused for lacking facts the platform no longer needs",
  ],
  tags: ["core", "workflow", "directory-project"],
  llm: { default: "mock" },
  expectedDurationMs: 15000,
  timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.inspect", "workflow.activate", "workflow.dispatch", "workflow.history", "workflow.complete"],
}, async t => {
  // No t.data.git.init: that omission is the whole point of this case.
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    t.assertions.assert(
      !existsSync(path.join(opened.workspaceRoot, ".git")),
      "fixture must not be a repository or this case proves nothing",
    );
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "DIRECTORY_PROJECT_WORKER: write the deliverable in the task directory and report it.");
    // A write lease and real evidence, with no Git concept in the
    // declaration: the lease is over a directory and the verifier is a pure
    // predicate over the value the Worker submits.
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [
        { id: "implement", uses: "agent.session",
          with: { role: "worker", writeLease: { ttlSeconds: 900 } },
          completion: { all: [{ key: "artifact", verify: "value.nonEmpty" }, { key: "status", verify: "value.equals", expected: "published" }] } },
        { id: "publish", uses: "result.publish" },
      ],
      structure: { body: { id: "delivery", type: "sequence", steps: [
        { id: "implement-step", type: "task", activity: "implement" },
        { id: "publish-step", type: "task", activity: "publish" },
      ] } },
    }));

    const inspected = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    if (inspected?.type !== "workflowProject") throw new Error("a directory project did not inspect");
    // Provenance is a display fact sourced from Git, so here it is simply
    // unknown. Unknown must not be an error and must not block anything.
    const listed = await opened.client.call({ type: "workflow.list", payload: { workspaceId: opened.workspaceId } });
    if (listed?.type !== "workflowPackages") throw new Error("a directory project did not list its packages");
    const pkg = listed.data.packages[0];
    t.assertions.assert(!!pkg, "the seeded package is not listed");
    t.assertions.assert(!pkg!.sourceCommit && !pkg!.sourceUrl, "a directory project must report provenance as unknown, not invent it");
    t.assertions.assert(!pkg!.sourceDirty, "a project with no repository cannot be dirty");
    t.assertions.assert(!!pkg!.sourceDigest, "the platform must still compute its own source digest, which is what trust rests on");

    await cli(["workflow", "activate", "--revision", String(inspected.data.activationRevision)]);

    let dispatched = false;
    const submitted = new Set<string>();
    const deliverable = "artifact.txt";
    opened.mock.script(...Array.from({ length: 16 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (!body.includes("DIRECTORY_PROJECT_WORKER")) {
        if (dispatched) return { text: "Delegated." };
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task directory-delivery --message "Write the deliverable." --no-wait' } } };
      }
      // One submission per node. Repeating it would re-run `complete`
      // against an already settled node and fail for an unrelated reason.
      const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
      if (!operation) throw new Error("worker prompt carries no node identity");
      if (submitted.has(operation)) return { text: "已提交交付物及证据。" };
      submitted.add(operation);
      return { tool: { name: "bash", arguments: {
        command: `printf 'built without a repository' > ${deliverable} && "$GENEHUB_CLI" workflow complete --evidence artifact="$(cat ${deliverable})" --evidence status=published`,
      } } };
    } })));

    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "交付这个目录项目。");
    let run: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      run = reply?.type === "workflowRuns" ? reply.data.find(item => item.taskId === "directory-delivery") : undefined;
      return !!run && ["completed", "failed", "blocked"].includes(run.status);
    }, 60000);

    t.assertions.assert(run?.status === "completed", `a directory project could not complete a Run: ${JSON.stringify(run)}`);
    // Structured Runs name their instances `operation-N`, so the node is
    // found by the capability and evidence it carries rather than by the
    // definition id.
    const implement = run!.nodes.find(node => "status" in node.evidence);
    t.assertions.assert(
      implement?.evidence.status === "published",
      `the declared evidence was not verified and recorded: ${JSON.stringify(run!.nodes)}`,
    );
    t.assertions.assert(
      implement?.evidence.artifact === "built without a repository",
      "the artifact evidence did not survive verification",
    );
    // The deliverable is on disk, which is the fact the Run claims.
    t.assertions.assert(
      readFileSync(path.join(opened.workspaceRoot, deliverable), "utf8") === "built without a repository",
      "the Worker's deliverable is missing from the task directory",
    );
    t.assertions.assert(
      !existsSync(path.join(opened.workspaceRoot, ".git")),
      "the platform created a repository behind the project's back",
    );
  } finally {
    opened.client.close();
    await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    await opened.mock.stop();
  }
});

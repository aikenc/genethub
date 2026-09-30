import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const scenario of ["definition", "carrier", "legacy-carrier", "invalid-binding"] as const) defineSpecialty({
  id: `specialty.workflow.active-snapshot-source-loss.${scenario}`,
  title: `An active ${scenario} Workflow survives source loss and daemon restart`,
  oracle: "Deleting package source leaves the activated digest, revision and history readable through real CLI/client after a daemon restart; a definition-only frozen flow still runs, while a binding outside the package carrier allowlist fails explicitly",
  catches: ["source deletion makes saved activation unreadable", "source edits silently move the storage directory", "restart loses the active package selection", "legacy carrier snapshots need a new source clone", "a persisted binding escapes its project", "dispatch validates against missing source instead of the frozen flow"],
  tags: ["core", "workflow", "storage", "recovery", "active-snapshot-source-loss"],
  llm: { default: "mock" }, expectedDurationMs: 30_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["genet workflow", "workflow.inspect", "workflow.history", "session.send"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const packageId = scenario === "legacy-carrier" ? "studio/local" : "local";
  const flatId = packageId.replaceAll("/", "-");
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const inspect = async () => {
    const reply = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId, packageId } });
    t.assertions.assert(reply?.type === "workflowProject", `inspect failed: ${JSON.stringify(reply)}`);
    if (reply?.type !== "workflowProject") throw new Error("workflow inspection unavailable");
    return reply.data;
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const carrier = scenario !== "definition";
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot, packageId,
      ...(carrier ? { spaces: [
        { name: "executor", components: [{ componentId: "executor" }] },
        { name: "worker", components: [{ componentId: "worker", role: "worker" }] },
      ] } : {}),
    });
    // No write lease or repository mutation is needed to prove frozen dispatch.
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker" },
        completion: { all: [{ key: "done", verify: "value.nonEmpty" }] } },
        { id: "publish", uses: "result.publish" }],
      structure: { body: { id: "frozen-assignment", type: "sequence", steps: [
        { id: "work-step", type: "task", activity: "work" },
        { id: "publish-step", type: "task", activity: "publish" },
      ] } },
    }));
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "SOURCE_LOSS_WORKER: complete the frozen assignment with actual evidence.\n");
    if (carrier) {
      // Prepare authorized component instances through the production Builder
      // and composition APIs, as an operator does; a clone alone grants nothing.
      writeFileSync(path.join(opened.workspaceRoot, "pipespace.json"), JSON.stringify({
        schema: "pipespace.v1", name: "snapshot-project", agents: ["codex"], skills: [], skillProviders: [], tags: [],
      }));
      writeFileSync(path.join(opened.workspaceRoot, "snapshot-project.code-workspace"), JSON.stringify({ folders: [{ path: "." }] }));
      await cli(["space", "builder", "build", "--workspace", opened.workspaceId, "--target-workspace", opened.workspaceId,
        "--name", "snapshot-project", "--require-no-post-commands"]);
      await cli(["space", "lifecycle", "set", "--workspace", opened.workspaceId, "--lifecycle", "persistent"]);
      let parent = opened.workspaceId;
      for (const component of ["executor", "worker"]) {
        const name = `${flatId}--${component}`;
        const directory = path.join(opened.workspaceRoot, "spaces", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "pipespace.json"), JSON.stringify({
          schema: "pipespace.v1", name, agents: ["codex"], skills: [], skillProviders: [], tags: [],
        }));
        const entry = path.join(directory, `${name}.code-workspace`);
        writeFileSync(entry, JSON.stringify({ folders: [{ path: "." }] }));
        await cli(["space", "builder", "build", "--workspace", opened.workspaceId, "--name", name, "--require-no-post-commands"]);
        const space = await opened.client.call({ type: "workspace.open", payload: { root: entry } });
        if (space?.type !== "workspace") throw new Error("snapshot fixture component did not open");
        const attached = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: space.data.id,
          expectedRevision: 0, operation: { kind: "setParent", parentWorkspaceId: parent } } });
        if (attached?.type !== "workspace") throw new Error("snapshot fixture component did not attach");
        const configured = await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: space.data.id,
          expectedRevision: attached.data.agentSpace!.revision,
          operation: { kind: "setComponent", componentId: component, enabled: true, role: component === "worker" ? "worker" : null } } });
        if (configured?.type !== "workspace") throw new Error("snapshot fixture component did not configure");
        parent = space.data.id;
      }
    }
    await cli(["workflow", "activate", "--package", packageId, "--revision", "0"]);
    const before = await inspect();
    t.assertions.assert(Boolean(before.activeDigest) && before.activationRevision === 1, "initial activation is absent");
    const binding = path.join(opened.workspaceRoot, ".genethub/components/executor/packages", flatId, "executor.json");
    if (scenario === "invalid-binding") {
      t.assertions.assert(existsSync(binding), "activation did not persist its storage binding");
      const saved = readFileSync(binding, "utf8");
      writeFileSync(binding, JSON.stringify({ ...JSON.parse(saved), executorPath: "../outside" }));
      const rejected = await runGenetAsync(opened.daemon.genet,
        ["workflow", "inspect", "--package", packageId], opened.daemon.env, { cwd: opened.workspaceRoot });
      t.assertions.assert(rejected.code !== 0 && /Executor.*绑定|executor.*binding/.test(rejected.stderr + rejected.stdout),
        `invalid binding was accepted or misreported: ${rejected.stderr || rejected.stdout}`);
      writeFileSync(binding, saved);
    } else if (scenario === "legacy-carrier") {
      // Old releases wrote these real activation/candidate files without a locator.
      rmSync(binding, { force: true });
    } else if (scenario === "definition") {
      t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot,
        spaces: [{ name: "different-executor", components: [{ componentId: "executor" }] }],
      });
      const changed = await inspect();
      t.assertions.assert(changed.activeDigest === before.activeDigest && changed.sourceChanged,
        "editing the carrier declaration moved or replaced the active snapshot");
    }
    rmSync(source, { recursive: true });
    if (scenario === "legacy-carrier") {
      const collision = await runGenetAsync(opened.daemon.genet,
        ["workflow", "inspect", "--package", flatId], opened.daemon.env, { cwd: opened.workspaceRoot });
      t.assertions.assert(collision.code !== 0 && /不属于|另一个/.test(collision.stderr + collision.stdout)
        && !existsSync(binding), "a flattened-id collision reused or rewrote another package's saved binding");
    }
    const verify = async () => {
      const status = await inspect();
      t.assertions.assert(status.activeDigest === before.activeDigest && status.activationRevision === before.activationRevision
        && JSON.stringify(status.activationHistory) === JSON.stringify(before.activationHistory)
        && status.candidateDigest === undefined && Boolean(status.candidateError) && status.sourceChanged,
      `source loss changed the saved activation: ${JSON.stringify(status)}`);
      await cli(["workflow", "inspect", "--package", packageId]);
      if (scenario !== "legacy-carrier") await cli(["workflow", "inspect"]);
    };
    await verify();
    opened.client.close();
    await cli(["daemon", "stop"]);
    await cli(["daemon", "start"]);
    opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    await verify();
    if (scenario === "definition") {
      const committed = spawnSync("git", ["add", "-A"], { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" });
      t.assertions.assert(committed.status === 0, committed.stderr);
      const baseline = spawnSync("git", ["commit", "-m", "snapshot source-loss fixture"], { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" });
      t.assertions.assert(baseline.status === 0, baseline.stderr);
      let dispatched = false;
      let completed = false;
      opened.mock.script(...Array.from({ length: 12 }, () => ({ respond: (request: unknown) => {
        if (JSON.stringify(request).includes("SOURCE_LOSS_WORKER")) {
          if (completed) return { text: "Frozen assignment completed." };
          completed = true;
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence done=frozen-assignment' } } };
        }
        if (dispatched) return { text: "Observed the saved Workflow result." };
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --package local --workflow direct-change --task source-loss --message "run the saved flow" --no-wait' } } };
      } })));
      const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, pm, "Dispatch the saved Workflow after its source has disappeared.");
      let run: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => {
        const history = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
        run = history?.type === "workflowRuns" ? history.data.find(item => item.taskId === "source-loss") : undefined;
        return Boolean(run && ["completed", "blocked", "failed"].includes(run.status));
      }, 40_000);
      t.assertions.assert(run?.status === "completed" && run.dcgDigest === before.activeDigest && completed,
        `frozen dispatch failed: ${JSON.stringify(run)}`);
    }
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

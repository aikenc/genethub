import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

for (const role of ["workflow-manager", "wm", "workflow-reviewer"] as const) defineSpecialty({
  id: `specialty.workflow.maintenance-authority.${role}`,
  title: `${role} retains its delegated Workflow maintenance boundary`,
  oracle: "An explicitly delegated shipped WM (and legacy wm) can activate its own project's candidate; WR and foreign-project activation are refused, and an already-running definition stays pinned",
  catches: ["the shipped workflow-manager is rejected because only wm is recognized", "review authority becomes maintenance authority", "maintenance escapes the project", "activation rewrites an existing Run"],
  tags: ["core", "workflow", "workflow-authority"],
  llm: { default: "mock" }, expectedDurationMs: 15_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.activate", "workflow.dispatch", "workflow.inspect", "workflow.history", "workflow.complete", "session.get"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    const prompt = path.join(source, "prompts/maintenance.md");
    writeFileSync(prompt, "MAINTENANCE_AUTHORITY_WORKER: PM explicitly delegates activation in this project. Submit the actual operation results.\n");
    // Use the shipped role's identity, not a test-only alias or private caller.
    const shipped = readFileSync(path.join(t.openRoot, "apps/daemon/workflow-packages/game-delivery/roles/workflow-manager.yaml"), "utf8");
    writeFileSync(path.join(source, `roles/${role}.yaml`), shipped
      .replace("id: workflow-manager", `id: ${role}`)
      .replace("prompts/workflow-manager.md", "prompts/maintenance.md"));
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [
        { id: "maintain", uses: "agent.session", with: { role },
          completion: { all: [{ key: "report", verify: "value.nonEmpty" }] } },
        { id: "publish", uses: "result.publish" },
      ], structure: {"body":{"id":"sequence","type":"sequence","steps":[{"id":"step-maintain","type":"task","activity":"maintain"},{"id":"step-publish","type":"task","activity":"publish"}]}}}));
    const foreignRoot = path.join(t.env.root, "foreign-project");
    mkdirSync(foreignRoot);
    const foreignSource = t.flows.main.seedWorkflowPackage({ projectRoot: foreignRoot });
    writeFileSync(path.join(foreignSource, "flows/publish.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "publish", version: 2,
       nodes: [{ id: "publish", uses: "result.publish" }], structure: {"body":{"id":"sequence","type":"sequence","steps":[{"id":"step-publish","type":"task","activity":"publish"}]}}}));
    const foreign = await opened.client.call({ type: "workspace.open", payload: { root: foreignRoot } });
    if (foreign?.type !== "workspace") throw new Error("foreign fixture did not open");
    for (const cwd of [opened.workspaceRoot, foreignRoot]) {
      const result = await runGenetAsync(opened.daemon.genet, ["workflow", "activate", "--revision", "0"], opened.daemon.env, { cwd });
      t.assertions.assert(result.code === 0, result.stderr || result.stdout);
    }
    const inspect = async (workspaceId: string) => {
      const reply = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId } });
      if (reply?.type !== "workflowProject") throw new Error("missing Workflow project");
      return reply.data;
    };
    const before = await inspect(opened.workspaceId);
    const foreignBefore = await inspect(foreign.data.id);
    writeFileSync(prompt, readFileSync(prompt, "utf8") + "Updated method for future Runs.\n");

    let dispatched = false, submitted = false;
    const receipt = path.join(t.env.root, "maintenance-receipt.json");
    const command = `
      const fs = require('node:fs');
      const {spawnSync} = require('node:child_process');
      function cli(args) {
        const result = spawnSync(process.env.GENEHUB_CLI, args, {encoding:'utf8'});
        return {code:result.status, stdout:result.stdout, stderr:result.stderr};
      }
      const foreign = cli(['workflow','activate','--workspace',${JSON.stringify(foreign.data.id)},'--revision','1']);
      const own = cli(['workflow','activate','--revision','1']);
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({foreign,own}));
      const complete = cli(['workflow','complete','--evidence','report='+JSON.stringify({foreign,own})]);
      process.stdout.write(JSON.stringify(complete));
      process.exit(complete.code ?? 1);
    `;
    opened.mock.script(...Array.from({ length: 24 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("MAINTENANCE_AUTHORITY_WORKER")) {
        if (submitted) return { text: "Maintenance result submitted." };
        submitted = true;
        return { tool: { name: "bash", arguments: { command: `node -e ${quote(command)}` } } };
      }
      if (dispatched) return { text: "Read the submitted maintenance result." };
      dispatched = true;
      return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task maintain --message "Apply the prepared Workflow candidate in this project and report access failures" --no-wait' } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Delegate the authorized Workflow maintenance.");
    let run: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const history = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (history?.type !== "workflowRuns") return false;
      run = history.data.find(item => item.taskId === "maintain");
      return run?.status === "completed";
    }, 45_000);
    const result = JSON.parse(readFileSync(receipt, "utf8")) as Record<"foreign" | "own", {code: number; stdout: string; stderr: string}>;
    const allowed = role !== "workflow-reviewer";
    t.assertions.assert(allowed ? result.own.code === 0 : result.own.code !== 0 && /forbidden/i.test(JSON.stringify(result.own)),
      `unexpected own-project maintenance authority for ${role}: ${JSON.stringify(result.own)}`);
    t.assertions.assert(result.foreign.code !== 0 && /forbidden/i.test(JSON.stringify(result.foreign)), "maintenance authority escaped the project");
    const after = await inspect(opened.workspaceId);
    const foreignAfter = await inspect(foreign.data.id);
    t.assertions.assert(after.activationRevision === before.activationRevision + (allowed ? 1 : 0), "activation revision did not reflect the authorized operation");
    t.assertions.assert(allowed ? after.activeDigest !== before.activeDigest : after.activeDigest === before.activeDigest, "activation did not preserve role authority");
    t.assertions.assert(foreignAfter.activeDigest === foreignBefore.activeDigest && foreignAfter.activationRevision === foreignBefore.activationRevision, "foreign activation changed");
    t.assertions.assert(run!.dcgDigest === before.activeDigest, "activation rewrote the in-flight Run");
    const worker = run!.nodes.find(node => node.uses === "agent.session")!.sessionId!;
    const session = await opened.client.call({ type: "session.get", payload: { sessionId: worker } });
    t.assertions.assert(session?.type === "snapshot" && session.data.summary.managed?.role === role, "test did not run as the assigned managed role");
    t.note(`${role}: authenticated CLI result, activation revision/digest, project isolation and immutable Run verified`);
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

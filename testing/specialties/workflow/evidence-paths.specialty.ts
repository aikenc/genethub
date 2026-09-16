import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.evidence-paths.private-case",
  title: "Evidence-only Workers reject private directory case variants",
  oracle: "Actual restricted read tools reject mixed-case Git and Session/component storage, allow Unicode deliverables, then submit a managed completion through the bound CLI",
  catches: ["case-sensitive name checks expose private storage on Windows", "hardening denies ordinary artifacts", "restricted completion cannot invoke the bound CLI"],
  tags: ["core", "workflow", "workflow-trials", "evidence-paths"], llm: { default: "mock" },
  expectedDurationMs: 12000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.init", "workflow.activate", "workflow.dispatch", "workflow.history", "workflow.complete", "session.send"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout);
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await cli(["workflow", "init", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash"]);
    const source = path.join(opened.workspaceRoot, ".genethub/workflow");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({ schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet", modelId: "deepseek/deepseek-v4-flash", evidenceOnly: true, userInteraction: "readOnly", prompt: "prompts/direct-worker.md" }));
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "EVIDENCE_PATH_WORKER: inspect bounded evidence, then report completion.");
    writeFileSync(path.join(source, "workflows/direct-change.yaml"), JSON.stringify({ schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [{ id: "inspect", uses: "agent.session", with: { role: "worker" }, completion: { all: [{ key: "report", verify: "value.nonEmpty" }] } }],
      structure: { body: { id: "inspect-step", type: "task", activity: "inspect" } } }));
    const inspected = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    if (inspected?.type !== "workflowProject") throw new Error("missing workflow project");
    await cli(["workflow", "activate", "--revision", String(inspected.data.activationRevision)]);
    const privateFiles = [".GiT/evidence-canary.txt", ".GeNeThUb/SeSsIoNs/evidence-canary.txt", ".genethub/CoMpOnEnTs/evidence-canary.txt"];
    for (const name of privateFiles) {
      mkdirSync(path.dirname(path.join(opened.workspaceRoot, name)), { recursive: true });
      writeFileSync(path.join(opened.workspaceRoot, name), "PRIVATE-CANARY-MUST-NOT-REACH-MODEL");
    }
    const deliverable = "交付 evidence.txt";
    writeFileSync(path.join(opened.workspaceRoot, deliverable), "PUBLIC-EVIDENCE-CANARY");
    let dispatched = false, step = 0;
    opened.mock.script(...Array.from({ length: 16 }, () => ({ respond: (request: unknown) => {
      if (!JSON.stringify(request).includes("EVIDENCE_PATH_WORKER")) {
        if (dispatched) return { text: "Inspection delegated." };
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task evidence-paths --message "Inspect evidence" --no-wait' } } };
      }
      const current = step++;
      if (current < privateFiles.length) return { tool: { name: "read", arguments: { path: privateFiles[current] } } };
      if (current === privateFiles.length) return { tool: { name: "read", arguments: { path: deliverable } } };
      if (current === privateFiles.length + 1) return { tool: { name: "genet", arguments: { args: ["workflow", "complete", "--evidence", "report=bounded inspection"] } } };
      return { text: "Inspection complete." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Run the evidence inspection.");
    let run: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      run = reply?.type === "workflowRuns" ? reply.data.find(item => item.taskId === "evidence-paths") : undefined;
      return !!run && ["completed", "failed", "blocked"].includes(run.status);
    }, 60000);
    t.assertions.assert(run?.status === "completed", `inspection did not complete: ${JSON.stringify(run)}`);
    const requests = JSON.stringify(opened.mock.requests);
    t.assertions.assert(!requests.includes("PRIVATE-CANARY-MUST-NOT-REACH-MODEL"), "private storage content reached the model");
    t.assertions.assert(requests.includes("read private session/runtime evidence through genet instead"), "private reads failed for an unrelated reason");
    t.assertions.assert(requests.includes("PUBLIC-EVIDENCE-CANARY"), "ordinary evidence was not readable");
    for (const name of privateFiles) t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, name), "utf8") === "PRIVATE-CANARY-MUST-NOT-REACH-MODEL", "private file was changed");
  } finally {
    opened.client.close(); await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env); await opened.mock.stop();
  }
});

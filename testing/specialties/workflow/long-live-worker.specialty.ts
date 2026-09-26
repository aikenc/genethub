import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.long-live-worker",
  title: "A live tool call may run beyond the old 180 second node cutoff",
  oracle: "A real Worker process remains assigned after 180 seconds in one tool call, and its submitted result completes the original Run without a recovery attempt",
  catches: ["patrol confuses assignment wall time with a stopped Worker", "long-running tool is interrupted by an artificial 180 second deadline"],
  tags: ["core", "workflow", "workflow-recovery", "long-running"],
  llm: { default: "mock" }, expectedDurationMs: 200_000, timeoutMs: 260_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.dispatch", "workflow.history", "workflow.complete"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "LONG_LIVE_WORKER: submit the result after the tool completes.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet",
      modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/long-worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "long-worker", version: 1, entry: "work",
      nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker" },
          completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    }));
    let dispatched = false, toolStarted = false;
    opened.mock.script(...Array.from({ length: 24 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("LONG_LIVE_WORKER")) {
        if (toolStarted) return { text: "The result was submitted." };
        toolStarted = true;
        return { tool: { name: "bash", arguments: {
          command: 'sleep 185 && "$GENEHUB_CLI" workflow complete --evidence result=delivered',
        } } };
      }
      if (!dispatched) {
        dispatched = true;
        return { tool: { name: "bash", arguments: {
          command: '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow long-worker --task live-tool --message "wait for the real tool" --no-wait',
        } } };
      }
      return { text: "The request is in progress." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, pm, "Run the live tool case.");
    let original: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      original = (await history()).find(run => run.taskId === "live-tool");
      return toolStarted && original?.status === "running" && !!original.nodes.find(node => node.id === "work")?.sessionId;
    }, 30_000);
    const startedAt = Date.now();
    await t.tools.waitUntil(async () => Date.now() - startedAt >= 182_000, 190_000);
    const afterCutoff = await history();
    const current = afterCutoff.find(run => run.id === original!.id);
    t.assertions.assert(current?.status === "running" && current.nodes.find(node => node.id === "work")?.status === "running"
      && !afterCutoff.some(run => run.handles.some(handle => handle.runId === original!.id)),
    "patrol froze a live Worker at the old 180 second wall cutoff");
    await t.tools.waitUntil(async () => (await history()).find(run => run.id === original!.id)?.status === "completed", 35_000);
    t.assertions.assert((await history()).filter(run => run.requestRunId === original!.id).length === 1,
      "the long tool created an extra Run");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

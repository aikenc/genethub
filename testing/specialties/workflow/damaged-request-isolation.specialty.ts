import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.damaged-request-isolation",
  title: "One damaged historical Run does not stop healthy requests or recovery",
  oracle: "After a completed Run snapshot is corrupted, project history still serves healthy Runs, check names the damaged Run, a new PM request dispatches, and package recovery starts for a later blocked request",
  catches: ["one damaged snapshot breaks project history", "implicit request association parses unrelated Run snapshots", "package recovery admission treats damaged terminal history as an active recovery"],
  tags: ["core", "workflow", "storage", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 55_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.dispatch", "workflow.history", "workflow.check", "workflow.recovery", "session.send"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "DAMAGED_REQUEST_WORKER: settle this request.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet",
      modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/damage-isolation.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "damage-isolation", version: 1, entry: "work",
      nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker", workspace: "." },
          completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    }));
    const submitted = new Set<string>();
    const dispatched = new Set<string>();
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("只读复查被处理的 Run")) return { text: "Waiting for the PM recovery decision." };
      if (body.includes("DAMAGED_REQUEST_WORKER")) {
        const task = ["isolation-one", "isolation-two", "isolation-broken"].find(id => body.includes(id));
        if (!task || submitted.has(task)) return { text: "Result was already submitted." };
        submitted.add(task);
        const command = task === "isolation-broken"
          ? '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "injected business failure" --evidence result=failed'
          : '"$GENEHUB_CLI" workflow complete --evidence result=done';
        return { tool: { name: "bash", arguments: { command } } };
      }
      for (const task of ["isolation-one", "isolation-two", "isolation-broken"]) {
        if (body.includes(`START_${task}`) && !dispatched.has(task)) {
          dispatched.add(task);
          const activate = task === "isolation-one" ? '"$GENEHUB_CLI" workflow activate --revision 0 && ' : "";
          return { tool: { name: "bash", arguments: {
            command: `${activate}"$GENEHUB_CLI" workflow dispatch --workflow damage-isolation --task ${task} --message "${task}" --no-wait`,
          } } };
        }
      }
      return { text: "The Workflow is being supervised." };
    };
    opened.mock.script(...Array.from({ length: 60 }, () => ({ respond })));
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (reply?.type !== "workflowRuns") throw new Error("healthy Workflow history became unavailable");
      return reply.data;
    };
    const dispatch = async (task: string) => {
      const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, pm, `START_${task}`);
    };
    await dispatch("isolation-one");
    let first: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      first = (await history()).find(run => run.taskId === "isolation-one");
      return first?.status === "completed";
    }, 45_000);
    const snapshot = path.join(opened.workspaceRoot, ".genethub/components/pm/requests", first!.id, "runs", first!.id, "run.json");
    writeFileSync(snapshot, "damaged snapshot\n");

    await dispatch("isolation-two");
    await t.tools.waitUntil(async () => (await history()).some(run => run.taskId === "isolation-two" && run.status === "completed"), 45_000);
    t.assertions.assert(!(await history()).some(run => run.id === first!.id), "corrupt Run was reported as healthy");
    const report = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId } });
    t.assertions.assert(report?.type === "workflowCheck"
      && report.data.findings.some(f => f.runId === first!.id && f.code === "runUnreadable")
      && report.data.runs.some(run => run.taskId === "isolation-two"),
    "project check did not isolate and identify the damaged Run");

    await dispatch("isolation-broken");
    let blocked: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      blocked = (await history()).find(run => run.taskId === "isolation-broken");
      return blocked?.status === "blocked";
    }, 45_000);
    await t.tools.waitUntil(async () => (await history()).some(run => run.handles.some(handle => handle.runId === blocked!.id)), 45_000);
    t.assertions.assert((await history()).filter(run => run.handles.some(handle => handle.runId === blocked!.id)).length === 1,
      "damaged terminal history blocked recovery or created duplicate recovery Runs");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

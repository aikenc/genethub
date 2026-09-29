import { cpSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.damaged-request-isolation",
  title: "Damaged request history does not stop unrelated dispatch or recovery",
  oracle: "An invalid request directory and a damaged unrelated request record do not block new PM messages; a damaged Run snapshot leaves healthy history queryable and recovery available",
  catches: ["invalid request directory blocks all dispatch", "unrelated damaged request record blocks all dispatch", "one damaged snapshot breaks project history", "package recovery admission treats damaged terminal history as an active recovery"],
  tags: ["core", "workflow", "storage", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 75_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.dispatch", "workflow.history", "workflow.check", "workflow.recovery", "session.send"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const submitted = new Set<string>();
  let stage = "setup";
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "DAMAGED_REQUEST_WORKER: settle this request.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({schema: "genehub.workflow.role.v3", tags: ["Flash"], id: "worker", userInteraction: "readOnly", prompt: "prompts/worker.md"}));
    writeFileSync(path.join(source, "flows/damage-isolation.yaml"), JSON.stringify({schema: "genehub.workflow.definition.v2",
id: "damage-isolation",
version: 1,
nodes: [{id: "work", uses: "agent.session", with: { role: "worker", workspace: "." }, completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }},
{id: "publish", uses: "result.publish"}],
structure: {
  "body": {
    "id": "sequence-work",
    "type": "sequence",
    "steps": [
      {
        "id": "step-work",
        "type": "task",
        "activity": "work",
        "accept": [
          "completed"
        ]
      },
      {
        "id": "step-publish",
        "type": "task",
        "activity": "publish"
      }
    ]
  }
}}));
    const submitted = new Set<string>();
    const dispatched = new Set<string>();
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("角色标签为 `recovery-reviewer`")) return { text: "Waiting for the PM recovery decision." };
      if (body.includes("DAMAGED_REQUEST_WORKER")) {
        const task = body.match(/任务 ID：(isolation-(?:one|two|three|broken))/)?.[1];
        if (!task || submitted.has(task)) return { text: "Result was already submitted." };
        submitted.add(task);
        const command = task === "isolation-broken"
          ? '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "injected business failure" --evidence result=failed'
          : '"$GENEHUB_CLI" workflow complete --evidence result=done';
        return { tool: { name: "bash", arguments: { command } } };
      }
      for (const task of ["isolation-one", "isolation-two", "isolation-three", "isolation-broken"]) {
        if (body.includes(`START_${task}`) && !dispatched.has(task)) {
          dispatched.add(task);
          const activate = task === "isolation-one" ? '"$GENEHUB_CLI" workflow activate --revision 0 && ' : task === "isolation-broken" ? '"$GENEHUB_CLI" workflow activate --package isolated-recovery --revision 0 && ' : "";
          return { tool: { name: "bash", arguments: {
            command: `${activate}"$GENEHUB_CLI" workflow dispatch ${task === "isolation-broken" ? "--package isolated-recovery " : ""}--workflow damage-isolation --task ${task} --message "${task}" --no-wait`,
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
    const requests = path.join(opened.workspaceRoot, ".genethub/components/pm/requests");
    const invalidDirectory = path.join(requests, "invalid!request");
    mkdirSync(invalidDirectory);
    await dispatch("isolation-two");
    await t.tools.waitUntil(async () => (await history()).some(run => run.taskId === "isolation-two" && run.status === "completed"), 45_000);
    rmdirSync(invalidDirectory);

    const requestRecord = path.join(requests, first!.id, "request.json");
    const savedRequest = readFileSync(requestRecord);
    writeFileSync(requestRecord, "damaged request record\n");
    await dispatch("isolation-three");
    await t.tools.waitUntil(async () => (await history()).some(run => run.taskId === "isolation-three" && run.status === "completed"), 45_000);
    writeFileSync(requestRecord, savedRequest);

    const snapshot = path.join(requests, first!.id, "runs", first!.id, "run.json");
    writeFileSync(snapshot, "damaged snapshot\n");
    t.assertions.assert(!(await history()).some(run => run.id === first!.id), "corrupt Run was reported as healthy");
    const report = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId, runId: null } });
    t.assertions.assert(report?.type === "workflowCheck"
      && report.data.findings.some(f => f.runId === first!.id && f.code === "runUnreadable")
      && report.data.runs.some(run => run.taskId === "isolation-two"),
    "project check did not isolate and identify the damaged Run");

    cpSync(source, path.join(opened.workspaceRoot, ".genethub/workflows/isolated-recovery"), { recursive: true });
    await dispatch("isolation-broken");
    stage = "observe unrelated failed business";
    let blocked: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      blocked = (await history()).find(run => run.taskId === "isolation-broken");
      return blocked?.status === "blocked";
    }, 45_000);
    stage = "observe isolated recovery";
    await t.tools.waitUntil(async () => (await history()).some(run => run.handles.some(handle => handle.runId === blocked!.id)), 45_000);
    t.assertions.assert((await history()).filter(run => run.handles.some(handle => handle.runId === blocked!.id)).length === 1,
      "damaged terminal history blocked recovery or created duplicate recovery Runs");
  } catch (error) {
    const runs = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } }).catch(() => null);
    throw new Error(`${stage}: ${error}; runs=${JSON.stringify(runs)}; submitted=${JSON.stringify([...submitted])}`);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

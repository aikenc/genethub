import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const shape of ["graph", "structured"] as const) defineSpecialty({
  id: `specialty.workflow.route-after-progress.${shape}`,
  title: `A missing route after committed progress resumes the same ${shape} Run`,
  oracle: "The first Worker settles once; a missing successor route is visible to PM without starting recovery, and patrol starts only the pending successor when its route returns",
  catches: ["mid-run route failure is classified as an execution exception", "a completed predecessor is replayed", "a structured snapshot is aborted before its pending activity can resume"],
  tags: ["core", "workflow", "tag-routing", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 35_000, timeoutMs: 110_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.dispatch", "workflow.history", "workflow.journal", "settings.setAgentPreferences"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const profiles = (successorAvailable: boolean) => ({
      runtimes: {}, selectedTags: ["Max"], modelProfiles: [
        { agentId: "genet", modelId: "deepseek/deepseek-v4-flash", tags: ["Max"], cost: "low" },
        ...(successorAvailable ? [{ agentId: "genet", modelId: "deepseek/deepseek-v4-pro", tags: ["Pro"], cost: "high" }] : []),
      ],
    });
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: profiles(false) } });
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    for (const [id, tag] of [["first", "Max"], ["second", "Pro"]] as const) {
      writeFileSync(path.join(source, `prompts/${id}.md`), `ROUTE_AFTER_${id.toUpperCase()}: submit the bound result.\n`);
      writeFileSync(path.join(source, `roles/${id}.yaml`), JSON.stringify({
        schema: "genehub.workflow.role.v3", id, tags: [tag],
        userInteraction: "readOnly", prompt: `prompts/${id}.md`,
      }));
    }
    const worker = (id: string) => ({
      id, uses: "agent.session", with: { role: id, workspace: "." },
      completion: { all: [{ key: "result", verify: "value.nonEmpty" }] },
    });
    const definition = shape === "graph" ? {
      schema: "genehub.workflow.definition.v1", id: "route-after-progress", version: 1, entry: "first",
      nodes: [
        { ...worker("first"), on: { completed: ["budget"] } },
        { id: "budget", uses: "request.budget", on: { completed: ["second"] } },
        { ...worker("second"), on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    } : {
      schema: "genehub.workflow.definition.v2", id: "route-after-progress", version: 2,
      nodes: [worker("first"), worker("second"), { id: "publish", uses: "result.publish" }],
      structure: { input: {}, body: { id: "root", type: "sequence", steps: [
        { id: "step-first", type: "task", activity: "first", input: { op: "literal", value: null } },
        { id: "step-second", type: "task", activity: "second", input: { op: "literal", value: null } },
        { id: "step-publish", type: "task", activity: "publish", input: { op: "literal", value: null } },
      ] } },
    };
    writeFileSync(path.join(source, "flows/route-after-progress.yaml"), JSON.stringify(definition));

    let dispatchSent = false, firstSubmitted = false, secondSubmitted = false, firstCalls = 0;
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("ROUTE_AFTER_FIRST")) {
        firstCalls += 1;
        if (firstSubmitted) return { text: "First result already submitted." };
        firstSubmitted = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence result=first-done' } } };
      }
      if (body.includes("ROUTE_AFTER_SECOND")) {
        if (secondSubmitted) return { text: "Second result already submitted." };
        secondSubmitted = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence result=second-done' } } };
      }
      if (!dispatchSent) {
        dispatchSent = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow route-after-progress --task route-after-progress --message "finish both steps" --no-wait' } } };
      }
      return { text: "Waiting for the configured route." };
    };
    opened.mock.script(...Array.from({ length: 40 }, () => ({ respond })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, pm, "Dispatch the two-step Workflow.");
    let blocked: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      blocked = (await history()).find(run => run.taskId === "route-after-progress");
      return blocked?.status === "blocked" && blocked.reason?.includes("RouteUnavailable");
    }, 50_000);
    t.assertions.assert(firstSubmitted && !secondSubmitted && blocked!.nodes.some(node => node.status === "completed" && node.uses === "agent.session"),
      "the first Worker did not settle before the route block");
    if (shape === "graph") t.assertions.assert(blocked!.nodes.some(node => node.status === "completed" && node.uses === "request.budget"),
      "the host-completed predecessor was rolled back with the missing route");
    t.assertions.assert((await history()).length === 1, "route loss created a recovery Run");
    const firstCallsBeforeRoute = firstCalls;
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: profiles(true) } });
    await t.tools.waitUntil(async () => (await history()).some(run => run.id === blocked!.id && run.status === "completed"), 45_000);
    const runs = await history();
    t.assertions.assert(runs.length === 1 && runs[0]!.id === blocked!.id && secondSubmitted && firstCalls === firstCallsBeforeRoute,
      "route restoration replayed the predecessor or replaced the Run");
    const journalResult = await runGenetAsync(opened.daemon.genet,
      ["workflow", "journal", "--run", blocked!.id, "--since", "0", "--limit", "100"],
      opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(journalResult.code === 0, `workflow journal failed: ${journalResult.stderr}`);
    const journal = JSON.parse(journalResult.stdout) as { data?: { events?: Array<{ eventType?: string; actor?: string }> } };
    t.assertions.assert(journal.data?.events?.some(item => item.eventType === "run.running" && item.actor === "patrol"),
      "patrol did not record the route resumption");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

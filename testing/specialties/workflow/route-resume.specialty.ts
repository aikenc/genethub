import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.route-resume",
  title: "An initial route block resumes in the same business Run",
  oracle: "The initial node blocks when no tagged model exists; after the route returns, patrol starts that untouched node in the original Run and records its patrol transition without creating a recovery Run",
  catches: ["route absence starts an unnecessary recovery", "patrol leaves a newly available route blocked", "resumption creates a second Run", "patrol's transition has no event reference"],
  tags: ["core", "workflow", "tag-routing", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 30_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.dispatch", "workflow.history", "workflow.journal", "settings.setAgentPreferences"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const profiles = (available: boolean) => ({
      runtimes: {}, selectedTags: ["Max"], modelProfiles: [{
        agentId: "genet", modelId: "deepseek/deepseek-v4-flash",
        tags: available ? ["Max"] : ["Flash"], cost: "low",
      }],
    });
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: profiles(false) } });
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "ROUTE_RESUME_WORKER: submit one result.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v3", id: "worker", tags: ["Max"],
      userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/route-resume.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "route-resume", version: 1, entry: "work",
      nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker", workspace: "." },
          completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    }));
    let started = false, workerSubmitted = false;
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("ROUTE_RESUME_WORKER")) {
        if (workerSubmitted) return { text: "Result submitted." };
        workerSubmitted = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence result=delivered' } } };
      }
      if (!started) {
        started = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow route-resume --task resume-original --message "deliver when route is available" --no-wait' } } };
      }
      return { text: "Waiting for route configuration." };
    };
    opened.mock.script(...Array.from({ length: 30 }, () => ({ respond })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, pm, "Dispatch the route-resume case.");
    let blocked: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      blocked = (await history()).find(run => run.taskId === "resume-original");
      return blocked?.status === "blocked" && blocked.reason?.includes("RouteUnavailable");
    }, 30_000);
    t.assertions.assert(!workerSubmitted && blocked!.nodes.find(node => node.id === "work")?.sessionId === undefined,
      "route block already started a Worker");
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: profiles(true) } });
    await t.tools.waitUntil(async () => (await history()).some(run => run.id === blocked!.id && run.status === "completed"), 30_000);
    const runs = await history();
    t.assertions.assert(runs.length === 1 && runs[0]!.id === blocked!.id && workerSubmitted,
      "route recovery replaced the original business Run");
    const journalResult = await runGenetAsync(opened.daemon.genet,
      ["workflow", "journal", "--run", blocked!.id, "--since", "0", "--limit", "100"],
      opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(journalResult.code === 0, `workflow journal failed: ${journalResult.stderr}`);
    const journal = JSON.parse(journalResult.stdout) as { data?: { events?: Array<{ eventType?: string; actor?: string }> } };
    t.assertions.assert(journal.data?.events?.some(item => {
      return item.eventType === "run.running" && item.actor === "patrol";
    }), "route resumption was not attributed to patrol in the committed journal");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

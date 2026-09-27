import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { defineSpecialty, runGenetAsync, parseJson } from "../../framework/public.ts";

for (const runtime of ["mock", "codex-luna"] as const) defineSpecialty({
  id: runtime === "mock" ? "specialty.workflow.exact-model" : "specialty.workflow.exact-model.codex-luna",
  title: "User-selected workflow model overrides defaults and survives successors",
  oracle: "An exact request starts despite nonmatching default role tags; its successor retains the same model, every real Worker session uses it, and machine preferences stay unchanged",
  catches: ["PM cannot express a clear model requirement", "retry silently drops the exact target", "per-request choice mutates other projects' global routing"],
  tags: ["core", "workflow", "tag-routing", "workflow-recovery"],
  llm: { default: runtime === "mock" ? "mock" : "real" }, expectedDurationMs: runtime === "mock" ? 30_000 : 90_000, timeoutMs: runtime === "mock" ? 90_000 : 300_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: runtime === "mock" ? "standard" : "real-llm" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["workflow.dispatch", "workflow.history", "session.list", "settings.get", "genet schema workflow.dispatch"],
}, async t => {
  t.data.git.init(t.env.workspace);
  if (runtime === "codex-luna") t.flows.main.seedHostCodexLogin(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let stage = "setup";
  try {
    const discovery = await runGenetAsync(opened.daemon.genet, ["schema", "workflow.dispatch"], opened.daemon.env);
    t.assertions.assert(discovery.code === 0, `Dispatch schema unavailable: ${discovery.stderr}`);
    const schema = (parseJson(discovery.stdout).data as { command: { synopsis: string; inputSchema: { properties: { agentTarget?: { required: string[]; additionalProperties: boolean } } } } }).command;
    t.assertions.assert(schema.synopsis.includes("--agent <id> --model <id>"), "Agent capability discovery hides exact-model dispatch flags");
    const exactTarget = schema.inputSchema.properties.agentTarget;
    t.assertions.assert(exactTarget?.required.includes("agentId") && exactTarget.required.includes("modelId") && exactTarget.additionalProperties === false, "Dispatch schema does not declare a complete paired exact destination");
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const target = runtime === "mock" ? { agentId: "genet", modelId: "deepseek/deepseek-v4-flash" } : { agentId: "codex", modelId: "gpt-6-luna" };
    if (runtime === "codex-luna") await t.flows.main.requireAgentReady(opened.client, "codex");
    const preferences = { runtimes: {}, modelProfiles: [{ ...target, tags: ["Flash"], cost: "low" as const }] };
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences } });
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "EXACT_MODEL_WORKER: Create exactly the task-requested receipt file with content workflow exact target verified, then submit workflow complete with --evidence result=delivered. Do not change any other files.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v3", id: "worker", tags: ["Max"],
      userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/exact.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "exact", version: 1, entry: "work",
      nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker", workspace: "." },
          completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    }));
    let firstDispatched = false, successorDispatched = false, originalRun = "";
    opened.mock.script(...Array.from({ length: 40 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      const tool = (command: string) => ({ tool: { name: "bash", arguments: { command } } });
      if (body.includes("EXACT_MODEL_WORKER")) {
        const messages = (request as { messages?: Array<{ role?: string; tool_calls?: Array<{ function?: { arguments?: string } }> }> }).messages ?? [];
        if (messages.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.function?.arguments?.includes("workflow complete --evidence result=delivered")))) {
          return { text: "Worker result submitted." };
        }
        const receipt = body.includes("delivery-two.txt") ? "delivery-two.txt" : "delivery-one.txt";
        return tool(`printf '%s\\n' 'workflow exact target verified' > ${receipt} && "$GENEHUB_CLI" workflow complete --evidence result=delivered`);
      }
      if (!firstDispatched) {
        firstDispatched = true;
        return tool(`"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow exact --agent ${target.agentId} --model ${target.modelId} --task exact-original --message "Write delivery-one.txt containing workflow exact target verified, then report evidence result=delivered" --no-wait`);
      }
      if (originalRun && body.includes("EXACT_MODEL_SUCCESSOR") && !successorDispatched) {
        successorDispatched = true;
        return tool(`"$GENEHUB_CLI" workflow dispatch --workflow exact --retry-of ${originalRun} --task exact-successor --message "Write delivery-two.txt containing workflow exact target verified, then report evidence result=delivered" --no-wait`);
      }
      return { text: "Delegation is recorded." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("History unavailable");
      return reply.data;
    };
    stage = "original dispatch";
    await t.flows.main.sendPrompt(opened.client, pm, "Use the exact Agent/model for this delivery.");
    await t.tools.waitUntil(async () => {
      const run = (await history()).find(r => r.taskId === "exact-original");
      if (run?.status !== "completed") return false;
      originalRun = run.id;
      return true;
    }, runtime === "mock" ? 30_000 : 120_000);
    stage = "wait for PM idle";
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      return reply?.type === "snapshot" && reply.data.summary.status !== "running";
    }, 10_000);
    stage = "successor completion";
    await t.flows.main.sendPrompt(opened.client, pm, "EXACT_MODEL_SUCCESSOR: Continue with the authorized successor; keep the original model.");
    await t.tools.waitUntil(async () => (await history()).some(r => r.taskId === "exact-successor" && r.status === "completed"), runtime === "mock" ? 30_000 : 120_000);
    for (const receipt of ["delivery-one.txt", "delivery-two.txt"]) {
      t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, receipt), "utf8").trim() === "workflow exact target verified", `Worker did not create ${receipt}`);
    }
    const runs = await history();
    t.assertions.assert(runs.length === 2, "request unexpectedly created extra Runs");
    for (const run of runs) {
      t.assertions.assert(JSON.stringify(run.agentTarget) === JSON.stringify(target), "successor lost the original exact target");
      t.assertions.assert(run.requestRunId === originalRun, "successor changed request identity");
    }
    const sessions = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: false } });
    t.assertions.assert(sessions?.type === "sessions", "sessions unavailable");
    if (sessions?.type === "sessions") {
      const workers = sessions.data.filter(s => s.managed?.nodeId === "work");
      t.assertions.assert(workers.length === 2 && workers.every(s => s.agentId === target.agentId && s.modelId === target.modelId), "native Worker destination differs from request");
    }
    const settings = await opened.client.call({ type: "settings.get" });
    t.assertions.assert(settings?.type === "settings" && JSON.stringify(settings.data.agentPreferences?.modelProfiles) === JSON.stringify(preferences.modelProfiles), "request rewrote machine-global model profiles");
    t.note("Exact target dispatched two native Workers with no globally matching Max tag; successor inherited the same request target.");
  } catch (cause) {
    const runs = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } }).catch(() => undefined);
    const sessions = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: false } }).catch(() => undefined);
    throw new Error(`${String(cause)}; stage=${stage}; publicRuns=${JSON.stringify(runs)}; publicSessions=${JSON.stringify(sessions)}`);
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

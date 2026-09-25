import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-budget-human",
  title: "Human recovery budget approval extends only one request",
  oracle: "A one-second recovery budget stops the recovery Worker, produces exit c, persists one approval in the PM request, and admits exactly one further recovery attempt",
  catches: ["recovery runs spend the business budget", "recovery budget exhaustion silently stalls", "exit c approval is lost or spent twice", "a second recovery attempt ignores the approved allowance"],
  tags: ["core", "workflow", "workflow-recovery", "session-attention"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 115_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.history", "workflow.activate", "session.respondPermission", "Workflow request.json"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let stage = "setup";
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "workflow.md"), "---\ndescription: recovery budget fixture\nrecovery: flows/recovery.yaml\n---\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet",
      modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "prompts/worker.md"), "BUDGET_BUSINESS_WORKER: report the original defect.\n");
    writeFileSync(path.join(source, "roles/recovery-worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v1", id: "recovery-worker", agentId: "genet",
      modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/recovery-worker.md",
    }));
    writeFileSync(path.join(source, "prompts/recovery-worker.md"), "BUDGET_RECOVERY_WORKER: review the defect until the recovery budget stops this attempt.\n");
    writeFileSync(path.join(source, "flows/business.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "business", version: 1, entry: "work",
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker" },
        completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" }],
    }));
    writeFileSync(path.join(source, "flows/recovery.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "recovery", version: 1, entry: "review",
      budget: { maxRuns: 1, maxLlmRounds: 200, deadlineSeconds: 1 },
      outcomes: { resume: { success: true }, human: { success: false } },
      nodes: [{ id: "review", uses: "agent.session", with: { role: "recovery-worker" }, on: { resume: ["publish"], human: [] } },
        { id: "publish", uses: "result.publish" }],
    }));
    const activation = await runGenetAsync(opened.daemon.genet, ["workflow", "activate", "--revision", "0"],
      opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(activation.code === 0, `custom recovery activation failed: ${activation.stderr || activation.stdout}`);

    let sent = false, businessSubmitted = false;
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("BUDGET_BUSINESS_WORKER")) {
        if (businessSubmitted) return { text: "The business defect was reported." };
        businessSubmitted = true;
        return { tool: { name: "bash", arguments: {
          command: '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "execution failed" --evidence result=failed',
        } } };
      }
      if (body.includes("BUDGET_RECOVERY_WORKER")) return { hang: true as const };
      if (!sent) {
        sent = true;
        return { tool: { name: "bash", arguments: {
          command: '"$GENEHUB_CLI" workflow dispatch --workflow business --task budget-business --message "deliver" --no-wait',
        } } };
      }
      return { text: "The request remains under supervision." };
    };
    opened.mock.script(...Array.from({ length: 60 }, () => ({ respond })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Start the budget-limited request.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    let root: WorkflowRunStatus | undefined;
    let recovery: WorkflowRunStatus | undefined;
    stage = "wait for recovery budget Human card";
    await t.tools.waitUntil(async () => {
      const runs = await history();
      root = runs.find(run => run.taskId === "budget-business");
      recovery = runs.find(run => run.handles.some(handle => handle.runId === root?.id));
      return recovery?.status === "blocked" && recovery.humanExit?.kind === "c";
    }, 55_000);
    t.assertions.assert(root?.status === "blocked" && recovery!.reason?.includes("recoveryBudgetExceeded"),
      "recovery budget did not stop the recovery Worker while preserving the business request");
    const cardReply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
    if (cardReply?.type !== "snapshot") throw new Error("PM card unavailable");
    const card = cardReply.data.pendingPermissions.find(item => item.id === recovery!.humanExit!.requestId);
    t.assertions.assert(card?.options?.map(option => option.id).join(",") === "approve,reject", "exit c options are incorrect");
    const answered = await opened.client.call({ type: "session.respondPermission", payload: {
      sessionId: pm, requestId: card!.id, outcome: { outcome: "selected", optionId: "approve" },
    } });
    t.assertions.assert(answered?.type === "ack", "Human approval was not accepted");
    stage = "wait for second recovery attempt";
    await t.tools.waitUntil(async () => {
      const runs = await history();
      return runs.filter(run => run.handles.some(handle => handle.runId === root!.id)).length === 2
        && runs.some(run => run.id === recovery!.id && run.humanExit?.answer === "approve");
    }, 35_000);
    const runs = await history();
    const attempts = runs.filter(run => run.handles.some(handle => handle.runId === root!.id));
    t.assertions.assert(attempts.length === 2 && attempts[0]!.id !== attempts[1]!.id,
      "Human c approval did not admit exactly one new recovery Run");
    const request = JSON.parse(readFileSync(path.join(opened.workspaceRoot,
      ".genethub/components/pm/requests", root!.id, "request.json"), "utf8")) as {
      recoveryExtra: { maxRuns: number; maxLlmRounds: number; deadlineSeconds: number };
      approvedHumanExits: string[];
    };
    t.assertions.assert(request.recoveryExtra.maxRuns === 1 && request.recoveryExtra.maxLlmRounds === 100
      && request.recoveryExtra.deadlineSeconds === 1800
      && request.approvedHumanExits.filter(id => id === card!.id).length === 1,
    "Human c approval was not applied once to this PM request");
    const journal = await runGenetAsync(opened.daemon.genet,
      ["workflow", "journal", "--run", recovery!.id, "--since", "0", "--limit", "100"],
      opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(journal.code === 0, `recovery journal unavailable: ${journal.stderr || journal.stdout}`);
    const events = (JSON.parse(journal.stdout) as { data: { events: Array<{
      eventType: string; actor: string; messageId?: string;
    }> } }).data.events;
    t.assertions.assert(events.some(event => event.eventType === "recovery.budgetUpdated"
      && event.actor === "human" && event.messageId === card!.id),
    "Human c approval omitted its committed journal reference");
  } catch (error) {
    throw new Error(`${stage}: ${error}`);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

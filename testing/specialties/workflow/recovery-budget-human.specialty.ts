import { workflowSequence, writeWorkflowFlow, writeWorkflowRole } from "../../framework/public.ts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PermissionRequest, WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-budget-human",
  title: "Human recovery budget approval extends only one request",
  oracle: "A one-round recovery budget stops the recovery Worker, produces exit c, persists one approval in the PM request, and admits exactly one further recovery attempt",
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
    writeWorkflowRole(source, "worker.yaml", {tags: ["Flash"], id: "worker", userInteraction: "readOnly", prompt: "prompts/worker.md"});
    writeFileSync(path.join(source, "prompts/worker.md"), "BUDGET_BUSINESS_WORKER: report the original defect.\n");
    writeWorkflowRole(source, "recovery-worker.yaml", {tags: ["Flash"], id: "recovery-worker", userInteraction: "readOnly", prompt: "prompts/recovery-worker.md"});
    writeFileSync(path.join(source, "prompts/recovery-worker.md"), "BUDGET_RECOVERY_WORKER: review the defect until the recovery budget stops this attempt.\n");
    writeWorkflowFlow(source, "business.yaml", {id: "business",
nodes: [{id: "work", uses: "agent.session", with: { role: "worker" }, completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }},
{id: "publish", uses: "result.publish"}],
structure: workflowSequence([{"activity": "work", "accept": ["completed"]}, {"activity": "publish"}], "sequence-work")});
    writeWorkflowFlow(source, "recovery.yaml", {id: "recovery",
budget: { maxRuns: 1, maxLlmRounds: 1 },
outcomes: { resume: { success: true }, human: { success: false } },
nodes: [{id: "review", uses: "agent.session", with: { role: "recovery-worker" }},
{id: "publish", uses: "result.publish"}],
structure: {
  "body": {
    "id": "sequence-review",
    "type": "sequence",
    "steps": [
      {
        "id": "step-review",
        "type": "task",
        "activity": "review",
        "accept": [
          "resume"
        ]
      },
      {
        "id": "choose-review",
        "type": "choice",
        "branches": [
          {
            "condition": {
              "op": "eq",
              "left": {
                "op": "ref",
                "path": "/results/step-review/outcome"
              },
              "right": {
                "op": "literal",
                "value": "resume"
              }
            },
            "body": {
              "id": "step-publish",
              "type": "task",
              "activity": "publish"
            }
          }
        ],
        "default": {
          "id": "end-review",
          "type": "sequence",
          "steps": []
        }
      }
    ]
  }
}});
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
      if (body.includes("BUDGET_RECOVERY_WORKER")) return { text: "Reviewed one round without a controlled exit." };
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
    // The durable Human exit is saved before its question is delivered to the
    // Session. Wait for that public delivery, then validate its exact options.
    stage = "wait for persisted Human exit to reach PM Session";
    let card: PermissionRequest | undefined;
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("PM card unavailable");
      card = reply.data.pendingPermissions.find(item => item.id === recovery!.humanExit!.requestId);
      return card !== undefined;
    }, 20_000);
    t.assertions.assert(card!.options?.map(option => option.id).join(",") === "approve,reject",
      `exit c options are incorrect: ${JSON.stringify(card!.options)}`);
    t.assertions.assert(card!.options?.find(option => option.id === "approve")?.label.includes("1 次恢复、100 轮 LLM")
      && card!.description?.includes("本卡审批固定额度"), "recovery grant was confused with the business quota");
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
      recoveryExtra: { maxRuns: number; maxLlmRounds: number };
      approvedHumanExits: string[];
    };
    t.assertions.assert(request.recoveryExtra.maxRuns === 1 && request.recoveryExtra.maxLlmRounds === 100
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
    const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } }).catch(() => null);
    const runs = reply?.type === "workflowRuns" ? reply.data.map(run => ({
      id: run.id, taskId: run.taskId, status: run.status, reason: run.reason,
      handles: run.handles, humanExit: run.humanExit,
    })) : [];
    const requests = opened.mock.requests.map(request => {
      const body = JSON.stringify(request);
      return body.includes("BUDGET_RECOVERY_WORKER") ? "recovery"
        : body.includes("BUDGET_BUSINESS_WORKER") ? "business" : "pm";
    });
    throw new Error(`${stage}: ${error}; public runs=${JSON.stringify(runs).slice(0, 6000)}; model lanes=${JSON.stringify(requests)}`);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

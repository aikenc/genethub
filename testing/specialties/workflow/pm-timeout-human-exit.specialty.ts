import { workflowSequence, writeWorkflowFlow, writeWorkflowRole } from "../../framework/public.ts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const exit of ["d", "a", "e"] as const) defineSpecialty({
  id: `specialty.workflow.${exit === "d" ? "untimed-route-survives-restart" : `business-human-${exit}`}`,
  title: exit === "d" ? "An overdue PM route decision does not open a Human card" : `PM requests Human exit ${exit} for a blocked business Run`,
  oracle: exit === "d"
    ? "A route block stays visible after its original PM Session is deleted, and rewriting the persisted clock does not produce Human exit d"
    : "An explicit PM Human exit creates the correct durable options; approval a amends only this request budget and abandonment e cancels the request",
  catches: ["route block incorrectly starts recovery", "deleting PM hides an unfinished project request", "overdue PM has no Human owner", "restart duplicates Human cards", "feedback option is missing"],
  tags: ["core", "workflow", "workflow-recovery", "session-attention"],
  llm: { default: "mock" }, expectedDurationMs: 35_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.history", "workflow.get", "session.get", "session.respondPermission"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "PM_TIMEOUT_WORKER: route must be installed first.\n");
    writeWorkflowRole(source, "worker.yaml", {
      id: "worker", tags: ["Max"],
      userInteraction: "readOnly", prompt: "prompts/worker.md",
    });
    writeWorkflowFlow(source, "pm-timeout.yaml", {id: "pm-timeout",
nodes: [{id: "work", uses: "agent.session", with: { role: "worker", workspace: "." }, completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }},
{id: "publish", uses: "result.publish"}],
structure: workflowSequence([{"activity": "work", "accept": ["completed"]}, {"activity": "publish"}], "sequence-work")});
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: {
      runtimes: {}, selectedTags: ["Max"], modelProfiles: [{ agentId: "genet",
        modelId: "deepseek/deepseek-v4-flash", tags: ["Flash"], cost: "low" }],
    } } });
    let dispatched = false;
    let humanRequested = false;
    let nextCommand: string | undefined;
    let original: WorkflowRunStatus | undefined;
    opened.mock.script(...Array.from({ length: 24 }, () => ({ respond: (request: unknown) => {
      if (nextCommand) { const command = nextCommand; nextCommand = undefined; return { tool: { name: "bash", arguments: { command } } }; }
      if (exit !== "d" && !humanRequested && JSON.stringify(request).includes("ASK_BUSINESS_HUMAN")) {
        humanRequested = true;
        return { tool: { name: "bash", arguments: { command:
          `"$GENEHUB_CLI" workflow human --run ${original!.id} --revision ${original!.revision} --kind ${exit} --reason "PM requests 100 rounds and 30 minutes; verify the fixed grant before approval"`,
        } } };
      }
      if (dispatched) return { text: "The route remains unavailable." };
      dispatched = true;
      return { tool: { name: "bash", arguments: { command:
        '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow pm-timeout --task overdue-route --message "deliver after route repair" --no-wait',
      } } };
    } })));
    let pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Start the route decision case.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    await t.tools.waitUntil(async () => {
      original = (await history()).find(run => run.taskId === "overdue-route");
      return original?.status === "running" && original.phase === "open" && !original.programResult && original.conditions.some(condition => condition.code === "routeUnavailable");
    }, 30_000);
    t.assertions.assert((await history()).length === 1 && !original!.humanExit,
      "normal route block skipped PM and entered recovery or Human exit immediately");
    if (exit !== "d") {
      original = (await history()).find(run => run.id === original!.id);
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return reply?.type === "snapshot" && reply.data.summary.status === "idle";
      }, 15_000);
      const queued = await opened.client.call({ type: "session.send", payload: {
        sessionId: pm, messageId: `u_ask_business_human_${exit}`, text: "ASK_BUSINESS_HUMAN",
        attachments: [], continuesRound: null,
      } });
      t.assertions.assert(queued?.type === "ack", "Human proposal input was not queued");
      let cardId = `workflow-human-${original!.id}`;
      await t.tools.waitUntil(async () => {
        const run = (await history()).find(item => item.id === original!.id);
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return run?.humanExit?.kind === exit && reply?.type === "snapshot"
          && reply.data.pendingPermissions.some(card => card.id === cardId);
      }, 20_000);
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("business Human card unavailable");
      let card = reply.data.pendingPermissions.find(item => item.id === cardId)!;
      t.assertions.assert(card.options?.map(option => option.id).join(",") === (exit === "a" ? "approve,reject" : "handled,abandon"),
        `Human exit ${exit} has the wrong options`);
      const beforeBudget = (await history()).find(item => item.id === original!.id)!.requestBudget;
      if (exit === "a") t.assertions.assert(card.options?.find(option => option.id === "approve")?.label
        .includes("1 次业务 Run、128 轮 LLM") && card.description?.includes("本卡审批固定额度")
        && card.description.includes("申请原因中的其他数字不改变此额度"), "business approval omits its effective fixed quota");
      const choice = exit === "a" ? "approve" : "abandon";
      const answered = await opened.client.call({ type: "session.respondPermission", payload: {
        sessionId: pm, requestId: cardId, outcome: { outcome: "selected", optionId: choice },
      } });
      t.assertions.assert(answered?.type === "ack", `Human exit ${exit} answer was not accepted`);
      await t.tools.waitUntil(async () => {
        const run = (await history()).find(item => item.id === original!.id);
        return run?.humanExit?.answer === choice && (exit === "a"
          ? run.requestBudget.maxRuns === beforeBudget.maxRuns + 1
            && run.requestBudget.maxLlmRounds === beforeBudget.maxLlmRounds + 128
            && run.requestBudget.revision === beforeBudget.revision + 1
          : run.status === "cancelled");
      }, 25_000);
      if (exit === "a") {
        const repeated = await opened.client.call({ type: "session.respondPermission", payload: {
          sessionId: pm, requestId: cardId, outcome: { outcome: "selected", optionId: "approve" },
        } });
        t.assertions.assert(repeated?.type === "ack" && (await history()).find(item => item.id === original!.id)!.requestBudget.revision === beforeBudget.revision + 1,
          "duplicate approval changed the budget twice");
        original = (await history()).find(item => item.id === original!.id)!;
        const receipt = path.join(t.env.root, "answered-withdraw-status");
        nextCommand = `"$GENEHUB_CLI" workflow human --run ${original.id} --revision ${original.revision} --kind withdraw --request ${cardId} --reason "answered proposal must remain applied"; printf '%s' "$?" > '${receipt}'`;
        await opened.client.call({ type: "session.send", payload: { sessionId: pm, messageId: "u_answered_withdraw", text: "Inspect the already applied decision.", attachments: [], continuesRound: null } });
        await t.tools.waitUntil(async () => { try { return readFileSync(receipt, "utf8").length > 0; } catch { return false; } }, 20_000);
        t.assertions.assert(readFileSync(receipt, "utf8") !== "0" && (await history()).find(item => item.id === original!.id)!.humanExit?.answer === "approve", "withdrawal undid an answered proposal");
      }
      t.assertions.assert((await history()).length === 1, `Human exit ${exit} changed request lineage`);
      await t.tools.waitUntil(async () => {
        const result = await runGenetAsync(opened.daemon.genet,
          ["workflow", "journal", "--run", original!.id, "--since", "0", "--limit", "100"],
          opened.daemon.env, { cwd: opened.workspaceRoot });
        if (result.code !== 0) return false;
        const events = (JSON.parse(result.stdout) as { data: { events: Array<{
          eventType: string; actor: string; messageId?: string;
        }> } }).data.events;
        const has = (type: string, actor: string) => events.some(event =>
          event.eventType === type && event.actor === actor && event.messageId === cardId);
        return has("pause.requested", "event") && has("pause.answered", "human")
          && (exit !== "a" || has("run.budgetUpdated", "human"));
      }, 15_000);
      return;
    }
    const deleted = await opened.client.call({ type: "session.delete", payload: { sessionId: pm } });
    t.assertions.assert(deleted?.type === "ack", "original PM conversation could not be deleted");
    pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await opened.client.call({ type: "session.send", payload: {
      sessionId: pm, messageId: "u_pause_pm_before_human", text: "Track this request, then wait.",
      attachments: [], continuesRound: null,
    } });
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      return reply?.type === "snapshot" && reply.data.summary.status === "idle";
    }, 15_000);
    await opened.client.call({ type: "session.interrupt", payload: { sessionId: pm } });
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      return reply?.type === "snapshot" && reply.data.summary.workSummary?.tasks
        .some(task => task.requestRunId === original!.id) === true;
    }, 15_000);

    opened.client.close();
    const stopped = await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    t.assertions.assert(stopped.code === 0, `daemon stop failed: ${stopped.stderr}`);
    // Fault-inject only the persisted PM answer clock; waiting half an hour
    // would add no coverage of the patrol transition or durable card.
    const snapshotPath = path.join(opened.workspaceRoot, ".genethub/components/pm/requests",
      original!.id, "runs", original!.id, "run.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { run: { updatedAtMs: number; nodes: Record<string, { routeWait?: { sinceMs: number } }> } };
    const overdueSinceMs = Date.now() - 1_805_000;
    for (const node of Object.values(snapshot.run.nodes)) if (node.routeWait) node.routeWait.sinceMs = overdueSinceMs;
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const requirementPath = path.join(opened.workspaceRoot, ".genethub/components/pm/requests", original!.id, "request.json");
    const requirement = JSON.parse(readFileSync(requirementPath, "utf8"));
    requirement.requirement.pendingSinceMs = overdueSinceMs;
    writeFileSync(requirementPath, JSON.stringify(requirement));
    const start = async () => {
      const result = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
      t.assertions.assert(result.code === 0, `daemon restart failed: ${result.stderr || result.stdout}`);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    };
    await start();
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      return reply?.type === "snapshot" && reply.data.summary.status === "idle";
    }, 20_000);
    const run = (await history()).find(item => item.id === original!.id);
    const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
    t.assertions.assert(run?.humanExit == null && reply?.type === "snapshot"
      && !reply.data.pendingPermissions.some(card => card.id === `workflow-human-${original!.id}`),
      "an overdue route block opened a Human card");
    t.assertions.assert((await history()).length === 1, "PM timeout launched a recovery Run for a route block");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

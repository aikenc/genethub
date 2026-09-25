import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const exit of ["d", "a", "e"] as const) defineSpecialty({
  id: `specialty.workflow.${exit === "d" ? "pm-timeout-human-exit" : `business-human-${exit}`}`,
  title: exit === "d" ? "An overdue PM route decision becomes one durable Human feedback card" : `PM requests Human exit ${exit} for a blocked business Run`,
  oracle: exit === "d"
    ? "A route block stays visible after its original PM Session is deleted, then its persisted 30-minute deadline produces Human exit d for a new PM, survives restart without another card, and records the answer"
    : "An explicit PM Human exit creates the correct durable options; approval a amends only this request budget and abandonment e cancels the request",
  catches: ["route block incorrectly starts recovery", "deleting PM hides an unfinished project request", "overdue PM has no Human owner", "restart duplicates Human cards", "feedback option is missing"],
  tags: ["core", "workflow", "workflow-recovery", "session-attention"],
  llm: { default: "mock" }, expectedDurationMs: 35_000, timeoutMs: 110_000,
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
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v3", id: "worker", tags: ["Max"],
      userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/pm-timeout.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "pm-timeout", version: 1, entry: "work",
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker", workspace: "." },
        completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" }],
    }));
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: {
      runtimes: {}, selectedTags: ["Max"], modelProfiles: [{ agentId: "genet",
        modelId: "deepseek/deepseek-v4-flash", tags: ["Flash"], cost: "low" }],
    } } });
    let dispatched = false;
    let original: WorkflowRunStatus | undefined;
    opened.mock.script(...Array.from({ length: 24 }, () => ({ respond: (request: unknown) => {
      if (exit !== "d" && JSON.stringify(request).includes("ASK_BUSINESS_HUMAN")) {
        return { tool: { name: "bash", arguments: { command:
          `"$GENEHUB_CLI" workflow human --run ${original!.id} --revision ${original!.revision} --kind ${exit} --reason "PM needs a Human decision"`,
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
      return original?.status === "blocked" && original.reason?.includes("RouteUnavailable");
    }, 30_000);
    t.assertions.assert((await history()).length === 1 && !original!.humanExit,
      "normal route block skipped PM and entered recovery or Human exit immediately");
    if (exit !== "d") {
      original = (await history()).find(run => run.id === original!.id);
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return reply?.type === "snapshot" && reply.data.summary.status === "idle";
      }, 15_000);
      await t.flows.main.sendPrompt(opened.client, pm, "ASK_BUSINESS_HUMAN");
      const cardId = `workflow-human-${original!.id}`;
      await t.tools.waitUntil(async () => {
        const run = (await history()).find(item => item.id === original!.id);
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return run?.humanExit?.kind === exit && reply?.type === "snapshot"
          && reply.data.pendingPermissions.some(card => card.id === cardId);
      }, 20_000);
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("business Human card unavailable");
      const card = reply.data.pendingPermissions.find(item => item.id === cardId)!;
      t.assertions.assert(card.options?.map(option => option.id).join(",") === (exit === "a" ? "approve,reject" : "handled,abandon"),
        `Human exit ${exit} has the wrong options`);
      const choice = exit === "a" ? "approve" : "abandon";
      const answered = await opened.client.call({ type: "session.respondPermission", payload: {
        sessionId: pm, requestId: cardId, outcome: { outcome: "selected", optionId: choice },
      } });
      t.assertions.assert(answered?.type === "ack", `Human exit ${exit} answer was not accepted`);
      await t.tools.waitUntil(async () => {
        const run = (await history()).find(item => item.id === original!.id);
        return run?.humanExit?.answer === choice && (exit === "a"
          ? run.requestBudget.maxRuns === 4 && run.requestBudget.revision === 1
          : run.status === "cancelled");
      }, 25_000);
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
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { run: { updatedAtMs: number } };
    snapshot.run.updatedAtMs = Date.now() - 1_805_000;
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const start = async () => {
      const result = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
      t.assertions.assert(result.code === 0, `daemon restart failed: ${result.stderr || result.stdout}`);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    };
    await start();
    const pmCard = async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("PM Session unavailable");
      return reply.data.pendingPermissions.filter(card => card.id === `workflow-human-${original!.id}`);
    };
    await t.tools.waitUntil(async () => (await history())[0]?.humanExit?.kind === "d" && (await pmCard()).length === 1, 25_000);
    const card = (await pmCard())[0]!;
    t.assertions.assert(card.options?.map(option => option.id).join(",") === "confirmFeedback,keepOpen",
      "Human feedback card has the wrong options");
    t.assertions.assert((await history()).length === 1, "PM timeout launched a recovery Run for a route block");

    opened.client.close();
    const stoppedAgain = await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    t.assertions.assert(stoppedAgain.code === 0, `second stop failed: ${stoppedAgain.stderr}`);
    await start();
    await t.tools.waitUntil(async () => (await pmCard()).length === 1, 10_000);
    const answered = await opened.client.call({ type: "session.respondPermission", payload: {
      sessionId: pm, requestId: card.id, outcome: { outcome: "selected", optionId: "confirmFeedback" },
    } });
    t.assertions.assert(answered?.type === "ack", "Human feedback choice was not accepted");
    await t.tools.waitUntil(async () => (await history())[0]?.humanExit?.answer === "confirmFeedback", 20_000);
    t.assertions.assert((await pmCard()).length === 0 && (await history()).length === 1,
      "answered feedback card remained pending or changed the request lineage");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});

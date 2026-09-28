import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-budget-human",
  title: "Recovery shares the request budget and approval does not repeat diagnosis",
  oracle: "A real recovery Worker stops at the shared request allowance; one exact Human proposal is applied once, across reply replay and restart, without an automatic second recovery",
  catches: ["recovery has an independent budget", "approval grants a fixed increment", "approval restarts the same recovery", "restart or reply replay spends again"],
  tags: ["core", "workflow", "workflow-recovery", "session-attention"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 115_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.history", "workflow.activate", "workflow.human", "session.respondPermission", "Workflow request.json"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let stage = "setup";
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "workflow.md"), "---\ndescription: shared recovery budget fixture\nrecovery: flows/recovery.yaml\n---\n");
    for (const [role, marker] of [["worker", "BUDGET_BUSINESS_WORKER"], ["recovery-worker", "BUDGET_RECOVERY_WORKER"]]) {
      writeFileSync(path.join(source, `roles/${role}.yaml`), JSON.stringify({ schema: "genehub.workflow.role.v1", id: role,
        agentId: "genet", modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: `prompts/${role}.md` }));
      writeFileSync(path.join(source, `prompts/${role}.md`), `${marker}: inspect the original defect.\n`);
    }
    writeFileSync(path.join(source, "flows/business.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "business", version: 1, entry: "work",
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker" },
        completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
      { id: "publish", uses: "result.publish" }],
    }));
    writeFileSync(path.join(source, "flows/recovery.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "recovery", version: 1, entry: "review",
      outcomes: { resume: { success: true }, human: { success: false } },
      nodes: [{ id: "review", uses: "agent.session", with: { role: "recovery-worker" }, on: { resume: ["publish"], human: [] } },
      { id: "publish", uses: "result.publish" }],
    }));
    const activation = await runGenetAsync(opened.daemon.genet, ["workflow", "activate", "--revision", "0"],
      opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(activation.code === 0, `custom recovery activation failed: ${activation.stderr || activation.stdout}`);
    let sent = false, businessSubmitted = false, command: string | undefined;
    opened.mock.script(...Array.from({ length: 80 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("BUDGET_BUSINESS_WORKER")) {
        if (businessSubmitted) return { text: "The business defect was reported." };
        businessSubmitted = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "execution failed" --evidence result=failed' } } };
      }
      if (body.includes("BUDGET_RECOVERY_WORKER")) return { hang: true as const };
      if (command) { const next = command; command = undefined; return { tool: { name: "bash", arguments: { command: next } } }; }
      if (!sent) {
        sent = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow business --task budget-business --message "deliver" --no-wait' } } };
      }
      return { text: "The request remains open; PM will implement the next decision." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    let inputSeq = 0;
    // Queue behind an active PM turn. The immediate prompt API rejects with
    // Conflict while that turn is still running.
    const send = (text: string) => opened.client.call({ type: "session.send", payload: {
      sessionId: pm, messageId: `u_recovery_budget_${++inputSeq}`, text,
      attachments: [], continuesRound: null, artifactPreviewBaseUrl: null,
    } });
    await send("Start the request.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    let root: WorkflowRunStatus | undefined, recovery: WorkflowRunStatus | undefined;
    stage = "start real recovery";
    await t.tools.waitUntil(async () => {
      const runs = await history(); root = runs.find(run => run.taskId === "budget-business");
      recovery = runs.find(run => run.handles.some(handle => handle.runId === root?.id));
      return recovery?.status === "running";
    }, 35_000);
    command = `"$GENEHUB_CLI" workflow budget --run ${root!.id} --revision ${root!.requestBudget.revision} --max-llm-rounds 1`;
    await send("Apply a hard cap of one LLM request to this whole goal.");
    stage = "shared allowance stops recovery";
    await t.tools.waitUntil(async () => {
      recovery = (await history()).find(run => run.id === recovery!.id);
      return recovery?.status === "blocked" && recovery.reason?.includes("requestBudgetExceeded") === true;
    }, 25_000);
    t.assertions.assert(!recovery!.humanExit, "exhaustion invented a separate recovery budget card");
    root = (await history()).find(run => run.id === root!.id)!;
    command = `"$GENEHUB_CLI" workflow human --run ${recovery!.id} --revision ${recovery!.revision} --kind a --reason "Use the completed review and finish the original goal" --budget-revision ${root.requestBudget.revision} --max-llm-rounds 600 --deadline-seconds 14400`;
    await send("Propose the exact remaining allowance for approval.");
    stage = "one concrete Human proposal";
    let card: { detail?: string | null } | undefined;
    await t.tools.waitUntil(async () => {
      recovery = (await history()).find(run => run.id === recovery!.id);
      if (recovery?.humanExit?.kind !== "a") return false;
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") return false;
      card = reply.data.pendingPermissions.find(item => item.id === recovery!.humanExit!.requestId);
      return Boolean(card);
    }, 20_000);
    const cardId = recovery!.humanExit!.requestId;
    t.assertions.assert(Boolean(card?.detail?.includes("600") && card.detail.includes("4 小时")
      && !card.detail.includes("Run") && !card.detail.includes("固定额度")),
      `card did not show the proposed requests and time: ${card?.detail ?? ""}`);
    const answer = () => opened.client.call({ type: "session.respondPermission", payload: {
      sessionId: pm, requestId: cardId, outcome: { outcome: "selected", optionId: "approve" },
    } });
    t.assertions.assert((await answer())?.type === "ack", "proposal answer rejected");
    await t.tools.waitUntil(async () => (await history()).find(run => run.id === recovery!.id)?.humanExit?.answer === "approve", 20_000);
    await answer();
    opened.client.close();
    const stopped = await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    t.assertions.assert(stopped.code === 0, "daemon stop failed");
    const started = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
    t.assertions.assert(started.code === 0, "daemon restart failed");
    opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    // Observe several real patrol intervals after restart; no new Human input
    // or budget edit should become a fresh recovery trigger.
    const observeUntil = Date.now() + 8_000;
    while (Date.now() < observeUntil) {
      const observed = await history();
      t.assertions.assert(observed.filter(run => run.handles.some(handle => handle.runId === root!.id)).length === 1,
        "restart admitted another diagnosis for the same failure");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const runs = await history();
    t.assertions.assert(runs.filter(run => run.handles.some(handle => handle.runId === root!.id)).length === 1,
      "approval/replay/restart repeated the same diagnosis");
    const record = JSON.parse(readFileSync(path.join(opened.workspaceRoot, ".genethub/components/pm/requests", root!.id, "request.json"), "utf8"));
    t.assertions.assert(record.budget.maxLlmRounds === 600 && record.budget.deadlineMs === 14_400_000
      && record.budget.revision === root!.requestBudget.revision + 1 && !record.recoveryExtra
      && record.approvedHumanExits.filter((id: string) => id === cardId).length === 1,
    "proposal was not applied exactly once to the shared request");
  } catch (error) { throw new Error(`${stage}: ${error}`); }
  finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

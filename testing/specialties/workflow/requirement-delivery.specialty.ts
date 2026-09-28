import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const scenario of ["pending", "deliver", "cancel", "recover", "recover-busy", "human", "human-cancel", "agent-stop", "human-renew", "recover-deliver", "recover-successor", "deliver-contradiction"] as const) defineSpecialty({
  id: `specialty.workflow.requirement-${scenario === "pending" ? "delivery" : scenario}`,
  title: `User requirement ownership after Worker completion: ${scenario}`,
  oracle: "A real Worker finishes an assessment; execution completion never settles the goal. Only the owning PM can confirm delivery; cancellation, durable receipts, bounded PM deadlines and genuine Human waits remain observable across daemon restart",
  catches: ["assessment is treated as delivery", "handled PM input silently settles the requirement", "terminal notice cannot persist its receipt", "PM stops without a decision and patrol ignores it", "restart repeats accepted side effects"],
  tags: ["core", "workflow", "requirement-delivery"],
  llm: { default: "mock" }, expectedDurationMs: 40_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.history", "workflow.get", "session.get", "workflow.cancel", "session.respondPermission", "genet workflow deliver"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    if (scenario === "deliver") {
      const queried = await runGenetAsync(opened.daemon.genet, ["schema", "workflow.deliver"], opened.daemon.env);
      const schema = JSON.parse(queried.stdout).data.command;
      t.assertions.assert(queried.code === 0 && schema.name === "workflow.deliver" && schema.mutation === true
        && schema.outputSchema.properties.type.const === "workflow.requirement.completed" && schema.inputSchema.properties.evidence.maxProperties === 16, "Agent cannot discover the delivery command or its bounded mutation contract");
    }
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "REQUIREMENT_ASSESSMENT_WORKER: only assess; implementation is still pending.\n");
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [{ id: "assess", uses: "agent.session", with: { role: "worker" }, completion: { output: { type: "object", properties: { done: { type: "boolean" }, decision: { type: "string" }, delivered: { type: "array", maxItems: 16, items: { type: "string" } } } } } }],
      structure: { body: { id: "root", type: "sequence", steps: [{ id: "assess-step", type: "task", activity: "assess" }], output: { op: "ref", path: "/results/assess-step/output" } } },
    }));
    if (scenario === "recover-deliver" || scenario === "recover-successor") {
      writeFileSync(path.join(source, "workflow.md"), "---\ndescription: requirement review and delivery\nrecovery: flows/recovery.yaml\n---\n");
      writeFileSync(path.join(source, "roles/requirement-reviewer.yaml"), JSON.stringify({ schema: "genehub.workflow.role.v1", id: "requirement-reviewer", agentId: "genet", modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/requirement-reviewer.md" }));
      writeFileSync(path.join(source, "prompts/requirement-reviewer.md"), "REQUIREMENT_RECOVERY_REVIEW: the assessment exists; return the disposition to PM.\n");
      writeFileSync(path.join(source, "flows/recovery.yaml"), JSON.stringify({ schema: "genehub.workflow.definition.v1", id: "recovery", version: 1, entry: "review", outcomes: { resume: { success: true }, human: { success: false } }, nodes: [{ id: "review", uses: "agent.session", with: { role: "requirement-reviewer", writeLease: { ttlSeconds: 900 } }, completion: { all: [{ key: "report", verify: "value.nonEmpty" }] }, on: { resume: ["publish"], human: [] } }, { id: "publish", uses: "result.publish" }] }));
      const activation = await runGenetAsync(opened.daemon.genet, ["workflow", "activate", "--revision", "0"], opened.daemon.env, { cwd: opened.workspaceRoot });
      t.assertions.assert(activation.code === 0, "Custom recovery activation failed");
    }
    let dispatched = false, assessed = false, decisionIssued = false, busyIssued = false, reviewed = false, renewed = false, secondAssessed = false, successorIssued = false, scopeIssued = false;
    let recoveryId: string | undefined;
    let run: WorkflowRunStatus | undefined;
    opened.mock.script(...Array.from({ length: 80 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("REQUIREMENT_RECOVERY_REVIEW")) {
        if (reviewed) return { text: "Review submitted." };
        reviewed = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome resume --evidence report=assessment.txt' } } };
      }
      if (body.includes("REQUIREMENT_ASSESSMENT_WORKER")) {
        if (assessed) {
          if (scenario === "recover-successor" && body.includes("Finish the assessment") && !secondAssessed) {
            secondAssessed = true;
            return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow complete --output '{"done":true,"decision":"ready","delivered":["assessment.txt"]}'` } } };
          }
          return { text: "Assessment submitted." };
        }
        assessed = true;
        return { tool: { name: "bash", arguments: { command: `printf 'accepted assessment\\n' > assessment.txt; printf 'effect\\n' >> effects.txt; ${scenario === "agent-stop" ? "sleep 40; " : ""}${scenario === "recover-successor" ? '"$GENEHUB_CLI" workflow complete --outcome failed --reason "Initial attempt needs repair"' : '"$GENEHUB_CLI" workflow complete --output \'{"done":false,"decision":"needsAuthorization","delivered":[]}\''}` } } };
      }
      if (!dispatched) {
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: `${scenario === "recover-deliver" || scenario === "recover-successor" ? "" : '"$GENEHUB_CLI" workflow activate --revision 0 && '}"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task requirement-assessment --message "Deliver the requested assessment and let PM decide whether the goal is met" --no-wait` } } };
      }
      if (run && recoveryId && !successorIssued && body.includes("DISPATCH_RECOVERY_SUCCESSOR")) {
        successorIssued = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task repaired-assessment --message "Finish the assessment" --retry-of ${recoveryId} --no-wait` } } };
      }
      if (run && !renewed && body.includes("RENEW_RECOVERY_AUTHORIZATION")) {
        renewed = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow human --run ${run.id} --revision ${run.revision} --kind a --reason "Finish remaining work after the feedback decision" --budget-revision ${run.requestBudget.revision} --max-llm-rounds 600 --deadline-seconds 14400` } } };
      }
      if (run && !scopeIssued && body.includes("PROPOSE_SCOPE_ADJUSTMENT")) {
        scopeIssued = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow human --run ${run.id} --revision ${run.revision} --kind b --reason "Agree the remaining deliverable before execution" --goal "Deliver the assessment only" --scope-changes "Remove implementation; retain the written assessment and its evidence"` } } };
      }
      if (run && body.includes("STOP_EXECUTION_ONLY")) {
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow cancel --run ${run.id} --revision ${run.revision}` } } };
      }
      if (!busyIssued && body.includes("UNRELATED_RUNNING_WORK")) {
        busyIssued = true;
        return { tool: { name: "bash", arguments: { command: "sleep 40" } } };
      }
      if (!decisionIssued && run && body.includes("CONFIRM_REQUIREMENT_DELIVERY")) {
        decisionIssued = true;
        const command = `"$GENEHUB_CLI" workflow deliver --run ${run.id} --revision ${run.requirement!.revision} --reason "Assessment accepted and delivered" --evidence delivery=assessment.txt --evidence effect=effects.txt`;
        return { tool: { name: "bash", arguments: { command: scenario === "deliver-contradiction" ? `${command} > delivery-refusal.txt 2>&1; test $? -ne 0` : `if "$GENEHUB_CLI" workflow deliver --run ${run.id} --revision 0 --reason "Stale decision" --evidence delivery=assessment.txt; then exit 42; fi; ${command} && ${command}` } } };
      }
      if (!decisionIssued && run && body.includes("ASK_REQUIREMENT_HUMAN")) {
        decisionIssued = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow human --run ${run.id} --revision ${run.revision} --kind d --reason "Need the user's decision before continuing"` } } };
      }
      return { text: "The goal still needs a decision; I have received the input." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const send = async (text: string) => {
      const reply = await opened.client.call({ type: "session.send", payload: { sessionId: pm, messageId: `u_requirement_${scenario}_${text.split(":")[0]!.replace(/[^a-zA-Z_]/g, "_")}`, text, attachments: [], continuesRound: null, artifactPreviewBaseUrl: null } });
      t.assertions.assert(reply?.type === "ack", `Durable PM input rejected: ${text}`);
    };
    await send("Start requirement assessment.");
    const history = async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    const get = async () => {
      const reply = await opened.client.call({ type: "workflow.get", payload: { workspaceId: opened.workspaceId, runId: run!.id } });
      if (reply?.type !== "workflowRun") throw new Error("Workflow unavailable");
      return reply.data;
    };
    await t.tools.waitUntil(async () => {
      run = (await history()).find(item => item.taskId === "requirement-assessment");
      return scenario === "agent-stop" ? run?.status === "running" && existsSync(path.join(opened.workspaceRoot, "effects.txt")) : run?.status === (scenario === "recover-successor" ? "blocked" : "completed") && run?.requirement?.state === "completing";
    }, 30_000);
    const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
    t.assertions.assert(snapshot?.type === "snapshot", "PM snapshot unavailable");
    if (snapshot?.type !== "snapshot") return;
    const task = snapshot.data.summary.workSummary?.tasks.find(item => item.requestRunId === run!.id);
    t.assertions.assert(task && !["completed", "cancelled"].includes(task.status),
      "Run execution completed, but the undelivered user requirement incorrectly entered a terminal task state");
    t.assertions.assert(run!.requirement?.state === (scenario === "agent-stop" ? "in_progress" : "completing"), "Unconfirmed delivery has no PM handoff phase");
    if (scenario !== "recover-successor") await t.tools.waitUntil(async () => {
      run = await get();
      return !run.reportPending;
    }, 20_000);
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      return reply?.type === "snapshot" && reply.data.summary.status === "idle";
    }, 15_000);
    const root = path.join(opened.workspaceRoot, ".genethub/components/pm/requests", run!.id);
    const restart = async (expire: boolean, lostMarker = false) => {
      opened.client.close();
      const stopped = await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
      t.assertions.assert(stopped.code === 0, `Daemon stop failed: ${stopped.stderr}`);
      if (lostMarker) unlinkSync(path.join(root, "settled"));
      if (expire) {
        // Only inject the requirement decision clock after a complete shutdown.
        const file = path.join(root, "request.json");
        const record = JSON.parse(readFileSync(file, "utf8"));
        record.requirement.pendingSinceMs = Date.now() - (scenario === "recover-busy" ? 245_000 : 1_805_000);
        record.nextCheckAtMs = scenario === "recover-busy" ? Date.now() + 5_000 : 0;
        writeFileSync(file, JSON.stringify(record));
      }
      if (scenario === "deliver-contradiction") {
        const recordFile = path.join(root, "request.json");
        const record = JSON.parse(readFileSync(recordFile, "utf8"));
        record.nextCheckAtMs = Date.now() + 60_000;
        writeFileSync(recordFile, JSON.stringify(record));
        const file = path.join(root, "runs", run!.id, "run.json");
        const recordRun = JSON.parse(readFileSync(file, "utf8"));
        Object.values(recordRun.run.nodes).forEach(node => { (node as { status: string }).status = "finishing"; });
        writeFileSync(file, JSON.stringify(recordRun));
      }
      const started = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
      t.assertions.assert(started.code === 0, `Daemon restart failed: ${started.stderr || started.stdout}`);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    };
    if (scenario === "agent-stop") {
      await send("STOP_EXECUTION_ONLY: stop this execution, keep the delivery goal open.");
      await t.tools.waitUntil(async () => { run = await get(); return run.status === "cancelled"; }, 25_000);
      t.assertions.assert((await get()).requirement?.state === "completing", "Agent stopping execution impersonated a user goal cancellation");
    } else if (scenario === "pending") {
      t.assertions.assert(!existsSync(path.join(root, "settled")), "Unconfirmed goal acquired a settled marker");
      await restart(false);
      t.assertions.assert((await get()).requirement?.state === "completing", "Restart lost unfinished goal ownership");
    } else if (scenario === "deliver" || scenario === "recover-deliver" || scenario === "recover-successor" || scenario === "deliver-contradiction") {
      if (scenario === "deliver-contradiction") await restart(false);
      if (scenario === "recover-deliver" || scenario === "recover-successor") {
        await restart(true);
        await t.tools.waitUntil(async () => (await history()).some(item => item.handles.length > 0 && item.status === "awaitingPm"), 30_000);
        const leases = path.join(opened.workspaceRoot, ".genethub/components/pm/ref-leases");
        t.assertions.assert(existsSync(leases) && readdirSync(leases).some(file => file.endsWith(".guard"))
          && !readdirSync(leases).some(file => file.endsWith(".json")),
          "completed recovery review retained a write lease while awaiting PM action");
        if (scenario === "recover-successor") {
          recoveryId = (await history()).find(item => item.handles.length > 0)!.id;
          await send("DISPATCH_RECOVERY_SUCCESSOR");
          await t.tools.waitUntil(async () => (await history()).some(item => item.taskId === "repaired-assessment" && item.status === "completed" && !item.reportPending), 30_000);
        }
        run = await get();
      }
      let forbidden = false;
      try {
        await opened.client.call({ type: "workflow.requirement.complete", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.requirement!.revision, conclusion: "Forged UI decision", deliveryReferences: ["assessment.txt"] } });
      } catch { forbidden = true; }
      t.assertions.assert(forbidden, "An unauthenticated UI caller can impersonate PM delivery judgment");
      await send("CONFIRM_REQUIREMENT_DELIVERY");
      if (scenario === "deliver-contradiction") {
        await t.tools.waitUntil(() => existsSync(path.join(opened.workspaceRoot, "delivery-refusal.txt")) && readFileSync(path.join(opened.workspaceRoot, "delivery-refusal.txt"), "utf8").length > 0, 15_000);
        await t.tools.waitUntil(async () => (await opened.client.call({ type: "session.get", payload: { sessionId: pm } }))?.type === "snapshot" && decisionIssued, 10_000);
        t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "delivery-refusal.txt"), "utf8").includes("requirementStillExecuting"), "Contradictory completed snapshot accepted unfinished cleanup");
        t.assertions.assert((await get()).requirement?.state !== "completed" && !existsSync(path.join(root, "settled")), "Unfinished cleanup produced a goal terminal");
        return;
      }
      await t.tools.waitUntil(async () => (await get()).requirement?.state === "completed", 20_000);
      const decision = (await get()).requirement!;
      t.assertions.assert(decision.conclusion === "Assessment accepted and delivered" && decision.pmSessionId === pm && decision.deliveryReferences[0] === "assessment.txt" && decision.deliveryReferences[1] === "effects.txt", "PM decision lost its author or references");
      await t.tools.waitUntil(() => existsSync(path.join(root, "settled")), 10_000);
      await restart(false, true);
      await t.tools.waitUntil(() => existsSync(path.join(root, "settled")), 15_000);
      t.assertions.assert((await get()).requirement?.revision === decision.revision, "Repeated delivery or restart changed a settled decision");
      const settled = await history();
      t.assertions.assert(settled.length === (scenario === "recover-successor" ? 3 : scenario === "recover-deliver" ? 2 : 1)
        && settled.every(item => item.id === run!.id && scenario === "recover-successor" ? item.status === "blocked" : item.status === "completed"), "Confirmed delivery left recovery unresolved or launched another attempt");
    } else if (scenario === "cancel") {
      const reply = await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } });
      t.assertions.assert(reply?.type === "workflowRun", "User cannot cancel an unconfirmed completed execution");
      await t.tools.waitUntil(async () => (await get()).requirement?.state === "cancelled", 15_000);
      await restart(false);
      t.assertions.assert((await get()).requirement?.state === "cancelled" && (await history()).length === 1, "Cancelled goal was revived after restart");
    } else if (scenario === "recover" || scenario === "recover-busy") {
      await restart(true);
      if (scenario === "recover-busy") {
        await send("UNRELATED_RUNNING_WORK: inspect another independent matter.");
        await t.tools.waitUntil(async () => { const snap = await opened.client.call({ type: "session.get", payload: { sessionId: pm } }); return busyIssued && snap?.type === "snapshot" && snap.data.summary.status === "running"; }, 10_000);
      }
      await t.tools.waitUntil(async () => (await history()).some(item => item.handles.some(handle => handle.runId === run!.id)), 25_000);
      t.assertions.assert((await get()).requirement?.state !== "completed", "WR activation erased the outstanding delivery judgment");
    } else {
      await send("ASK_REQUIREMENT_HUMAN");
      await t.tools.waitUntil(async () => {
        const goal = await get();
        const snap = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return goal.humanExit?.answer == null && goal.humanExit?.kind === "d" && snap?.type === "snapshot" && snap.data.pendingPermissions.some(card => card.id === goal.humanExit!.requestId);
      }, 20_000);
      await restart(scenario !== "human-renew");
      const current = await get();
      t.assertions.assert((await history()).length === 1, "Patrol started recovery during a real pending Human wait");
      if (scenario === "human-cancel") {
        const latest = await get();
        await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: latest.id, expectedRevision: latest.revision } });
        await t.tools.waitUntil(async () => (await get()).requirement?.state === "cancelled" && existsSync(path.join(root, "settled")), 15_000);
        await restart(false);
        t.assertions.assert((await get()).humanExit?.answer === "cancelled", "Cancellation retained an unanswered Human reference");
        return;
      }
      const answered = await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: current.humanExit!.requestId, outcome: { outcome: "selected", optionId: "keepOpen" } } });
      t.assertions.assert(answered?.type === "ack", "Human answer could not wake the requirement");
      await t.tools.waitUntil(async () => (await get()).humanExit?.answer === "keepOpen", 20_000);
      t.assertions.assert((await get()).requirement?.state !== "completed", "Keeping the requirement open disposed of its delivery goal");
      if (scenario === "human-renew") {
        run = await get();
        await send("RENEW_RECOVERY_AUTHORIZATION");
        await t.tools.waitUntil(async () => {
          const goal = await get();
          const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
          return goal.humanExit?.kind === "a" && snapshot?.type === "snapshot"
            && snapshot.data.pendingPermissions.some(card => card.id === goal.humanExit!.requestId);
        }, 20_000);
        const card = (await get()).humanExit!;
        t.assertions.assert(card.requestId !== current.humanExit!.requestId, "New Human decision reused the earlier answered card");
        await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: card.requestId, outcome: { outcome: "selected", optionId: "approve" } } });
        await t.tools.waitUntil(async () => (await get()).humanExit?.answer === "approve", 20_000);
        const record = JSON.parse(readFileSync(path.join(root, "request.json"), "utf8"));
        t.assertions.assert(record.budget.maxLlmRounds === 600 && record.budget.deadlineMs === 14_400_000 && !record.recoveryExtra && record.approvedHumanExits.length === 1, "Recovery approval was lost or applied more than once");
        run = await get();
        await send("PROPOSE_SCOPE_ADJUSTMENT");
        await t.tools.waitUntil(async () => (await get()).humanExit?.kind === "b", 20_000);
        const scopeCard = (await get()).humanExit!;
        t.assertions.assert(scopeCard.scope?.goal === "Deliver the assessment only" && scopeCard.scope.changes.includes("Remove implementation"), "Scope card omitted its concrete change");
        await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: scopeCard.requestId, outcome: { outcome: "selected", optionId: "acceptScope" } } });
        await t.tools.waitUntil(async () => (await get()).humanExit?.answer === "acceptScope", 20_000);
        const scoped = await get();
        t.assertions.assert(scoped.requirement?.scope?.goal === "Deliver the assessment only"
          && scoped.requirement.state !== "completed" && scoped.requestBudget.maxLlmRounds === 600,
          "Scope acceptance failed to update the goal or falsely claimed delivery/changed budget");
        const scopedRecord = JSON.parse(readFileSync(path.join(root, "request.json"), "utf8"));
        t.assertions.assert(scopedRecord.goal === record.goal && scopedRecord.approvedHumanExits.length === 2,
          "Scope update erased original goal history or lost its receipt");
      }
    }
    t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "effects.txt"), "utf8").trim() === "effect", "Accepted Worker side effect was replayed");
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

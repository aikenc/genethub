import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";

import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const mode of ["normal", "resume", "bypass", "corrupt", "proactive", "human-b", "human-f", "cancel", "queue"] as const) {
const resume = mode === "resume";
const bypass = mode === "bypass";
const corrupt = mode === "corrupt";
const proactive = mode === "proactive";
const humanB = mode === "human-b";
const humanF = mode === "human-f";
const cancelExit = mode === "cancel";
const queue = mode === "queue";
defineSpecialty({
  id: `specialty.workflow.${resume ? "recovery-resume" : bypass ? "recovery-pm-gate" : corrupt ? "recovery-corrupt-fallback" : proactive ? "recovery-proactive" : humanB ? "recovery-human-b" : humanF ? "recovery-human-f" : cancelExit ? "recovery-cancel" : queue ? "recovery-package-queue" : "recovery-lifecycle"}`,
  title: bypass ? "WR cannot choose a PM recovery decision without a durable answer" : resume ? "PM-selected resume continues a blocked goal through a same-definition successor" : corrupt ? "A damaged custom Candidate falls back to built-in recovery" : proactive ? "PM can proactively start recovery for unhealthy execution" : humanB ? "Recovery can hand a reduced-scope decision to a Human" : humanF ? "Human acceptance closes a business request" : cancelExit ? "A recovery cancellation recommendation waits for PM to cancel the request" : queue ? "Failed requests enter package recovery one at a time" : "A blocked request completes through the built-in recovery graph",
  oracle: corrupt
    ? "A damaged active Candidate cannot silence a blocked request: the patrol starts the built-in WR and commits a fallback journal event"
    : proactive
      ? "PM stops an unhealthy running business Run, then the patrol enters the same recovery path with a PM-attributed journal event"
      : humanB || humanF
        ? "The built-in recovery graph creates the correct Human card, records its answer, and only Human acceptance may complete the business Run"
        : cancelExit
          ? "WR's cancel verdict remains with PM until PM cancels the original request; it is not immediately misclassified as platform failure d"
        : queue
          ? "Two failed requests in one package never run recovery Workers together; when the first is cancelled, the queued second request enters recovery"
        : "A failed business Run enters WR review, waits for a PM choice, lets WM activate a repaired Candidate, passes WR acceptance, then completes a business successor and writes one recovery summary",
  catches: ["blocked business work has no recovery owner", "WR bypasses the PM decision", "repair is lost before successor", "recovery completion is mistaken for business completion", "recovery summary is missing or duplicated"],
  tags: ["core", "workflow", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 65_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.activate", "workflow.dispatch", "workflow.journal", "workflow.complete", "workflow.history", "session.respondPermission"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let stage = "setup";
  let reviewerId = "";
  let questionId = "";
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    const workerPrompt = path.join(source, "prompts/direct-worker.md");
    writeFileSync(workerPrompt, "RECOVERY_LIFECYCLE_BUSINESS: submit the assigned result.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet",
      modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/direct-worker.md",
    }));
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "direct-change", version: 1, entry: "work",
      nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker", workspace: "." },
          completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" },
      ],
    }));
    if (corrupt) {
      writeFileSync(path.join(source, "workflow.md"), "---\ndescription: recovery fallback fixture\nrecovery: flows/recovery.yaml\n---\n");
      writeFileSync(path.join(source, "flows/recovery.yaml"), JSON.stringify({
        schema: "genehub.workflow.definition.v1", id: "recovery", version: 1, entry: "review",
        outcomes: { resume: { success: true }, human: { success: false } },
        nodes: [
          { id: "review", uses: "agent.session", with: { role: "worker" }, on: { resume: ["publish"], human: [] } },
          { id: "publish", uses: "result.publish" },
        ],
      }));
      const activated = await runGenetAsync(opened.daemon.genet, ["workflow", "activate", "--revision", "0"],
        opened.daemon.env, { cwd: opened.workspaceRoot });
      t.assertions.assert(activated.code === 0, `Human custom recovery activation failed: ${activated.stderr || activated.stdout}`);
    }

    let started = false, successorRequested = false, initialSubmitted = false, secondSubmitted = false, successorSubmitted = false;
    let decisionSent = false, reviewerCalls = 0, managerCalls = 0, acceptorCalls = 0;
    const bodyOf = (request: unknown) => JSON.stringify(request);
    const respond = (request: unknown) => {
      const body = bodyOf(request);
      if (body.includes("RECOVERY_LIFECYCLE_BUSINESS")) {
        if (proactive) return { hang: true as const };
        if (queue && body.includes("candidate-second")) {
          if (secondSubmitted) return { text: "Second failure was reported." };
          secondSubmitted = true;
          return { tool: { name: "bash", arguments: {
            command: '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "second branch failed" --evidence result=failed',
          } } };
        }
        if (body.includes("candidate-successor")) {
          if (successorSubmitted) return { text: "Successor result submitted." };
          successorSubmitted = true;
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence result=delivered' } } };
        }
        if (initialSubmitted) return { text: "Failure result submitted." };
        initialSubmitted = true;
        return { tool: { name: "bash", arguments: { command: `${corrupt ? "sleep 8; " : ""}"$GENEHUB_CLI" workflow complete --outcome blocked --reason "business acceptance failed" --evidence result=failed` } } };
      }
      if (body.includes("只读复查被处理的 Run")) {
        reviewerCalls++;
        if (reviewerCalls === 1) {
          const handled = body.match(/被处理 Run：(wr_[a-f0-9]+)/)?.[1];
          if (!handled) throw new Error("reviewer prompt omitted handled Run reference");
          return { tool: { name: "genet", arguments: { args: ["workflow", "journal", "--run", handled] } } };
        }
        if (reviewerCalls === 2 && bypass) return { tool: { name: "genet", arguments: { args: ["workflow", "complete", "--outcome", "repair", "--evidence", "report=claimed-without-PM"] } } };
        if (reviewerCalls === 2) return { tool: { name: "request_user_input", arguments: { questions: [{
          id: "decision", header: "恢复", question: "选择受控恢复动作", options: [
            { label: "repair", description: "修复流程" }, { label: "resume", description: "续办" },
            { label: "successor", description: "派后继" }, { label: "human", description: "交人" },
            { label: "cancel", description: "取消" },
          ],
        }] } } };
        if (reviewerCalls === 3) return { tool: { name: "genet", arguments: { args: ["workflow", "complete", "--outcome", humanB ? "human" : cancelExit ? "cancel" : resume ? "resume" : "repair", ...((humanB || cancelExit) ? ["--reason", humanB ? "The scope needs a Human decision" : "PM should cancel the request"] : []), "--evidence", "report=repair-approved"] } } };
        return { text: "PM decision was applied." };
      }
      if (body.includes("依据 PM 对复查建议的决定修复 Workflow")) {
        managerCalls++;
        if (managerCalls === 1) return { tool: { name: "bash", arguments: {
          command: `printf '\nRECOVERY_LIFECYCLE_FIXED\n' >> '${workerPrompt}' && "$GENEHUB_CLI" workflow activate --revision 1 && "$GENEHUB_CLI" workflow complete --evidence changes=activated`,
        } } };
        return { text: "Workflow candidate was repaired." };
      }
      if (body.includes("只读验收 WM 的修复")) {
        acceptorCalls++;
        if (acceptorCalls === 1) return { tool: { name: "genet", arguments: { args: ["workflow", "complete", ...(humanF ? ["--outcome", "human", "--reason", "Preview needs Human acceptance"] : []), "--evidence", "verdict=accepted"] } } };
        return { text: "Repair accepted." };
      }
      if (!decisionSent && body.includes("APPROVE_RECOVERY_REPAIR")) {
        decisionSent = true;
        return { tool: { name: "bash", arguments: {
          command: `"$GENEHUB_CLI" session respond ${reviewerId} --request ${questionId} --choose ${humanB ? "human" : cancelExit ? "cancel" : resume ? "resume" : "repair"}`,
        } } };
      }
      if (proactive && body.includes("START_PROACTIVE_RECOVERY")) {
        return { tool: { name: "bash", arguments: {
          command: `"$GENEHUB_CLI" workflow recovery start --run ${originalId} --reason "PM saw unhealthy execution"`,
        } } };
      }
      if (queue && body.includes("START_SECOND_REQUEST")) {
        return { tool: { name: "bash", arguments: {
          command: '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-second --message "second failed request" --no-wait',
        } } };
      }
      if (!started && body.includes("START_RECOVERY_LIFECYCLE")) {
        started = true;
        return { tool: { name: "bash", arguments: {
          command: `${corrupt ? "" : '"$GENEHUB_CLI" workflow activate --revision 0 && '}` + '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-original --message "repair this request" --no-wait',
        } } };
      }
      if (!successorRequested && body.includes("CONTINUE_RECOVERY_LIFECYCLE")) {
        successorRequested = true;
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-successor --retry-of ${originalId} --message "deliver repaired goal" --no-wait` } } };
      }
      return { text: "The daemon is tracking the request." };
    };
    opened.mock.script(...Array.from({ length: 80 }, () => ({ respond })));

    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      return reply.data;
    };
    const snapshot = async (id: string): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: id } });
      if (reply?.type !== "snapshot") throw new Error(`Session ${id} unavailable`);
      return reply.data;
    };
    const journal = async (runId: string): Promise<Array<{ eventType: string; actor?: string; messageId?: string }>> => {
      const result = await runGenetAsync(opened.daemon.genet,
        ["workflow", "journal", "--run", runId, "--since", "0", "--limit", "100"],
        opened.daemon.env, { cwd: opened.workspaceRoot });
      t.assertions.assert(result.code === 0, `workflow journal failed: ${result.stderr || result.stdout}`);
      return (JSON.parse(result.stdout) as { data: { events: Array<{ eventType: string; actor?: string; messageId?: string }> } }).data.events;
    };

    let originalId = "";
    stage = "dispatch business Run";
    await t.flows.main.sendPrompt(opened.client, pm, "START_RECOVERY_LIFECYCLE");
    if (proactive) {
      stage = "PM proactively starts recovery";
      await t.tools.waitUntil(async () => {
        const original = (await history()).find(run => run.taskId === "candidate-original");
        if (original) originalId = original.id;
        return original?.status === "running" && !!original.nodes.find(node => node.id === "work" && node.sessionId)
          && (await snapshot(pm)).summary.status === "idle";
      }, 30_000);
      await t.flows.main.sendPrompt(opened.client, pm, "START_PROACTIVE_RECOVERY");
    }
    if (corrupt) {
      stage = "damage active Candidate after business dispatch";
      await t.tools.waitUntil(async () => {
        const original = (await history()).find(run => run.taskId === "candidate-original");
        if (original) originalId = original.id;
        return original?.status === "running" && !!original.nodes.find(node => node.id === "work" && node.sessionId);
      }, 30_000);
      const original = (await history()).find(run => run.id === originalId)!;
      const candidate = path.join(opened.workspaceRoot, ".genethub/components/executor/candidates", `${original.dcgDigest.slice("sha256:".length)}.json`);
      t.assertions.assert(existsSync(candidate), "active Candidate was not stored in the Executor component");
      writeFileSync(candidate, "damaged Candidate\n");
    }
    stage = "wait for blocked business Run";
    await t.tools.waitUntil(async () => {
      const original = (await history()).find(run => run.taskId === "candidate-original");
      if (original) originalId = original.id;
      return original?.status === "blocked";
    }, 45_000);
    let recovery: WorkflowRunStatus | undefined;
    stage = "wait for recovery reviewer";
    await t.tools.waitUntil(async () => {
      const runs = await history();
      for (const run of runs) {
        if (!Array.isArray(run.handles)) throw new Error(`history omitted handles: ${JSON.stringify(run).slice(0, 1800)}`);
      }
      recovery = runs.find(run => run.handles.some(handle => handle.runId === originalId));
      return !!recovery?.nodes.find(node => node.id === "review" && node.sessionId);
    }, 45_000);
    const reviewer = recovery!.nodes.find(node => node.id === "review")!.sessionId!;
    reviewerId = reviewer;
    if (bypass) {
      stage = "reject a reviewer decision with no PM answer";
      await t.tools.waitUntil(async () => (await snapshot(reviewer)).summary.status === "closed", 25_000);
      const current = (await history()).find(run => run.id === recovery!.id)!;
      t.assertions.assert(current.nodes.find(node => node.id === "repair")?.status === "unreached"
        && current.nodes.find(node => node.id === "review")?.status !== "completed",
      "WR bypassed the durable PM choice and started repair");
      return;
    }
    if (queue) {
      stage = "queue second failed request under the same package";
      const damagedRequest = path.join(opened.workspaceRoot, ".genethub/components/pm/requests/wr_damaged_fixture");
      mkdirSync(damagedRequest, { recursive: true });
      writeFileSync(path.join(damagedRequest, "request.json"), "not a request snapshot\n");
      const pm2 = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, pm2, "START_SECOND_REQUEST");
      let second: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => {
        const runs = await history();
        second = runs.find(run => run.taskId === "candidate-second");
        return second?.status === "blocked";
      }, 35_000);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      t.assertions.assert(!(await history()).some(run => run.handles.some(handle => handle.runId === second!.id)),
        "second request bypassed the package recovery lock");
      const first = (await history()).find(run => run.id === originalId)!;
      const cancelled = await opened.client.call({ type: "workflow.cancel", payload: {
        workspaceId: opened.workspaceId, runId: originalId, expectedRevision: first.revision,
      } });
      t.assertions.assert(cancelled?.type === "workflowRun", "first request cancellation was refused");
      await t.tools.waitUntil(async () => {
        const runs = await history();
        return runs.some(run => run.handles.some(handle => handle.runId === second!.id)
          && run.nodes.some(node => node.id === "review" && node.sessionId));
      }, 40_000);
      const runs = await history();
      t.assertions.assert(runs.filter(run => run.handles.some(handle => handle.runId === second!.id)).length === 1,
        "queued recovery started more than once");
      return;
    }
    if (corrupt) {
      const events = await journal(recovery!.id);
      t.assertions.assert(events.filter(event => event.eventType === "recovery.fallback").length === 1,
        "damaged Candidate did not produce one committed fallback event");
      t.assertions.assert(recovery!.workflowId === "builtin-recovery", "damaged custom Candidate did not start the built-in WR");
      return;
    }
    if (proactive) {
      const original = (await history()).find(run => run.id === originalId)!;
      t.assertions.assert(original.reason?.includes("PM recovery:"), "proactive recovery lost PM's reason");
      const entries = await journal(recovery!.id);
      t.assertions.assert(entries.some(event => event.eventType === "recovery.started" && event.actor === "pm"),
        "proactive recovery did not use the shared PM-attributed entry");
      return;
    }
    stage = "wait for reviewer PM question";
    await t.tools.waitUntil(async () => (await snapshot(reviewer)).pendingPermissions.length > 0, 30_000);
    const question = (await snapshot(reviewer)).pendingPermissions[0]!;
    t.assertions.assert(question.questions?.[0]?.options.map(option => option.label).join(",") === "repair,resume,successor,human,cancel", "WR did not ask PM the five-way decision");
    questionId = question.id;
    await t.tools.waitUntil(async () => (await journal(recovery!.id))
      .some(event => event.eventType === "pause.requested" && event.messageId === questionId), 15_000);
    stage = "restart with one pending recovery question";
    opened.client.close();
    for (const verb of ["stop", "start"]) {
      const result = await runGenetAsync(opened.daemon.genet, ["daemon", verb], opened.daemon.env, { cwd: opened.workspaceRoot });
      t.assertions.assert(result.code === 0, `daemon ${verb} failed: ${result.stderr || result.stdout}`);
    }
    opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    await t.tools.waitUntil(async () => {
      const runs = await history();
      const pending = await snapshot(reviewer);
      return runs.length === 2 && runs.some(run => run.id === recovery!.id)
        && pending.pendingPermissions.some(request => request.id === questionId);
    }, 30_000);
    await t.flows.main.sendPrompt(opened.client, pm, "APPROVE_RECOVERY_REPAIR");
    stage = "wait for WM and acceptance";
    await t.tools.waitUntil(async () => {
      recovery = (await history()).find(run => run.id === recovery!.id);
      return recovery?.status === "blocked" && (humanB || humanF || cancelExit || recovery.reason?.includes("controlled exit"));
    }, 75_000);
    if (cancelExit) {
      t.assertions.assert(!recovery!.humanExit, "PM cancellation recommendation was incorrectly classified as Human exit d");
      const business = (await history()).find(run => run.id === originalId)!;
      const result = await opened.client.call({ type: "workflow.cancel", payload: {
        workspaceId: opened.workspaceId, runId: originalId, expectedRevision: business.revision,
      } });
      t.assertions.assert(result?.type === "workflowRun", "PM cancellation was refused");
      await t.tools.waitUntil(async () => {
        const runs = await history();
        return runs.find(run => run.id === originalId)?.status === "cancelled"
          && runs.find(run => run.id === recovery!.id)?.status === "cancelled";
      }, 30_000);
      t.assertions.assert(!(await history()).find(run => run.id === recovery!.id)?.humanExit,
        "cancelled request retained a platform failure Human card");
      return;
    }
    if (humanB || humanF) {
      const kind = humanB ? "b" : "f";
      const optionIds = humanB ? "acceptScope,cancel" : "pass,fail";
      const answer = humanB ? "acceptScope" : "pass";
      await t.tools.waitUntil(async () => {
        recovery = (await history()).find(run => run.id === recovery!.id);
        return recovery?.humanExit?.kind === kind && (await snapshot(pm)).pendingPermissions
          .some(card => card.id === recovery!.humanExit?.requestId);
      }, 20_000);
      const card = (await snapshot(pm)).pendingPermissions.find(item => item.id === recovery!.humanExit!.requestId)!;
      t.assertions.assert(card.options?.map(option => option.id).join(",") === optionIds,
        `Human exit ${kind} options are incorrect`);
      const answered = await opened.client.call({ type: "session.respondPermission", payload: {
        sessionId: pm, requestId: card.id, outcome: { outcome: "selected", optionId: answer },
      } });
      t.assertions.assert(answered?.type === "ack", `Human exit ${kind} answer was refused`);
      await t.tools.waitUntil(async () => {
        const runs = await history();
        const current = runs.find(run => run.id === recovery!.id);
        const business = runs.find(run => run.id === originalId);
        return current?.humanExit?.answer === answer && (humanB
          ? business?.status === "blocked"
          : business?.status === "completed" && current.status === "completed");
      }, 25_000);
      t.assertions.assert(humanB ? managerCalls === 0 : managerCalls >= 1 && acceptorCalls >= 1,
        `Human exit ${kind} skipped or added an unselected recovery stage`);
      return;
    }
    t.assertions.assert(reviewerCalls >= 3 && (resume ? managerCalls === 0 && acceptorCalls === 0 : managerCalls >= 1 && acceptorCalls >= 1),
      "recovery ran roles outside the PM-selected branch");
    if (!resume) {
      t.assertions.assert(recovery!.nodes.find(node => node.id === "repair")?.status === "completed", "WM repair was not retained");
      t.assertions.assert(recovery!.nodes.find(node => node.id === "accept")?.status === "completed", "WR acceptance was not retained");
    }
    t.assertions.assert((await journal(recovery!.id)).filter(event =>
      event.eventType === "pause.answered" && event.messageId === questionId).length === 1,
    "PM answer was missing or repeated in the committed journal");

    await t.flows.main.sendPrompt(opened.client, pm, "CONTINUE_RECOVERY_LIFECYCLE");
    stage = "wait for business successor";
    await t.tools.waitUntil(async () => {
      const runs = await history();
      return runs.some(run => run.taskId === "candidate-successor" && run.status === "completed")
        && runs.some(run => run.id === recovery!.id && run.status === "completed");
    }, 60_000);
    const runs = await history();
    const successor = runs.find(run => run.taskId === "candidate-successor")!;
    const executorSessions = runs.flatMap(run => run.executorSessionId ? [run.executorSessionId] : []);
    t.assertions.assert(new Set(executorSessions).size === executorSessions.length,
      "one Executor Session was reused for multiple Runs in the same project request");
    t.assertions.assert(successor.requestRunId === originalId, "successor changed the original request");
    t.assertions.assert(resume
      ? successor.dcgDigest === runs.find(run => run.id === originalId)!.dcgDigest
      : successor.dcgDigest !== runs.find(run => run.id === originalId)!.dcgDigest,
    "PM-selected recovery branch used the wrong Candidate identity");
    const archive = path.join(opened.workspaceRoot, ".genethub/components/executor/recoveries.jsonl");
    t.assertions.assert(existsSync(archive), "recovery summary was not written");
    const summaries = readFileSync(archive, "utf8").trim().split("\n").map(line => JSON.parse(line) as { runId: string; handledRunId: string; result: string; repair: string });
    t.assertions.assert(summaries.filter(summary => summary.runId === recovery!.id).length === 1
      && summaries.some(summary => summary.runId === recovery!.id && summary.handledRunId === originalId && summary.result === "completed"),
    "recovery archive did not record one successful handled Run");
    if (mode === "normal") t.assertions.assert(summaries.some(summary => summary.runId === recovery!.id
      && summary.repair.includes("changes=activated")),
    "recovery archive lost submitted intervention evidence");
    const daemonStatus = await runGenetAsync(opened.daemon.genet, ["daemon", "status"], opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(daemonStatus.code === 0, "daemon status was unavailable after patrol");
    const status = JSON.parse(daemonStatus.stdout) as {
      workflowPatrolLagMs?: number;
      workflowPatrolActiveJobs?: number;
      workflowPatrolOldestJobMs?: number | null;
    };
    t.assertions.assert(typeof status.workflowPatrolLagMs === "number" && status.workflowPatrolLagMs < 30_000,
      "daemon status omitted the Workflow patrol heartbeat");
    t.assertions.assert(typeof status.workflowPatrolActiveJobs === "number"
      && status.workflowPatrolActiveJobs >= 0
      && (status.workflowPatrolOldestJobMs == null || status.workflowPatrolOldestJobMs >= 0),
    "daemon status omitted pending patrol work");
  } catch (error) {
    const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } }).catch(() => null);
    const reviewerReply = reviewerId ? await opened.client.call({ type: "session.get", payload: { sessionId: reviewerId } }).catch(() => null) : null;
    const runs = reply?.type === "workflowRuns" ? reply.data.map(run => ({ id: run.id, taskId: run.taskId, status: run.status,
      reason: run.reason, nodes: run.nodes.map(node => ({ id: node.id, status: node.status, sessionId: node.sessionId })) })) : reply;
    const reviewerState = reviewerReply?.type === "snapshot" ? { status: reviewerReply.data.summary.status,
      pending: reviewerReply.data.pendingPermissions, items: reviewerReply.data.items.slice(-15) } : reviewerReply;
    const roleCalls = opened.mock.requests.filter(request => JSON.stringify(request).includes("只读复查被处理的 Run")).length;
    throw new Error(`${stage}: ${error}; runs=${JSON.stringify(runs).slice(0, 3500)}; reviewer=${JSON.stringify(reviewerState).slice(0, 6500)}; roleCalls=${roleCalls}`);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
}

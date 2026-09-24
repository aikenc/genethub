import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const structured of [false,true]) for (const scenario of ["negative", "orphan", "patrol-missed-event", "cancel", "self-cancel", "self-cancel-report", "late-resume", "independent"] as string[]) {
  if (structured && !["independent","cancel"].includes(scenario)) continue;
  defineSpecialty({
    id: `specialty.workflow-control.${scenario}${structured ? ".structured" : ""}`,
    title: `Project workflow recovery across ${scenario}`,
    oracle: "Public Run, Session and checker facts agree; a blocked Run stays visible to PM, cancellation fences withdrawn work, and explicit continuation preserves the original request",
    catches: ["idle PM hides an active task", "negative review leaves an ownerless running node", "PM consultation interrupts a Worker", "a cancelled task restarts without new user recovery", "a blocked retry after self-cancellation never reaches PM", "the executor's own cleanup demands a user message the user never owed"],
    tags: ["core", ...(structured ? ["structured-workflow"] : []), "workflow-control", "workflow-recovery", ...(scenario === "cancel" ? ["session-attention", "session-control-fixes"] : [])],
    llm: { default: "mock" }, expectedDurationMs: 30_000, timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
    productInterfaces: ["genet workflow", "session.send", "session.get", "session.list", "workflow.cancel", "workflow.budget", "workflow.check", "settings.setProvider", "settings.setAgentPreferences", ".genethub/workflows"],
  }, async t => {
    t.data.git.init(t.env.workspace);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let stage = "configure mock provider";
    let pmId: string | undefined;
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      stage = "seed Workflow package";
      const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
      const workflowFile = path.join(source, "flows/direct-change.yaml");
      const definitionSchema = "genehub.workflow.definition.v1";
      writeFileSync(path.join(source, "prompts/direct-worker.md"), "WORKFLOW_CONTROL_WORKER: only execute your assigned node.\n");
      writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({ schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet", modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/direct-worker.md" }));
      const node = (id: string, role = "worker") => ({
        id, uses: "agent.session", with: { role, workspace: "." },
        completion: { all: [{ key: "review", verify: "value.equals", expected: "approved" }] }, on: { completed: ["publish"] },
      });
      const {on: _edges,...activity} = node("review");
      writeFileSync(workflowFile, JSON.stringify(structured ? {
        schema:"genehub.workflow.definition.v2",id:"direct-change",version:2,
        nodes:[activity,{id:"publish",uses:"result.publish"}],
        structure:{body:{id:"delivery",type:"sequence",steps:[{id:"check",type:"task",activity:"review"},{id:"deliver",type:"task",activity:"publish"}]}},
      } : {
        schema: definitionSchema, id: "direct-change", version: 1, entry: "review",
        nodes: [node("review"), { id: "publish", uses: "result.publish" }],
      }));
      let nextCommand: string | undefined = '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task control-1 --message "检查启动循环" --no-wait';
      let nextInputId = "u_initial";
      let workerCalls = 0, pmCalls = 0;
      let staleResponseAt = 0;
      const respond = (request: unknown) => {
        const body = JSON.stringify(request);
        if (body.includes("WORKFLOW_CONTROL_WORKER")) {
          workerCalls++;
          if (scenario === "self-cancel-report" && workerCalls > 1) return workerCalls === 2
            ? { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "缺少交付证据，交回 PM" --evidence checks=missing' } } }
            : { text: "阻断已上报。" };
          if (scenario === "negative") return workerCalls % 2 === 1
            ? { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome changesRequested --reason "开始战斗后仍为 ready，无法移动或开火" --evidence checks=runtime-start-failed' } } }
            : { text: "不通过结论已提交。" };
          if (scenario === "orphan") return { text: "评审未通过，但本回合没有提交结果。" };
          if (scenario === "patrol-missed-event") return { delayMs: 6_500, text: "节点结束，但故意不提交 Workflow 结果。" };
          return { hang: true as const };
        }
        pmCalls++;
        if (nextCommand && body.includes(nextInputId)) {
          const command = nextCommand; nextCommand = undefined;
          const delayMs = nextInputId === "u_stale_recovery" ? 10_000 : 0;
          if (delayMs) staleResponseAt = Date.now() + delayMs;
          return { delayMs, tool: { name: "bash", arguments: { command } } };
        }
        return { text: "PM 已核对任务事实，等待你的下一条消息。" };
      };
      opened.mock.script(...Array.from({ length: 80 }, () => ({ respond })));
      stage = "create PM Session";
      const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      pmId = pm;
      const snapshot = async (sessionId = pm): Promise<SessionSnapshot> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } })
          .catch(error => { throw new Error(`session.get ${sessionId}: ${error}`); });
        if (reply?.type !== "snapshot") throw new Error("missing Session snapshot");
        return reply.data;
      };
      const history = async () => {
        const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 50 } })
          .catch(error => { throw new Error(`workflow.history: ${error}`); });
        if (reply?.type !== "workflowRuns") throw new Error("missing Run history");
        return reply.data.filter(run => run.handles.length === 0);
      };
      const get = async (runId: string): Promise<WorkflowRunStatus> => {
        const reply = await opened.client.call({ type: "workflow.get", payload: { workspaceId: opened.workspaceId, runId } });
        if (reply?.type !== "workflowRun") throw new Error("missing Run");
        return reply.data;
      };
      const check = async (runId: string) => {
        const reply = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId, runId } });
        if (reply?.type !== "workflowCheck") throw new Error("missing checker report");
        return reply.data;
      };
      const send = (messageId: string, text: string, taskRunId?: string) => { nextInputId = messageId; return opened.client.call({ type: "session.send", payload: { sessionId: pm, messageId, text, taskRunId, attachments: [], continuesRound: null, artifactPreviewBaseUrl: null } }); };
      stage = "send initial PM request";
      await send("u_initial", "请检查游戏启动循环，并持续追踪任务。");
      stage = "wait for initial Workflow Run";
      await t.tools.waitUntil(async () => (await history()).length === 1 && (await snapshot()).summary.status === "idle", 40_000);
      stage = "read initial Workflow Run";
      let run = (await history())[0]!;
      const original = run.id;
      const waitTerminal = async () => {
        await t.tools.waitUntil(async () => { run = await get(run.id); return run.status === "blocked"; }, 35_000);
        t.assertions.assert(!run.activeNodes.length && !run.cleanupError, "blocked Run still owns active nodes or incomplete cleanup");
      };
      if (scenario === "negative" || scenario === "orphan" || scenario === "patrol-missed-event") {
        let idleAt = 0;
        if (scenario === "patrol-missed-event") {
          stage = "wait for a mature Worker to omit its result";
          await t.tools.waitUntil(async () => {
            const current = (await history())[0];
            const worker = current?.nodes.find(node => node.uses === "agent.session")?.sessionId;
            return !!worker && (await snapshot(worker)).summary.status === "idle";
          }, 30_000);
          idleAt = Date.now();
        }
        stage = "wait for blocked Workflow Run";
        await waitTerminal();
        if (scenario === "patrol-missed-event") {
          t.assertions.assert(run.updatedAtMs - idleAt <= 5_500,
            `patrol did not turn a missed Worker result within one 5-second tick: ${run.updatedAtMs - idleAt}ms`);
          const result = await runGenetAsync(opened.daemon.genet,
            ["workflow", "journal", "--run", run.id, "--since", "0", "--limit", "100"],
            opened.daemon.env, { cwd: opened.workspaceRoot });
          t.assertions.assert(result.code === 0, `workflow journal failed: ${result.stderr || result.stdout}`);
          const events = (JSON.parse(result.stdout) as { data: { events: Array<{ eventType: string; actor: string }> } }).data.events;
          t.assertions.assert(events.some(event => event.eventType === "run.blocked" && event.actor === "patrol"),
            `patrol state turn omitted its origin from the committed journal: ${JSON.stringify(events)}`);
        }
        stage = "check blocked Workflow Run";
        const findings = (await check(run.id)).findings;
        t.assertions.assert(findings.some(f => f.code === "defaultBlockedExit"), "checker omitted the default exit");
        if (scenario === "negative") t.assertions.assert(run.nodes.find(node => node.uses === "agent.session")?.outcome === "changesRequested", "negative review was discarded or treated as success");
        t.assertions.assert(run.nodes.find(node => node.id === "publish")?.status === "unreached", "failed review published a successful result");

      } else {
        await t.tools.waitUntil(() => workerCalls > 0, 30_000);
        run = await get(original);
        const workerId = run.nodes.find(node => node.uses === "agent.session")?.sessionId;
        t.assertions.assert(!!workerId,"started Worker missing from Run");
        await t.tools.waitUntil(async () => {
          const summary = (await snapshot()).summary;
          return summary.workSummary?.executing === 1
            && summary.workSummary.tasks[0]?.executing === true;
        }, 15_000);
        const before = await snapshot(workerId);
        const callsBefore = workerCalls;
        t.assertions.assert((await snapshot()).summary.workSummary?.running === 1, "idle PM lost the active task");
        const listed = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: false } });
        t.assertions.assert(listed?.type === "sessions" && listed.data.find(s => s.id === pm)?.workSummary?.running === 1, "list and detail disagree on task state");
        t.assertions.assert(listed?.type === "sessions" && listed.data.find(s => s.id === pm)?.workSummary?.executing === 1, "list confused an idle PM or a waiting Worker with live squad execution");
        await send("u_question", "现在进行到哪里了？只回答我的问题。", original);
        await t.tools.waitUntil(async () => { const s = await snapshot(); return s.summary.status === "idle" && !s.summary.inputSummary?.pendingMessageIds.includes("u_question"); }, 30_000);
        const after = await snapshot(workerId);
        t.assertions.assert(workerCalls === callsBefore && after.summary.status === before.summary.status, "PM question interrupted or restarted its Worker");
        let independent: WorkflowRunStatus | undefined;
        if (scenario === "independent") {
          nextCommand = '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task independent --message "独立的新任务" --no-wait';
          await send("u_independent", "这是另一项独立需求，请另行启动。");
          await t.tools.waitUntil(async () => (await history()).length === 2, 30_000);
          independent = (await history()).find(other => other.id !== original)!;
          t.assertions.assert(independent.requestRunId !== original, "new independent user request was silently attached to existing work");
        }
        if (scenario === "self-cancel" || scenario === "self-cancel-report") {
          // The executor cancels its own stuck execution and continues the same
          // request. The user withdrew nothing, so there is no user message
          // after the cancellation and the shared budget stays the limiter.
          run = await get(original);
          const resume = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task self-recovery --retry-of ${quote(original)} --resume-cancelled --message "自清理后继续原请求" --no-wait`;
          nextCommand = `"$GENEHUB_CLI" workflow cancel --run ${quote(original)} --revision ${run.revision}`
            + ` && for i in $(seq 1 60); do ${resume} && exit 0; sleep 0.5; done; exit 1`;
          await send("u_self_cancel", "这个节点卡住了，自己收拾干净再继续同一件事。", original);
          await t.tools.waitUntil(async () => (await history()).length === 2, 40_000);
          const resumed = (await history()).find(other => other.id !== original)!;
          t.assertions.assert((await get(original)).status === "cancelled" && resumed.requestRunId === original && resumed.status === "running",
            "executor self-recovery did not continue inside the cancelled original request");
          t.assertions.assert(JSON.stringify(resumed.requestBudget) === JSON.stringify(run.requestBudget),
            "self-recovery opened a fresh request budget");
          await t.tools.waitUntil(async () => !(await snapshot()).summary.inputSummary?.pendingMessageIds.includes("u_self_cancel"), 30_000);
          if (scenario === "self-cancel-report") {
            await t.tools.waitUntil(async () => (await get(resumed.id)).status === "blocked", 35_000);
            await t.tools.waitUntil(async () => (await snapshot()).items.some(item => item.type === "userMessage"
              && item.id.startsWith("flow_") && item.text.includes(resumed.id) && item.text.includes("状态 blocked")), 35_000);
            const reports = (await snapshot()).items.filter(item => item.type === "userMessage"
              && item.id.startsWith("flow_") && item.text.includes(resumed.id) && item.text.includes("状态 blocked"));
            t.assertions.assert(reports.length === 1, "blocked retry notice was dropped or duplicated before reaching PM");
            t.note(`scenario=${scenario}; retry=${resumed.id}; PM received one blocked notice`);
            return;
          }
          await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: resumed.id, expectedRevision: (await get(resumed.id)).revision } });
          await t.tools.waitUntil(async () => (await get(resumed.id)).status === "cancelled", 35_000);
          t.note(`scenario=${scenario}; worker calls=${workerCalls}; PM calls=${pmCalls}`);
          return;
        }
        if (scenario === "late-resume") {
          nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task stale-recovery --retry-of ${quote(original)} --resume-cancelled --message "继续旧请求" --no-wait`;
          await send("u_stale_recovery", "继续核对当前任务。", original);
          await t.tools.waitUntil(() => staleResponseAt > 0, 15_000);
        }
        run = await get(original);
        const pmCallsBeforeCancel = pmCalls;
        const cancel = await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: original, expectedRevision: run.revision } });
        t.assertions.assert(cancel?.type === "workflowRun" && cancel.data.status === "cancelling", "cancel did not persist a fence before cleanup");
        await t.tools.waitUntil(async () => (await get(original)).status === "cancelled", 35_000);
        if (scenario === "cancel") {
          await new Promise(resolve => setTimeout(resolve, 4_000));
          t.assertions.assert(pmCalls === pmCallsBeforeCancel && !(await get(original)).reportPending,
            "direct task cancellation created a PM LLM/report obligation");
        }
        if (scenario === "late-resume") {
          t.assertions.assert(Date.now() < staleResponseAt, "cancellation did not settle before the delayed old PM response; race prerequisite was not reached");
          await t.tools.waitUntil(async () => !(await snapshot()).summary.inputSummary?.pendingMessageIds.includes("u_stale_recovery"), 30_000);
          t.assertions.assert((await history()).length === 1 && JSON.stringify(opened.mock.requests).includes("new user message after cancellation"),
            "a pre-cancellation PM input bypassed the fence with resume-cancelled");
        }
        t.assertions.assert((await snapshot(workerId)).summary.status === "closed", "cancelled task retained a running Worker");
        if (independent) {
          const other = await get(independent.id);
          t.assertions.assert(other.status === "running", "cancelling one original request stopped another independent task");
          await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: other.id, expectedRevision: other.revision } });
          await t.tools.waitUntil(async () => (await get(other.id)).status === "cancelled", 30_000);
        }
        if (scenario === "cancel" || scenario === "late-resume") {
          nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task forbidden-repair --retry-of ${quote(original)} --message "自动返工" --no-wait`;
          await send("u_after_cancel", "取消后目前是什么状态？", original);
          await t.tools.waitUntil(async () => { const s = await snapshot(); return s.summary.status === "idle" && !s.summary.inputSummary?.pendingMessageIds.includes("u_after_cancel"); }, 30_000);
          t.assertions.assert((await history()).length === 1 && JSON.stringify(opened.mock.requests).includes("taskCancelled"), "ordinary consultation reopened a cancelled request");
          nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task explicit-recovery --retry-of ${quote(original)} --resume-cancelled --message "明确恢复原任务" --no-wait`;
          await send("u_explicit_resume", "明确恢复刚才取消的任务。", original);
          await t.tools.waitUntil(async () => (await history()).length === 2, 30_000);
          const resumed = (await history()).find(other => other.id !== original)!;
          t.assertions.assert(resumed.requestRunId === original && resumed.status === "running", "explicit recovery lost original request bounds");
          await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: resumed.id, expectedRevision: resumed.revision } });
          await t.tools.waitUntil(async () => (await get(resumed.id)).status === "cancelled", 30_000);
        }
      }
      t.note(`scenario=${scenario}; worker calls=${workerCalls}; PM calls=${pmCalls}`);
    } catch (error) {
      const session = pmId ? await opened.client.call({ type: "session.get", payload: { sessionId: pmId } }).catch(() => null) : null;
      throw new Error(`${stage}: ${error}; PM Session tail: ${JSON.stringify(session).slice(-6000)}`);
    } finally { opened.client.close(); await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env); await opened.mock.stop(); }
  });
}

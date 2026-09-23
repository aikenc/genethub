import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const structured of [false,true]) for (const scenario of ["negative", "orphan", "cancel", "self-cancel", "late-resume", "independent", "bounds", "silence-wr", "silence-wr-limit", "silence-no-wr", "silence-human"] as const) {
  if (structured && !["independent","silence-wr","silence-human","cancel"].includes(scenario)) continue;
  const silence = scenario.startsWith("silence");
  const wr = scenario.startsWith("silence-wr");
  const diagnosticFailover = scenario === "silence-wr" && !structured;
  defineSpecialty({
    id: `specialty.workflow-control.${scenario}${structured ? ".structured" : ""}`,
    title: `Project workflow recovery across ${scenario}`,
    oracle: "Public Run, Session and checker facts agree; negative outcomes have a default exit, PM input leaves Workers executing, cancellation fences all related work, and actual 180-second silence creates bounded diagnostics that can change failed models",
    catches: ["idle PM hides an active task", "negative review leaves an ownerless running node", "repair keys reset the original request budget", "PM cannot raise an exhausted request budget", "a stale budget update overwrites a PM decision", "PM consultation interrupts a Worker", "silence or Human waiting is mistaken for cancellation", "a cancelled task restarts without new user recovery", "diagnosis reuses a route that already failed in this Run", "diagnosis gives up after one model fails or loses its read-only scope", "the executor's own cleanup demands a user message the user never owed"],
    tags: ["core", ...(structured ? ["structured-workflow"] : []), ...(wr ? ["pm-exception-recovery"] : []), "workflow-control", "workflow-recovery", ...(scenario === "cancel" ? ["session-attention", "session-control-fixes"] : [])],
    llm: { default: "mock" }, expectedDurationMs: silence ? 200_000 : 30_000, timeoutMs: silence ? 270_000 : 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
    productInterfaces: ["genet workflow", "session.send", "session.get", "session.list", "workflow.cancel", "workflow.budget", "workflow.check", "settings.setProvider", "settings.setAgentPreferences", ".genethub/workflows"],
  }, async t => {
    t.data.git.init(t.env.workspace);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      if (diagnosticFailover) {
        await opened.client.call({ type: "settings.setProvider", payload: {
          providerId: "deepseek", apiKey: "sk-test", baseUrl: opened.mock.origin, label: null, dialect: null,
          models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-backup"],
        } });
        await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: {
          runtimes: {}, selectedTags: ["Pro"], modelProfiles: [
            { agentId: "genet", modelId: "deepseek/deepseek-v4-flash", tags: ["Pro"], cost: "low" },
            { agentId: "genet", modelId: "deepseek/deepseek-v4-pro", tags: ["Pro"], cost: "medium" },
            { agentId: "genet", modelId: "deepseek/deepseek-v4-backup", tags: ["Pro"], cost: "high" },
          ],
        } } });
      }
      const source = t.flows.main.seedWorkflowPackage({
        projectRoot: opened.workspaceRoot,
        // The diagnostic carrier is declared by a Space source, never by a
        // manifest field: policy is the platform's, the carrier is the
        // package's. Declaring it is enough to bind the role.
        spaces: wr
          ? [{ name: "wr", components: [{ componentId: "worker", role: "wr" }, { componentId: "diagnostic" }] }]
          : [],
      });
      const workflowFile = path.join(source, "flows/direct-change.yaml");
      const definitionSchema = "genehub.workflow.definition.v1";
      writeFileSync(path.join(source, "prompts/direct-worker.md"), "WORKFLOW_CONTROL_WORKER: only execute your assigned node.\n");
      writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify(diagnosticFailover
        ? { schema: "genehub.workflow.role.v3", id: "worker", tags: ["Pro"], userInteraction: "readOnly", prompt: "prompts/direct-worker.md" }
        : { schema: "genehub.workflow.role.v1", id: "worker", agentId: "genet", modelId: "deepseek/deepseek-v4-flash", userInteraction: "readOnly", prompt: "prompts/direct-worker.md" }));
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
      if (wr) {
        writeFileSync(path.join(source, "roles/wr.yaml"), JSON.stringify(diagnosticFailover
          ? { schema: "genehub.workflow.role.v3", id: "wr", tags: ["Pro"], evidenceOnly: true, userInteraction: "readOnly", prompt: "prompts/wr.md" }
          : { schema: "genehub.workflow.role.v1", id: "wr", agentId: "genet", modelId: "deepseek/deepseek-v4-flash", evidenceOnly: true, userInteraction: "readOnly", prompt: "prompts/wr.md" }));
        writeFileSync(path.join(source, "prompts/wr.md"), "WORKFLOW_CONTROL_WR: report bounded evidence only.\n");
        // A flow referencing the role is what loads it into the Candidate;
        // a file in roles/ that nothing references stays out by design.
        writeFileSync(path.join(source, "flows/diagnose.yaml"), JSON.stringify({ schema: definitionSchema, id: "diagnose", version: 1, entry: "diagnose", nodes: [node("diagnose", "wr"), { id: "publish", uses: "result.publish" }] }));
      }
      let nextCommand: string | undefined = '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task control-1 --message "检查启动循环" --no-wait';
      let nextInputId = "u_initial";
      let workerCalls = 0, diagnosticCalls = 0, pmCalls = 0;
      const workerModels: string[] = [], diagnosticModels: string[] = [];
      let staleResponseAt = 0;
      const respond = (request: unknown) => {
        const body = JSON.stringify(request);
        if (body.includes("bounded, read-only Workflow diagnosis")) {
          diagnosticCalls++;
          if (diagnosticFailover) {
            const model = String((request as { model?: string }).model);
            diagnosticModels.push(model);
            return model === "deepseek-v4-pro" ? { status: 429 } : { text: "The read-only diagnosis completed after model failover." };
          }
          if (diagnosticCalls === 1 || scenario === "silence-wr-limit") return { emptyToolIdDeltas: true, tool: { name: "genet", arguments: { args: ["workflow", "check"] } } };
          return { text: "静默诊断：Worker 仍有执行归属，先检查在途工具，不要自动取消。" };
        }
        if (body.includes("WORKFLOW_CONTROL_WORKER")) {
          workerCalls++;
          if (diagnosticFailover) {
            const model = String((request as { model?: string }).model);
            workerModels.push(model);
            return model === "deepseek-v4-flash" ? { status: 429 } : { hang: true as const };
          }
          if (scenario === "negative" || scenario === "bounds") return workerCalls % 2 === 1
            ? { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome changesRequested --reason "开始战斗后仍为 ready，无法移动或开火" --evidence checks=runtime-start-failed' } } }
            : { text: "不通过结论已提交。" };
          if (scenario === "orphan") return { text: "评审未通过，但本回合没有提交结果。" };
          if (scenario === "silence-human") return { tool: { name: "request_user_input", arguments: { questions: [{ id: "scope", header: "范围", question: "确认验收范围", options: [{ label: "启动", description: "检查启动" }, { label: "全部", description: "检查所有关卡" }] }] } } };
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
      const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const snapshot = async (sessionId = pm): Promise<SessionSnapshot> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error("missing Session snapshot");
        return reply.data;
      };
      const history = async () => {
        const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 50 } });
        if (reply?.type !== "workflowRuns") throw new Error("missing Run history");
        return reply.data;
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
      await send("u_initial", "请检查游戏启动循环，并持续追踪任务。");
      await t.tools.waitUntil(async () => (await history()).length === 1 && (await snapshot()).summary.status === "idle", 40_000);
      let run = (await history())[0]!;
      const original = run.id;
      const waitTerminal = async () => {
        await t.tools.waitUntil(async () => { run = await get(run.id); return run.status === "blocked"; }, 35_000);
        t.assertions.assert(!run.activeNodes.length && !run.cleanupError, "blocked Run still owns active nodes or incomplete cleanup");
      };
      if (scenario === "negative" || scenario === "orphan" || scenario === "bounds") {
        await waitTerminal();
        const findings = (await check(run.id)).findings;
        t.assertions.assert(findings.some(f => f.code === "defaultBlockedExit"), "checker omitted the default exit");
        if (scenario !== "orphan") t.assertions.assert(run.nodes.find(node => node.uses === "agent.session")?.outcome === "changesRequested", "negative review was discarded or treated as success");
        t.assertions.assert(run.nodes.find(node => node.id === "publish")?.status === "unreached", "failed review published a successful result");
        if (scenario === "bounds") {
          for (let attempt = 2; attempt <= 3; attempt++) {
            workerCalls = 0;
            nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task control-${attempt} --retry-of ${quote(original)} --message "修复启动阻断" --no-wait`;
            await send(`u_repair_${attempt}`, "请修复同一个任务。", original);
            await t.tools.waitUntil(async () => (await history()).length === attempt, 35_000);
            run = (await history()).find(other => other.taskId === `control-${attempt}`)!;
            t.assertions.assert(run.requestRunId === original, "repair reset original request identity");
            await waitTerminal();
          }
          nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task control-4 --retry-of ${quote(original)} --message "再试一次" --no-wait`;
          await send("u_limit", "仍然是原任务，再尝试。", original);
          await t.tools.waitUntil(async () => { const s = await snapshot(); return s.summary.status === "idle" && !s.summary.inputSummary?.pendingMessageIds.includes("u_limit"); }, 30_000);
          t.assertions.assert((await history()).length === 3, "new dispatch key bypassed shared attempt limit");
          t.assertions.assert(JSON.stringify(opened.mock.requests).includes("requestBudgetExceeded"), "budget refusal was not visible to PM");

          const beforeBudget = await get(original);
          t.assertions.assert(beforeBudget.requestBudget.maxRuns === 3 && beforeBudget.requestBudget.revision === 0,
            "default request budget was not projected to PM");
          const executionMs = (await history()).reduce((total, prior) => total + prior.updatedAtMs - prior.createdAtMs, 0);
          const amendedDeadlineSeconds = Math.ceil(executionMs / 1000) + 10;
          // Real stopped time, not a patched runtime clock: a budget amendment
          // must not charge this wait as execution and refuse the next admission.
          await new Promise(resolve => setTimeout(resolve, 11_000));
          workerCalls = 0;
          nextCommand = `"$GENEHUB_CLI" workflow budget --run ${quote(original)} --revision ${beforeBudget.requestBudget.revision} --max-runs 4 --deadline-seconds ${amendedDeadlineSeconds} --max-llm-rounds 512 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task control-4 --retry-of ${quote(original)} --message "预算已调整，继续原任务" --no-wait`;
          await send("u_budget", "放开这条请求的预算，继续跑。", original);
          await t.tools.waitUntil(async () => (await history()).length === 4, 35_000);
          run = (await history()).find(other => other.taskId === "control-4")!;
          t.assertions.assert(run.requestRunId === original, "budget update reset original request identity");
          t.assertions.assert(run.requestBudget.revision === 1 && run.requestBudget.maxRuns === 4
            && run.requestBudget.deadlineMs === amendedDeadlineSeconds * 1000 && run.requestBudget.maxLlmRounds === 512,
            "raised shared budget was not visible on the retry Run");
          await waitTerminal();
          const root = await get(original);
          t.assertions.assert(root.requestBudget.revision === 1 && root.requestBudget.maxRuns === 4,
            "retry execution lost the PM budget decision");
          if (root.executorSessionId) {
            const flow = await opened.client.call({ type: "session.flow", payload: { sessionId: root.executorSessionId } });
            t.assertions.assert(flow?.type === "sessionFlow" && flow.data.messages.some(message => message.kind === "run.budgetUpdated"),
              "budget update was not retained in the Executor control timeline");
          }
          const stale = spawnSync(opened.daemon.genet, ["workflow", "budget", "--run", original, "--revision", "0", "--max-runs", "5"],
            { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" });
          t.assertions.assert(stale.status !== 0 && `${stale.stdout}${stale.stderr}`.includes("预算 revision 冲突"),
            "stale budget update overwrote the PM decision");
        }
      } else {
        await t.tools.waitUntil(() => workerCalls > (diagnosticFailover ? 1 : 0), 30_000);
        run = await get(original);
        const workerId = run.nodes.find(node => node.uses === "agent.session")?.sessionId;
        t.assertions.assert(!!workerId,"started Worker missing from Run");
        if (scenario === "silence-human") {
          await t.tools.waitUntil(async () => {
            const waiting = await snapshot(workerId);
            return waiting.summary.status === "waiting" && waiting.pendingPermissions.length > 0;
          }, 15_000);
          const requestId = (await snapshot(workerId)).pendingPermissions[0]!.id;
          await t.tools.waitUntil(async () => (await snapshot()).summary.workSummary?.tasks[0]?.waiting?.some(request => request.requestId === requestId) === true, 15_000);
          await t.tools.waitUntil(async () => (await snapshot()).items.some(item => item.type === "userMessage" && item.id.startsWith("flow_") && item.text.includes(requestId)), 15_000);
          t.assertions.assert((await snapshot(workerId)).summary.interactionSummary?.requests.some(request => request.requestId === requestId), "worker summary omitted the real request reference");
        }
        await t.tools.waitUntil(async () => {
          const summary = (await snapshot()).summary;
          return summary.workSummary?.executing === (scenario === "silence-human" ? 0 : 1)
            && summary.workSummary.tasks[0]?.executing === (scenario !== "silence-human");
        }, 15_000);
        const before = await snapshot(workerId);
        const callsBefore = workerCalls;
        t.assertions.assert((await snapshot()).summary.workSummary?.running === 1, "idle PM lost the active task");
        const listed = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: false } });
        t.assertions.assert(listed?.type === "sessions" && listed.data.find(s => s.id === pm)?.workSummary?.running === 1, "list and detail disagree on task state");
        t.assertions.assert(listed?.type === "sessions" && listed.data.find(s => s.id === pm)?.workSummary?.executing === (scenario === "silence-human" ? 0 : 1), "list confused an idle PM or a waiting Worker with live squad execution");
        await send("u_question", "现在进行到哪里了？只回答我的问题。", original);
        await t.tools.waitUntil(async () => { const s = await snapshot(); return s.summary.status === "idle" && !s.summary.inputSummary?.pendingMessageIds.includes("u_question"); }, 30_000);
        const after = await snapshot(workerId);
        t.assertions.assert(workerCalls === callsBefore && after.summary.status === before.summary.status, "PM question interrupted or restarted its Worker");
        if (silence) {
          run = await get(original);
          const node = run.nodes.find(node => node.uses === "agent.session")!;
          const baseline = Math.max(node.assignedAtMs ?? run.createdAtMs, node.lastActivityAtMs ?? 0);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, baseline + 179_000 - Date.now())));
          t.assertions.assert(!(await check(original)).findings.some(f => f.code === "silentAttempt"), "silence fired before 180 seconds");
          t.assertions.assert(diagnosticCalls === 0, "normal execution consumed automatic WR calls");
          await new Promise(resolve => setTimeout(resolve, Math.max(0, baseline + 181_000 - Date.now())));
          if (scenario === "silence-human") {
            t.assertions.assert((await check(original)).findings.some(f => f.code === "humanWait"), "Human wait was not identified");
            t.assertions.assert(diagnosticCalls === 0 && (await get(original)).status === "running", "Human wait was treated as a stalled machine");
            const requestId = (await snapshot(workerId)).pendingPermissions[0]!.id;
            t.assertions.assert((await snapshot()).items.filter(item => item.type === "userMessage" && item.id.startsWith("flow_") && item.text.includes(requestId)).length === 1,
              "one unchanged Human request repeatedly woke PM");
          } else {
            t.assertions.assert((await check(original)).findings.some(f => f.code === "silentAttempt"), "181-second silent attempt was missed");
            await t.tools.waitUntil(async () => wr
              ? ["limited", "finished", "failed"].includes((await get(original)).diagnostics?.[0]?.status ?? "")
              : (await check(original)).findings.some(f => f.code === "diagnosis"), 15_000);
            const diagnosticIds = (await get(original)).diagnostics?.map(d => d.sessionId) ?? [];
            t.assertions.assert(wr ? diagnosticIds.length === 1 && (scenario === "silence-wr-limit" ? diagnosticCalls >= 8 : diagnosticCalls === 2) : diagnosticIds.length === 0, "diagnostic count or restricted checker execution was wrong");
            if (wr) {
              t.assertions.assert((await get(original)).diagnostics?.[0]?.status === (scenario === "silence-wr-limit" ? "limited" : "finished"), "diagnosis did not reach its expected result");
              if (diagnosticFailover) {
                t.assertions.assert(workerModels.join(",") === "deepseek-v4-flash,deepseek-v4-pro", `Worker did not first exclude the exhausted route: ${workerModels}`);
                t.assertions.assert(diagnosticModels.join(",") === "deepseek-v4-pro,deepseek-v4-backup", `diagnosis reused a known failed route or did not fall through: ${diagnosticModels}`);
                const migrated = await snapshot(diagnosticIds[0]);
                t.assertions.assert(migrated.summary.modelId === "deepseek/deepseek-v4-backup"
                  && migrated.summary.managed?.userInteraction === "readOnly"
                  && !!migrated.summary.managed?.evidenceScope,
                  "same diagnostic Session lost its replacement model or read-only evidence boundary");
              }
              const calls = opened.mock.requests.filter(request => JSON.stringify(request).includes("bounded, read-only Workflow diagnosis"));
              t.assertions.assert(!JSON.stringify(calls).includes("'args' is required"), "streamed tool arguments were lost");
              const expected = scenario === "silence-wr-limit" ? "WR 诊断失败" : "已完成并有回复";
              await t.tools.waitUntil(async () => JSON.stringify((await snapshot()).items).includes(expected), 15_000);
            }
            await new Promise(resolve => setTimeout(resolve, 4_000));
            t.assertions.assert((await get(original)).diagnostics?.length === diagnosticIds.length && (await get(original)).status === "running", "same stall repeated diagnosis or cancelled a long execution");
          }
        }
        let independent: WorkflowRunStatus | undefined;
        if (scenario === "independent") {
          nextCommand = '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task independent --message "独立的新任务" --no-wait';
          await send("u_independent", "这是另一项独立需求，请另行启动。");
          await t.tools.waitUntil(async () => (await history()).length === 2, 30_000);
          independent = (await history()).find(other => other.id !== original)!;
          t.assertions.assert(independent.requestRunId !== original, "new independent user request was silently attached to existing work");
        }
        if (scenario === "self-cancel") {
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
      t.note(`scenario=${scenario}; worker calls=${workerCalls}; automatic WR calls=${diagnosticCalls}; PM calls=${pmCalls}`);
    } finally { opened.client.close(); await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env); await opened.mock.stop(); }
  });
}

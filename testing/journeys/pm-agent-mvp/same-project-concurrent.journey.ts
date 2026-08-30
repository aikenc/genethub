import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { PmProjectStatus, SessionSummary } from "@genehub/proto";

import {
  awaitHumanDecision,
  BlockedError,
  defineJourney,
  humanDecisionResponseDeadline,
  type CaseContext,
  type HumanDecisionRequest,
} from "../../framework/public.ts";

import { PM_MODEL, WORK_AGENT } from "./support.ts";

const RUN_BUDGET_MS = 10 * 60_000;
const SETUP_BUDGET_MS = 8 * 60_000;
const HUMAN_DECISION_RESPONSE_MS = 60_000;
const POST_DECISION_RUN_RESERVE_MS = 2 * 60_000;

interface ConcurrentRequirement {
  id: "daily" | "save" | "cocos";
  title: string;
  graph: "feature" | "bugfix" | "migration";
  prompt: string;
}

defineJourney(
  {
    id: "journey.pm-agent-mvp.same-project-concurrent-requirements",
    title: "One project runs three budgeted PM requirements concurrently",
    oracle:
      "one daemon project exposes three independent PM Session Workflow Runs, at least two Run-owned WorkSessions overlap on distinct Agent Spaces, and every Run delivers or fails closed within its own ten-minute budget",
    catches: [
      "test-runner environment parallelism is mistaken for PM concurrency",
      "one PM Session receives or mutates another Session's WorkPackages",
      "two Runs acquire the same exclusive Agent Space",
      "a Run continues dispatching after its wall-clock or WorkSession budget",
      "one completed or failed Run stops the other Session supervisors",
      "a cheaper flash model is silently upgraded to a max model",
    ],
    tags: ["pm-agent-mvp-concurrent-real", "product-journey"],
    llm: { default: "real", realEligible: true },
    resources: {
      // One test environment is intentional. Product PM Sessions, not testctl
      // workers, must create the concurrency observed by this case.
      environments: 1,
      cpu: 8,
      // These are scheduler weights, not cgroup limits. Claim the complete
      // single-environment pool so testctl can launch exactly one product
      // environment; concurrency is created by PM Sessions inside it.
      memoryMb: 2_048,
      io: 1,
      browser: 0,
      pool: "real-llm",
    },
    expectedDurationMs: 14 * 60_000,
    timeoutMs: 20 * 60_000,
    retention: true,
    surfaces: ["daemon", "agent", "workbench-client", "git", "agent-space-builder"],
    productInterfaces: [
      "pm.session.create",
      "pm.project.status",
      "pm.workflow.transition",
      "genet-cli",
      "workSession.create",
    ],
  },
  async (t) => {
    await t.flows.main.requireAliyunQwen38FlashAvailable();
    seedConcurrentBaseline(t.env.workspace);
    t.flows.main.seedAliyunQwen38Flash(t.env);
    const workModel = t.flows.main.configureOpencodeQwen38Flash(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.requireAgentReady(opened.client, WORK_AGENT);
      await prepareSharedTopology(t, opened);

      const requirements = concurrentRequirements();
      const sessions = new Map<string, SessionSummary>();
      const eventLogs = new Map<string, Awaited<ReturnType<typeof t.flows.main.attachEventLog>>>();
      for (const requirement of requirements) {
        const pm = await createPmSession(t, opened, requirement.title);
        sessions.set(requirement.id, pm);
        eventLogs.set(requirement.id, await t.flows.main.attachEventLog(opened.client, pm.id));
      }

      const promptStartedAt = Date.now();
      const deadline = promptStartedAt + RUN_BUDGET_MS;
      await settleBefore(
        Promise.all(
          requirements.map((requirement) =>
            t.flows.main.sendPrompt(
              opened.client,
              sessions.get(requirement.id)!.id,
              requirement.prompt,
            ),
          ),
        ),
        deadline,
        "concurrent PM prompt turns did not return inside the shared ten-minute acceptance window",
      );
      const terminalObservedAt = new Map<string, number>();
      let maxConcurrentOwners = 0;
      let maxConcurrentSpaces = 0;
      let decisionCount = 0;
      let latest: PmProjectStatus | undefined;

      while (Date.now() < deadline && terminalObservedAt.size < requirements.length) {
        for (const requirement of requirements) {
          const failure = permanentProviderFailure(eventLogs.get(requirement.id) ?? []);
          if (failure) {
            throw new BlockedError(
              `Qwen3.8 Flash prerequisite failed for ${requirement.id}; no model fallback is allowed: ${failure}`,
            );
          }
        }
        latest = await requireProjectStatus(opened.client, opened.workspaceId);
        const ownedSessionIds = new Set([...sessions.values()].map((session) => session.id));
        const running = latest.workPackages.filter(
          (item) => ownedSessionIds.has(item.controllerSessionId) && item.status === "running",
        );
        maxConcurrentOwners = Math.max(
          maxConcurrentOwners,
          new Set(running.map((item) => item.controllerSessionId)).size,
        );
        maxConcurrentSpaces = Math.max(
          maxConcurrentSpaces,
          new Set(running.map((item) => item.agentSpace)).size,
        );

        for (const requirement of requirements) {
          const pm = sessions.get(requirement.id)!;
          const run = latest.workflowRuns.find((item) => item.controllerSessionId === pm.id);
          if (!run) continue;
          if (run.graphId && run.graphId !== requirement.graph) {
            throw new Error(`${requirement.id} selected ${run.graphId}, expected ${requirement.graph}`);
          }
          if (run.budget) {
            t.assertions.assert(
              run.budget.wallClockMs === RUN_BUDGET_MS,
              `${requirement.id} pinned ${run.budget.wallClockMs}ms instead of ten minutes`,
            );
            t.assertions.assert(
              run.budget.activeWorkSessions <= run.budget.maxConcurrentWorkSessions,
              `${requirement.id} exceeded its concurrent WorkSession budget`,
            );
            t.assertions.assert(
              run.budget.workSessionsStarted <= run.budget.maxWorkSessions,
              `${requirement.id} exceeded its total WorkSession budget`,
            );
          }
          if (run.interpreterError) {
            throw new Error(`${requirement.id} interpreter failed: ${run.interpreterError}`);
          }
          if (run.status === "budgetExhausting" || run.status === "budgetExhausted") {
            throw new Error(`${requirement.id} exhausted its ten-minute Run budget`);
          }
          if (run.status === "completed" && !terminalObservedAt.has(requirement.id)) {
            terminalObservedAt.set(requirement.id, Date.now());
          }

          const humanEdges = run.availableEdges.filter(
            (edge) => edge.chooseBy === "user" && edge.satisfied,
          );
          if (humanEdges.length > 0) {
            const responseDeadline = humanDecisionResponseDeadline({
              nowMs: Date.now(),
              runDeadlineMs: deadline,
              responseBudgetMs: HUMAN_DECISION_RESPONSE_MS,
              postDecisionReserveMs: POST_DECISION_RUN_RESERVE_MS,
            });
            if (responseDeadline === undefined) {
              throw new BlockedError(
                `${requirement.id} reached a human decision too late to preserve both the operator response window and two minutes of post-decision execution inside its ten-minute Run budget`,
              );
            }
            const decision = await awaitHumanDecision(
              humanDecisionRequest(
                latest,
                opened.workspaceId,
                pm.id,
                requirement.id,
                run,
                humanEdges,
                responseDeadline,
                deadline,
              ),
              responseDeadline,
            );
            const current = await requireProjectStatus(opened.client, opened.workspaceId);
            const currentRun = current.workflowRuns.find(
              (item) => item.controllerSessionId === pm.id,
            );
            if (
              currentRun?.id !== run.id ||
              currentRun.revision !== run.revision ||
              !currentRun.availableEdges.some(
                (edge) =>
                  edge.id === decision.edgeId && edge.chooseBy === "user" && edge.satisfied,
              )
            ) {
              throw new Error(`human decision ${decision.requestId} became stale`);
            }
            const transitioned = await opened.client.call({
              type: "pm.workflow.transition",
              payload: {
                workspaceId: opened.workspaceId,
                sessionId: pm.id,
                edgeId: decision.edgeId,
                facts: [],
              },
            });
            t.assertions.assert(
              transitioned?.type === "projectStatus",
              `pm.workflow.transition returned ${transitioned?.type}`,
            );
            decisionCount += 1;
          }
        }
        if (terminalObservedAt.size < requirements.length) await sleep(1_000);
      }

      latest = await requireProjectStatus(opened.client, opened.workspaceId);
      t.assertions.assert(
        terminalObservedAt.size === requirements.length,
        `only ${terminalObservedAt.size}/${requirements.length} same-project Runs completed in ten minutes: ${JSON.stringify(
          latest.workflowRuns.map((run) => ({
            session: run.controllerSessionId,
            graph: run.graphId,
            status: run.status,
            remainingMs: run.budget?.remainingMs,
          })),
        )}`,
      );
      t.assertions.assert(
        maxConcurrentOwners >= 2 && maxConcurrentSpaces >= 2,
        `product concurrency was not observed; owners=${maxConcurrentOwners}, spaces=${maxConcurrentSpaces}`,
      );

      for (const requirement of requirements) {
        const pm = sessions.get(requirement.id)!;
        const run = latest.workflowRuns.find((item) => item.controllerSessionId === pm.id);
        t.assertions.assert(run?.status === "completed", `${requirement.id} ended as ${run?.status}`);
        t.assertions.assert(Boolean(run?.budget), `${requirement.id} has no pinned execution budget`);
        t.assertions.assert(
          (terminalObservedAt.get(requirement.id) ?? Number.POSITIVE_INFINITY) - promptStartedAt <=
            RUN_BUDGET_MS,
          `${requirement.id} exceeded ten minutes from concurrent prompt dispatch`,
        );
        const packages = latest.workPackages.filter(
          (item) => item.controllerSessionId === pm.id,
        );
        t.assertions.assert(packages.length > 0, `${requirement.id} created no WorkPackage`);
        t.assertions.assert(
          packages.every((item) => item.status === "accepted" || item.status === "cancelled"),
          `${requirement.id} retained non-terminal packages`,
        );
        t.assertions.assert(
          packages.every((item) => item.workflowRunId === run?.id),
          `${requirement.id} has a WorkPackage bound to another Run`,
        );
        for (const item of packages.filter((item) => item.status === "accepted")) {
          t.assertions.assert(
            item.reviewVerdict === "pass" && Boolean(item.reviewSessionId),
            `${requirement.id}/${item.id} lacks independent passing review evidence`,
          );
          for (const sessionId of [item.workSessionId, item.reviewSessionId]) {
            if (!sessionId) continue;
            const snapshot = await opened.client.call({
              type: "session.get",
              payload: { sessionId },
            });
            t.assertions.assert(snapshot?.type === "snapshot", `session.get returned ${snapshot?.type}`);
            if (snapshot?.type !== "snapshot") continue;
            t.assertions.assert(snapshot.data.summary.agentId === WORK_AGENT, `${sessionId} did not use OpenCode`);
            t.assertions.assert(
              snapshot.data.summary.modelId === workModel,
              `${sessionId} used ${snapshot.data.summary.modelId ?? "no model"}, expected ${workModel}`,
            );
          }
        }
      }

      assertConcurrentDeliverables(t, t.env.workspace);
      t.note(
        `same-project-concurrency ${JSON.stringify({
          environments: 1,
          projectWorkspaceId: opened.workspaceId,
          pmSessions: requirements.length,
          maxConcurrentOwners,
          maxConcurrentSpaces,
          humanDecisions: decisionCount,
          elapsedMs: Date.now() - promptStartedAt,
          models: { pm: PM_MODEL, work: workModel },
          runs: requirements.map((requirement) => {
            const run = latest!.workflowRuns.find(
              (item) => item.controllerSessionId === sessions.get(requirement.id)!.id,
            );
            return {
              id: requirement.id,
              graph: run?.graphId,
              workSessions: run?.budget?.workSessionsStarted,
              remainingMs: run?.budget?.remainingMs,
            };
          }),
        })}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

async function prepareSharedTopology(
  t: CaseContext,
  opened: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>,
): Promise<void> {
  const setup = await createPmSession(t, opened, "并发验收拓扑准备");
  const events = await t.flows.main.attachEventLog(opened.client, setup.id);
  await t.flows.main.sendPrompt(
    opened.client,
    setup.id,
    `只准备现有项目的共享 AgentSpace 池，不选择 Workflow、不创建 WorkPackage、不修改 repositories/game 的文件内容。外层 main、本地 repositories/game 和 worktrees/ 已由用户准备。这是 pool-only bootstrap：六个 Space 的最终名称、角色、标签、分支和 worktree 已全部给定，不需要调研或设计。

通过公开 genet CLI 完成并取证：
1. 将项目依次推进到 preflight-passed、git-ready。
2. 只用 Git 管理命令从 repositories/game/main 创建三个已知分支和 worktree，不读取业务文件：
   - work/daily-challenge -> worktrees/task-feature/game
   - work/save-migration -> worktrees/task-bugfix/game
   - work/cocos4-adapter -> worktrees/task-migration/game
3. 用 agent-space init 创建六个最小 Space：task-feature、task-bugfix、task-migration、review-a、review-b、review-c。禁止创建任何自定义 Skill、Provider 或项目契约；capability tag 只是 Coordinator 元数据，不要求同名 Skill。
4. 每个 .code-workspace 保持 Space 根目录为第一个 folder，并且只追加以下精确第二 folder：
   - task-feature 与 review-a: ../../worktrees/task-feature/game
   - task-bugfix 与 review-b: ../../worktrees/task-bugfix/game
   - task-migration 与 review-c: ../../worktrees/task-migration/game
   不得把多个 sibling worktree 暴露给同一个 Space。
5. 批量执行六个 Space 的 Builder check、build --dry-run --require-no-post-commands、build --require-no-post-commands、verify；不要运行 explain，不要用 schema/help 探测，不要尝试无效 flag。
6. 把 spaces/pm 和六个 Space 的受管源提交到外层 main，保持外层 Git 干净。
7. 用 workspace register-agent-space 注册六个 workspace，再用 pm project space record 记录同一精确外层 commit。能力标签必须是：
   - task-feature: daily、integration
   - task-bugfix: diagnosis、bugfix
   - task-migration: research、migration、cocos
   - review-a: --role review、daily
   - review-b: --role review、bugfix
   - review-c: --role review、cocos
8. 依次执行 pm project advance --to topology-verified、pm project advance --to workspaces-registered、pm project advance --to active 后结束本回合。这里要求的是 ProjectPhase=active，不是 lifecycle --to active；active phase 只表示共享拓扑可执行，不要选择需求 Workflow、创建 Intent 或 WorkPackage。

使用已加载 Skill 中的既定命令形式，把同类操作合并成尽量少的 bash 工具调用。内置 Skill 给出的标准 ignore 清单和 register-agent-space 命令就是完整合同，禁止为重新发现它们而递归扫描产品源码、target、node_modules 或安装目录。禁止读取 repositories/game 源码、禁止安装 Agent、禁止改变模型，也不要等待后续消息。`,
  );

  const deadline = Date.now() + SETUP_BUDGET_MS;
  while (Date.now() < deadline) {
    const providerFailure = permanentProviderFailure(events);
    if (providerFailure) {
      throw new BlockedError(`Qwen3.8 Flash topology setup failed: ${providerFailure}`);
    }
    const status = await requireProjectStatus(opened.client, opened.workspaceId);
    const implementations = status.agentSpaces.filter(
      (space) => space.role === "implementation",
    );
    const reviews = status.agentSpaces.filter((space) => space.role === "review");
    const snapshot = await opened.client.call({
      type: "session.get",
      payload: { sessionId: setup.id },
    });
    if (
      status.phase === "active" &&
      implementations.length >= 3 &&
      reviews.length >= 3 &&
      snapshot?.type === "snapshot" &&
      snapshot.data.summary.status === "idle"
    ) {
      t.assertions.assert(
        status.workflowRuns.find((run) => run.controllerSessionId === setup.id)?.status ===
          "discussion",
        "topology setup consumed a delivery Workflow Run",
      );
      assertPreboundTopology(t, status);
      return;
    }
    await sleep(1_000);
  }
  throw new Error("shared same-project AgentSpace topology was not ready within eight minutes");
}

function assertPreboundTopology(
  t: CaseContext,
  status: PmProjectStatus,
): void {
  const bindings = [
    {
      implementation: "task-feature",
      review: "review-a",
      capability: "daily",
      branch: "work/daily-challenge",
    },
    {
      implementation: "task-bugfix",
      review: "review-b",
      capability: "bugfix",
      branch: "work/save-migration",
    },
    {
      implementation: "task-migration",
      review: "review-c",
      capability: "cocos",
      branch: "work/cocos4-adapter",
    },
  ] as const;

  for (const binding of bindings) {
    const worktree = path.join(
      t.env.workspace,
      "worktrees",
      binding.implementation,
      "game",
    );
    t.assertions.assert(existsSync(worktree), `${binding.implementation} worktree is missing`);
    t.assertions.assert(
      git(worktree, ["branch", "--show-current"]) === binding.branch,
      `${binding.implementation} is not bound to ${binding.branch}`,
    );

    for (const [spaceName, expectedRole] of [
      [binding.implementation, "implementation"],
      [binding.review, "review"],
    ] as const) {
      const record = status.agentSpaces.find((space) => space.name === spaceName);
      t.assertions.assert(Boolean(record), `${spaceName} was not recorded`);
      t.assertions.assert(record?.role === expectedRole, `${spaceName} has role ${record?.role}`);
      t.assertions.assert(
        record?.tags.includes(binding.capability) === true,
        `${spaceName} lacks ${binding.capability} capability`,
      );
      const workspaceFile = path.join(
        t.env.workspace,
        "spaces",
        spaceName,
        `${spaceName}.code-workspace`,
      );
      const parsed = JSON.parse(readFileSync(workspaceFile, "utf8")) as {
        folders?: Array<{ path?: string }>;
      };
      const folders = parsed.folders?.map((folder) => folder.path) ?? [];
      t.assertions.assert(
        folders.length === 2 &&
          folders[0] === "." &&
          folders[1] === `../../worktrees/${binding.implementation}/game`,
        `${spaceName} exposes unexpected folders: ${JSON.stringify(folders)}`,
      );
    }
  }
}

async function createPmSession(
  t: CaseContext,
  opened: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>,
  title: string,
): Promise<SessionSummary> {
  const created = await opened.client.call({
    type: "pm.session.create",
    payload: {
      workspaceId: opened.workspaceId,
      modelId: PM_MODEL,
      modeId: null,
      effortId: "medium",
      title,
    },
  });
  t.assertions.assert(created?.type === "session", `pm.session.create returned ${created?.type}`);
  if (created?.type !== "session") throw new Error("PM Session was not created");
  t.assertions.assert(created.data.kind === "pm", `${title} is not a PM Session`);
  t.assertions.assert(created.data.modelId === PM_MODEL, `${title} used ${created.data.modelId}`);
  t.assertions.assert(created.data.effortId === "medium", `${title} did not use medium effort`);
  return created.data;
}

function concurrentRequirements(): ConcurrentRequirement[] {
  const common = `这是同一项目内三个并行需求之一。项目初始化和共享拓扑已完成且 phase=active；不要再次执行 pm project init/advance/lifecycle，不要重新 workspace register-agent-space、重建或 space record 现有 Space。只管理当前 PM Session 的 Intent、Run 和 WorkPackage；不得读取、推进、取消或复用其他 PM Session 的包。立即选择指定 Workflow，10 分钟预算不可延长。正常推进只读取一次 pm project workflow status，不要读取包含所有 Session 的 pm project show。每个活动 WorkAgent 节点只创建一个结果型包，使用指定 capability tag 和 branch 让 Coordinator 从 workflow status 的既有 Space 池分配。每个 package put 只传需求中明确给出的一个 --space-tag；不得再添加 implementation、integration、diagnosis、research 或 migration 等节点基础标签，Coordinator 会单独应用这些 selector。Coordinator 返回的 worktree 已由用户创建并在实现/评审 Workspace 中精确注册；package put 后核对返回绑定并复用它，不要再建 worktree。只用 OpenCode + bailian-token-plan-personal/qwen3.8-flash，PM 保持 ali/qwen3.8-flash medium。每个候选必须绑定精确 commit/tree，经 capability 匹配的独立 review Space 复验后 Accepted；最终通过受控 PM CLI 合入 repositories/game/main 并保持仓库干净，PM 自己不得 cd 或用 bash 进入业务仓库/worktree。误建且尚未派发的 Planned/Ready 包可用 cancelled 撤回并立即以新 id 补位；WorkSession 已开始、形成候选或真实执行失败时必须记录 blocked，禁止用 cancelled 绕过恢复和评审。不要轮询 WorkSession；--no-wait 派发后结束回合，等待 Supervisor 唤醒。`;
  return [
    {
      id: "daily",
      title: "并行需求：每日挑战",
      graph: "feature",
      prompt: `${common}

选择 feature。Intent 是新增一个小而完整的每日挑战模块；implement 和 integrate 包都使用 --branch work/daily-challenge --space-tag daily。验收：新增 src/features/daily-challenge.js，按 UTC 日期稳定生成 seed、规则和完成 key；新增 Node 测试覆盖同日稳定与跨日变化；从 src/main.js 导出。不要改存档迁移或渲染适配。`,
    },
    {
      id: "save",
      title: "并行需求：存档迁移修复",
      graph: "bugfix",
      prompt: `${common}

选择 bugfix。reproduce 和 fix 包都使用 --branch work/save-migration --space-tag bugfix。复现并修复 src/save.js：v1 存档迁移到 v2 时必须保留有限数值 score，非法值回落 0，同时保持 mode；先用测试证据复现，再形成修复候选。不要改每日挑战或渲染适配。`,
    },
    {
      id: "cocos",
      title: "并行需求：COCOS 4 适配切片",
      graph: "migration",
      prompt: `${common}

选择 migration。investigate 与 migrate 包都使用 --branch work/cocos4-adapter --space-tag cocos。完成一个受控渲染适配切片：调研证据固定官方 https://github.com/cocos/cocos4 的 4.0.0-alpha.30；investigate WorkAgent 的第一次结论必须同时返回该只读 worktree 的精确 HEAD commit/tree、分支、git status --porcelain 与调查命令退出码，不得追加回合补身份；更新 engine.lock.json，并让 src/render/adapter.js 暴露 cocos4 标识且保留 drawFrame 公共合同；添加合同测试。不要声称完成整个 5 万行引擎迁移，不要改每日挑战或存档迁移。`,
    },
  ];
}

function humanDecisionRequest(
  status: PmProjectStatus,
  projectWorkspaceId: string,
  sessionId: string,
  requirementId: string,
  run: PmProjectStatus["workflowRuns"][number],
  edges: PmProjectStatus["workflowRuns"][number]["availableEdges"],
  responseDeadline: number,
  runDeadline: number,
): HumanDecisionRequest {
  return {
    schema: "genehub.test-human-decision-request.v1",
    requestId: `${requirementId}-${sessionId}-${run.id}-${run.revision}`,
    createdAt: new Date().toISOString(),
    responseDeadlineAt: new Date(responseDeadline).toISOString(),
    runDeadlineAt: new Date(runDeadline).toISOString(),
    caseId: process.env.TESTCTL_CASE_ID ?? "unknown",
    projectWorkspaceId,
    sessionId,
    workflowRunId: run.id,
    workflowRevision: run.revision,
    ...(run.graphId ? { graphId: run.graphId } : {}),
    activeNodes: run.activeNodes,
    edges: edges.map((edge) => ({
      id: edge.id,
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.description ? { description: edge.description } : {}),
      from: edge.from,
      to: edge.to,
      condition: edge.condition,
    })),
    evidence: {
      packages: status.workPackages
        .filter((item) => item.controllerSessionId === sessionId)
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          agentSpace: item.agentSpace,
          ...(item.workSessionId ? { workSessionId: item.workSessionId } : {}),
          ...(item.candidateCommit ? { candidateCommit: item.candidateCommit } : {}),
          ...(item.candidateTree ? { candidateTree: item.candidateTree } : {}),
          ...(item.reviewSessionId ? { reviewSessionId: item.reviewSessionId } : {}),
          ...(item.blockReason ? { blockReason: item.blockReason } : {}),
          ...(item.reviewVerdict ? { reviewVerdict: item.reviewVerdict } : {}),
        })),
      quarantinedSpaces: status.agentSpaces
        .filter((space) => space.resourceState === "quarantined")
        .map((space) => ({
          name: space.name,
          purpose: space.purpose,
          resourceState: space.resourceState,
        })),
    },
  };
}

function seedConcurrentBaseline(workspace: string): void {
  mkdirSync(path.join(workspace, "repositories", "game", "src", "features"), {
    recursive: true,
  });
  mkdirSync(path.join(workspace, "repositories", "game", "src", "render"), {
    recursive: true,
  });
  mkdirSync(path.join(workspace, "repositories", "game", "tests"), { recursive: true });
  mkdirSync(path.join(workspace, "repositories", "game", "scripts"), { recursive: true });
  mkdirSync(path.join(workspace, "worktrees"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".gitignore"),
    ".genethub/\nrepositories/\nworktrees/\n",
  );
  gitInit(workspace);
  git(workspace, ["add", ".gitignore"]);
  git(workspace, ["commit", "-qm", "Seed concurrent PM project"]);

  const game = path.join(workspace, "repositories", "game");
  writeFileSync(
    path.join(game, "package.json"),
    `${JSON.stringify(
      {
        name: "pm-concurrent-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test", build: "node scripts/build.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(game, "index.html"),
    "<!doctype html><meta charset=\"utf-8\"><title>Concurrent PM Fixture</title><script type=\"module\" src=\"./src/main.js\"></script>\n",
  );
  writeFileSync(
    path.join(game, "src", "main.js"),
    "export { migrateSave } from './save.js';\nexport { renderer } from './render/adapter.js';\n",
  );
  writeFileSync(
    path.join(game, "src", "save.js"),
    "export function migrateSave(input = {}) {\n  return { version: 2, score: 0, mode: input.mode ?? 'normal' };\n}\n",
  );
  writeFileSync(
    path.join(game, "src", "render", "adapter.js"),
    "export const renderer = { engine: 'three', drawFrame(scene) { return { scene, engine: this.engine }; } };\n",
  );
  writeFileSync(
    path.join(game, "engine.lock.json"),
    `${JSON.stringify({ name: "Three.js", version: "0.180.0", source: "https://github.com/mrdoob/three.js" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(game, "tests", "baseline.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { migrateSave, renderer } from '../src/main.js';\ntest('baseline contracts', () => { assert.equal(migrateSave({ mode: 'arcade' }).mode, 'arcade'); assert.equal(renderer.drawFrame('scene').scene, 'scene'); });\n",
  );
  writeFileSync(
    path.join(game, "scripts", "build.mjs"),
    "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('index.html', 'dist/index.html');\n",
  );
  writeFileSync(path.join(game, ".gitignore"), "dist/\nnode_modules/\n");
  gitInit(game);
  git(game, ["add", "-A"]);
  git(game, ["commit", "-qm", "Seed accepted H5 baseline"]);
}

function assertConcurrentDeliverables(t: CaseContext, workspace: string): void {
  const game = path.join(workspace, "repositories", "game");
  t.assertions.assert(git(game, ["branch", "--show-current"]) === "main", "game is not on main");
  t.assertions.assert(git(game, ["status", "--porcelain"]) === "", "game repository is dirty");
  const daily = path.join(game, "src", "features", "daily-challenge.js");
  t.assertions.assert(existsSync(daily), "daily challenge deliverable is missing");
  t.assertions.assert(/utc|date|seed/i.test(readFileSync(daily, "utf8")), "daily challenge is not deterministic");
  const save = readFileSync(path.join(game, "src", "save.js"), "utf8");
  t.assertions.assert(/score/.test(save) && !/score:\s*0\s*,\s*mode/.test(save), "save migration still drops score");
  const engine = readFileSync(path.join(game, "engine.lock.json"), "utf8");
  t.assertions.assert(
    /COCOS 4/i.test(engine) && /4\.0\.0-alpha\.30/.test(engine) && /github\.com\/cocos\/cocos4/.test(engine),
    "COCOS 4 adapter identity is incomplete",
  );
  const renderer = readFileSync(path.join(game, "src", "render", "adapter.js"), "utf8");
  t.assertions.assert(/cocos/i.test(renderer) && /drawFrame/.test(renderer), "renderer contract was not migrated");
  for (const script of ["test", "build"]) {
    const result = spawnSync("npm", ["run", script], {
      cwd: game,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    t.assertions.assert(
      result.status === 0,
      `npm run ${script} failed: ${(result.stderr || result.stdout || "no output").slice(-4_000)}`,
    );
  }
}

async function requireProjectStatus(
  client: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>["client"],
  workspaceId: string,
): Promise<PmProjectStatus> {
  const reply = await client.call({ type: "pm.project.status", payload: { workspaceId } });
  if (reply?.type !== "projectStatus") {
    throw new Error(`pm.project.status returned ${reply?.type}`);
  }
  return reply.data;
}

function permanentProviderFailure(events: Array<{ type?: string; raw: unknown }>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "turnFailed") continue;
    const evidence = JSON.stringify(event.raw);
    if (
      /\b(?:401|402|403|429)\b|payment required|insufficient (?:balance|credit|quota)|billing|invalid api key|unauthori[sz]ed|forbidden/i.test(
        evidence,
      )
    ) {
      return evidence.slice(0, 2_000);
    }
  }
  return undefined;
}

function gitInit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  git(cwd, ["branch", "-M", "main"]);
  git(cwd, ["config", "user.email", "pm-concurrency@genehub.test"]);
  git(cwd, ["config", "user.name", "PM Concurrency Journey"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleBefore<T>(
  operation: Promise<T>,
  deadlineMs: number,
  message: string,
): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(message)),
          Math.max(0, deadlineMs - Date.now()),
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

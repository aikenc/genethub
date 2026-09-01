import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { PmProjectStatus, SessionSummary } from "@genehub/proto";

import {
  awaitHumanDecision,
  BlockedError,
  defineJourney,
  humanDecisionStillApplicable,
  type CaseContext,
  type HumanDecisionRequest,
} from "../../framework/public.ts";

import {
  assertEffectiveProjectScaleBetween,
  effectiveProjectSourceLines,
  PM_MODEL,
  WORK_AGENT,
} from "./support.ts";

const RUN_BUDGET_MS = 10 * 60_000;
const SETUP_BUDGET_MS = 3 * 60_000;
const HUMAN_DECISION_RESPONSE_MS = 60_000;
const JOURNEY_WALL_RESERVE_MS = 3 * HUMAN_DECISION_RESPONSE_MS;

interface ConcurrentRequirement {
  id: "greenfield" | "feature" | "bugfix";
  title: string;
  graph: "feature" | "bugfix";
  prompt: string;
}

interface ConcurrentRepositories {
  greenfield: string;
  feature: string;
  bugfix: string;
}

const TOPOLOGY_BINDINGS = [
  {
    implementation: "greenfield-content",
    review: "review-greenfield-content",
    capability: "greenfield-content",
    branch: "work/greenfield-content",
    repository: "greenfield",
  },
  {
    implementation: "greenfield-rules",
    review: "review-greenfield-rules",
    capability: "greenfield-rules",
    branch: "work/greenfield-rules",
    repository: "greenfield",
  },
  {
    implementation: "greenfield-engine",
    review: "review-greenfield-engine",
    capability: "greenfield-engine",
    branch: "work/greenfield-engine",
    repository: "greenfield",
  },
  {
    implementation: "greenfield-shell",
    review: "review-greenfield-shell",
    capability: "greenfield-shell",
    branch: "work/greenfield-shell",
    repository: "greenfield",
  },
  {
    implementation: "feature-content",
    review: "review-feature-content",
    capability: "expedition-levels",
    branch: "work/expedition-levels",
    repository: "feature-app",
  },
  {
    implementation: "feature-rewards",
    review: "review-feature-rewards",
    capability: "expedition-rewards",
    branch: "work/expedition-rewards",
    repository: "feature-app",
  },
  {
    implementation: "feature-rules",
    review: "review-feature-rules",
    capability: "expedition-rules",
    branch: "work/expedition-rules",
    repository: "feature-app",
  },
  {
    implementation: "feature-progress",
    review: "review-feature-progress",
    capability: "expedition-progress",
    branch: "work/expedition-progress",
    repository: "feature-app",
  },
  {
    implementation: "bugfix-auth",
    review: "review-bugfix-auth",
    capability: "auth",
    branch: "work/bugfix-auth",
    repository: "bugfix-app",
  },
  {
    implementation: "bugfix-inventory",
    review: "review-bugfix-inventory",
    capability: "inventory",
    branch: "work/bugfix-inventory",
    repository: "bugfix-app",
  },
  {
    implementation: "bugfix-ranking",
    review: "review-bugfix-ranking",
    capability: "ranking",
    branch: "work/bugfix-ranking",
    repository: "bugfix-app",
  },
] as const;

defineJourney(
  {
    id: "journey.pm-agent-mvp.same-project-concurrent-requirements",
    title: "One project runs three production-scale PM deliveries concurrently",
    oracle:
      "one project runs three independent PM Sessions concurrently: a 20-30k-line greenfield delivery, a 5-10k-line feature increment on a 20-30k baseline, and three parallel bug fixes; Worker implements, Reviewer independently judges exact candidates, Coordinator accepts/integrates, and every Run stays within its own ten-minute active/request budget",
    catches: [
      "test-runner environment parallelism is mistaken for PM concurrency",
      "one PM Session receives or mutates another Session's WorkPackages",
      "two Runs acquire the same exclusive Agent Space",
      "a Run continues dispatching after its wall-clock or WorkSession budget",
      "one completed or failed Run stops the other Session supervisors",
      "a cheaper flash model is silently upgraded to a max model",
      "small patches are presented as production-scale throughput proof",
      "PM performs implementation, technical review, or Git integration instead of managing evidence and budget",
      "individually reviewed candidates violate a shared public contract after integration",
      "a slice review approves an empty/null assertion that is only true before sibling registry integration",
      "a slice Reviewer fails a candidate solely because a compatible sibling has not yet been composed",
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
    expectedDurationMs: 13 * 60_000,
    timeoutMs: 22 * 60_000,
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
    // This journey is a retained throughput/profile run. Keep the complete
    // Coordinator lifecycle in daemon.log; the default warning-only test
    // filter is intentionally too sparse for diagnosing PM orchestration.
    t.env.env.GENEHUB_LOCAL_LOG = "info";
    const repositories = seedConcurrentProjects(t.env.workspace);
    const featureBaselineLines = assertEffectiveProjectScaleBetween(
      t,
      repositories.feature,
      20_000,
      30_000,
      "feature baseline",
    );
    t.note(`same-project-scale featureBaselineEffectiveSourceLines=${featureBaselineLines}`);
    t.flows.main.seedAliyunQwen38Flash(t.env);
    const workModel = t.flows.main.configureOpencodeQwen38Flash(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.requireAgentReady(opened.client, WORK_AGENT);
      const setupStartedAt = Date.now();
      const setupSession = await prepareSharedTopology(t, opened);
      const setupFinishedAt = Date.now();

      const topology = await requireProjectStatus(opened.client, opened.workspaceId);
      const requirements = concurrentRequirements(topology, workModel);
      const sessions = new Map<string, SessionSummary>();
      const eventLogs = new Map<string, Awaited<ReturnType<typeof t.flows.main.attachEventLog>>>();
      for (const requirement of requirements) {
        const pm = await createPmSession(t, opened, requirement.title);
        sessions.set(requirement.id, pm);
        eventLogs.set(requirement.id, await t.flows.main.attachEventLog(opened.client, pm.id));
      }

      const promptStartedAt = Date.now();
      const executionDeadline = promptStartedAt + RUN_BUDGET_MS;
      const journeyDeadline = executionDeadline + JOURNEY_WALL_RESERVE_MS;
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
        executionDeadline,
        "concurrent PM prompt turns did not return inside the shared ten-minute acceptance window",
      );
      const terminalObservedAt = new Map<string, number>();
      let maxConcurrentOwners = 0;
      let maxConcurrentSpaces = 0;
      let decisionCount = 0;
      let latest: PmProjectStatus | undefined;

      let maxConcurrentBugfixPackages = 0;
      const maxConcurrentPackages = new Map<string, number>();
      while (Date.now() < journeyDeadline && terminalObservedAt.size < requirements.length) {
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
        const bugfixSessionId = sessions.get("bugfix")?.id;
        maxConcurrentBugfixPackages = Math.max(
          maxConcurrentBugfixPackages,
          running.filter((item) => item.controllerSessionId === bugfixSessionId).length,
        );
        for (const requirement of requirements) {
          const sessionId = sessions.get(requirement.id)?.id;
          maxConcurrentPackages.set(
            requirement.id,
            Math.max(
              maxConcurrentPackages.get(requirement.id) ?? 0,
              running.filter((item) => item.controllerSessionId === sessionId).length,
            ),
          );
        }

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
            t.assertions.assert(
              run.budget.llmRequestsObserved <= run.budget.maxLlmRequests,
              `${requirement.id} exceeded its LLM request budget`,
            );
            if (run.graphId === "feature") {
              t.assertions.assert(
                run.budget.maxLlmRequests === 128,
                `${requirement.id} pinned ${run.budget.maxLlmRequests} instead of the calibrated 128-request feature budget`,
              );
            }
          }
          if (run.interpreterError) {
            throw new Error(`${requirement.id} interpreter failed: ${run.interpreterError}`);
          }
          if (run.status === "budgetExhausting" || run.status === "budgetExhausted") {
            const requestBudgetExhausted =
              Boolean(run.budget) &&
              run.budget!.llmRequestsObserved >= run.budget!.maxLlmRequests;
            throw new Error(
              requestBudgetExhausted
                ? `${requirement.id} exhausted its LLM request budget (${run.budget!.llmRequestsObserved}/${run.budget!.maxLlmRequests})`
                : `${requirement.id} exhausted its ten-minute active wall-clock budget`,
            );
          }
          if (run.status === "completed" && !terminalObservedAt.has(requirement.id)) {
            terminalObservedAt.set(requirement.id, Date.now());
          }

          const humanEdges = run.availableEdges.filter(
            (edge) => edge.chooseBy === "user" && edge.satisfied,
          );
          if (humanEdges.length > 0) {
            const responseDeadline = Date.now() + HUMAN_DECISION_RESPONSE_MS;
            const decision = await awaitHumanDecision(
              humanDecisionRequest(
                latest,
                opened.workspaceId,
                pm.id,
                requirement.id,
                run,
                humanEdges,
                responseDeadline,
                Number(run.budget?.deadlineAtMs ?? executionDeadline),
              ),
              responseDeadline,
            );
            const current = await requireProjectStatus(opened.client, opened.workspaceId);
            const currentRun = current.workflowRuns.find(
              (item) => item.controllerSessionId === pm.id,
            );
            if (!humanDecisionStillApplicable(run, currentRun, decision.edgeId)) {
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
      const throughputProfile = await collectThroughputProfile({
        t,
        opened,
        setupSession,
        setupStartedAt,
        setupFinishedAt,
        promptStartedAt,
        observedAt: Date.now(),
        requirements,
        sessions,
        terminalObservedAt,
        status: latest,
      });
      const throughputProfileText = JSON.stringify(throughputProfile);
      writeFileSync(
        path.join(path.dirname(t.env.logs), "pm-throughput-profile.json"),
        `${JSON.stringify(throughputProfile, null, 2)}\n`,
        "utf8",
      );
      const sessionTotals = Object.values(
        throughputProfile.sessions.reduce<
          Record<string, { role: string; sessions: number; activeMs: number; llmRounds: number; toolCalls: number }>
        >((totals, session) => {
          const current = totals[session.role] ?? {
            role: session.role,
            sessions: 0,
            activeMs: 0,
            llmRounds: 0,
            toolCalls: 0,
          };
          current.sessions += 1;
          current.activeMs += session.activeMs ?? 0;
          current.llmRounds += session.llmRounds ?? 0;
          current.toolCalls += session.toolCalls ?? 0;
          totals[session.role] = current;
          return totals;
        }, {}),
      );
      t.note(
        `pm-throughput-profile ${JSON.stringify({
          schema: throughputProfile.schema,
          artifact: "logs/lease/pm-throughput-profile.json",
          setupMs: throughputProfile.setupMs,
          observedRunMs: throughputProfile.observedRunMs,
          runs: throughputProfile.runs,
          sessionTotals,
        })}`,
      );
      t.assertions.assert(
        terminalObservedAt.size === requirements.length,
        `only ${terminalObservedAt.size}/${requirements.length} same-project Runs completed in ten minutes: ${JSON.stringify(
          latest.workflowRuns.map((run) => ({
            session: run.controllerSessionId,
            graph: run.graphId,
            status: run.status,
            remainingMs: run.budget?.remainingMs,
          })),
        )}; profile=${throughputProfileText}`,
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
        const activeElapsedMs = run?.budget
          ? (terminalObservedAt.get(requirement.id) ?? Number.POSITIVE_INFINITY) -
            run.budget.startedAtMs -
            run.budget.userWaitMs
          : Number.POSITIVE_INFINITY;
        t.assertions.assert(
          activeElapsedMs <= RUN_BUDGET_MS,
          `${requirement.id} exceeded ten minutes of active execution`,
        );
        const packages = latest.workPackages.filter(
          (item) => item.controllerSessionId === pm.id,
        );
        t.assertions.assert(packages.length > 0, `${requirement.id} created no WorkPackage`);
        const acceptedPackages = packages.filter((item) => item.status === "accepted");
        const expectedAccepted = requirement.id === "bugfix" ? 3 : 4;
        t.assertions.assert(
          acceptedPackages.length === expectedAccepted,
          `${requirement.id} accepted ${acceptedPackages.length}/${expectedAccepted} expected packages`,
        );
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
          t.assertions.assert(
            item.reviewSessionId !== item.workSessionId,
            `${requirement.id}/${item.id} was self-reviewed in its implementation Session`,
          );
          t.assertions.assert(
            Boolean(item.integratedCommit) && Boolean(item.integratedTree),
            `${requirement.id}/${item.id} lacks Coordinator baseline integration evidence`,
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
            if (sessionId === item.reviewSessionId) {
              const reviewSpace = latest.agentSpaces.find(
                (space) => space.workspaceId === snapshot.data.summary.workspaceId,
              );
              t.assertions.assert(
                reviewSpace?.role === "review",
                `${sessionId} did not run in an independent Review Space`,
              );
            }
          }
        }
      }

      t.assertions.assert(
        maxConcurrentBugfixPackages >= 2,
        `bugfix fanout was not observed concurrently; max=${maxConcurrentBugfixPackages}`,
      );
      for (const requirementId of ["greenfield", "feature"] as const) {
        const expectedConcurrency = 4;
        t.assertions.assert(
          (maxConcurrentPackages.get(requirementId) ?? 0) >= expectedConcurrency,
          `${requirementId} fanout was not observed concurrently; max=${maxConcurrentPackages.get(requirementId) ?? 0}`,
        );
      }
      assertConcurrentDeliverables(t, repositories, featureBaselineLines);
      const greenfieldLines = assertEffectiveProjectScaleBetween(
        t,
        repositories.greenfield,
        20_000,
        30_000,
        "greenfield delivery",
      );
      const featureDeliveredLines = effectiveProjectSourceLines(repositories.feature);
      t.note(
        `same-project-concurrency ${JSON.stringify({
          environments: 1,
          projectWorkspaceId: opened.workspaceId,
          pmSessions: requirements.length,
          maxConcurrentOwners,
          maxConcurrentSpaces,
          maxConcurrentBugfixPackages,
          maxConcurrentPackages: Object.fromEntries(maxConcurrentPackages),
          humanDecisions: decisionCount,
          elapsedMs: Date.now() - promptStartedAt,
          models: { pm: PM_MODEL, work: workModel },
          scale: {
            greenfieldEffectiveSourceLines: greenfieldLines,
            featureBaselineEffectiveSourceLines: featureBaselineLines,
            featureDeliveredEffectiveSourceLines: featureDeliveredLines,
            featureAddedEffectiveSourceLines: featureDeliveredLines - featureBaselineLines,
          },
          runs: requirements.map((requirement) => {
            const run = latest!.workflowRuns.find(
              (item) => item.controllerSessionId === sessions.get(requirement.id)!.id,
            );
            return {
              id: requirement.id,
              graph: run?.graphId,
              workSessions: run?.budget?.workSessionsStarted,
              llmRequestsObserved: run?.budget?.llmRequestsObserved,
              llmRequestsRemaining: run?.budget?.llmRequestsRemaining,
              userWaitMs: run?.budget?.userWaitMs,
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

function writeTopologyBootstrapScript(workspace: string): void {
  const script = path.join(
    workspace,
    "spaces",
    "pm",
    ".genethub",
    "topology-bootstrap.sh",
  );
  mkdirSync(path.dirname(script), { recursive: true });
  const spaces = TOPOLOGY_BINDINGS.flatMap((binding) => [
    binding.implementation,
    binding.review,
  ]);
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'project_root="$(git rev-parse --show-toplevel)"',
    'cd "$project_root"',
    'log="$project_root/spaces/pm/.genethub/topology-bootstrap.log"',
    ': > "$log"',
    'run_cli() {',
    '  "$GENEHUB_CLI" "$@" >>"$log" 2>&1 || {',
    '    code=$?',
    '    tail -200 "$log" >&2',
    '    exit "$code"',
    '  }',
    '}',
    'ensure_worktree() {',
    '  repo="$1"; branch="$2"; space="$3"',
    '  repository="$project_root/repositories/$repo"',
    '  target="$project_root/worktrees/$space/$repo"',
    '  if [ ! -d "$target" ]; then',
    '    git -C "$repository" show-ref --verify --quiet "refs/heads/$branch" || git -C "$repository" branch "$branch" main',
    '    mkdir -p "$(dirname "$target")"',
    '    git -C "$repository" worktree add "$target" "$branch" >>"$log" 2>&1',
    '  fi',
    '  test "$(git -C "$target" branch --show-current)" = "$branch"',
    '}',
    'register_space() {',
    '  name="$1"; role="$2"; tag="$3"; purpose="$4"',
    '  output="$("$GENEHUB_CLI" workspace register-agent-space "spaces/$name/$name.code-workspace")"',
    '  printf "%s\\n" "$output" >>"$log"',
    '  workspace_id="$(printf "%s\\n" "$output" | node -e \"let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{const l=s.trim().split(/\\n/u).filter(Boolean);const x=JSON.parse(l.at(-1));const id=x.data?.workspace?.id;if(!id)process.exit(2);process.stdout.write(id)})\")"',
    '  run_cli pm project space record --name "$name" --purpose "$purpose" --path "spaces/$name" --workspace "$workspace_id" --commit "$commit" --role "$role" --tag "$tag"',
    '}',
    'run_cli pm project advance --to preflight-passed',
    'run_cli pm project advance --to git-ready',
  ];

  for (const binding of TOPOLOGY_BINDINGS) {
    lines.push(
      `ensure_worktree ${shellLiteral(binding.repository)} ${shellLiteral(binding.branch)} ${shellLiteral(binding.implementation)}`,
    );
  }
  for (const space of spaces) lines.push(`run_cli agent-space init ${shellLiteral(space)}`);
  for (const binding of TOPOLOGY_BINDINGS) {
    const workspaceFile = `${JSON.stringify(
      {
        folders: [
          { name: binding.implementation, path: "." },
          {
            name: binding.repository,
            path: `../../worktrees/${binding.implementation}/${binding.repository}`,
          },
        ],
      },
      null,
      2,
    )}\n`;
    for (const space of [binding.implementation, binding.review]) {
      lines.push(
        `printf '%s' ${shellLiteral(workspaceFile)} > ${shellLiteral(`spaces/${space}/${space}.code-workspace`)}`,
      );
    }
  }
  lines.push(
    "while IFS= read -r entry; do",
    '  grep -qxF "$entry" .gitignore || printf "%s\\n" "$entry" >> .gitignore',
    "done <<'GENEHUB_IGNORE'",
    "spaces/*/.pipebuilder/",
    "spaces/*/.agents/",
    "spaces/*/.claude/",
    "spaces/*/.codebuddy/",
    "spaces/*/.cursor/",
    "spaces/*/AGENTS.md",
    "GENEHUB_IGNORE",
    `for space in ${spaces.map(shellLiteral).join(" ")}; do`,
    '  run_cli agent-space check "$space"',
    '  run_cli agent-space build "$space" --dry-run --require-no-post-commands',
    '  run_cli agent-space build "$space" --require-no-post-commands',
    '  run_cli agent-space verify "$space"',
    "done",
    "git add .gitignore spaces",
    'git diff --cached --quiet || git commit -m "Prepare concurrent PM AgentSpace pool" >>"$log" 2>&1',
    'test -z "$(git status --porcelain)"',
    'commit="$(git rev-parse HEAD)"',
    'run_cli pm project advance --to topology-verified',
  );
  for (const binding of TOPOLOGY_BINDINGS) {
    lines.push(
      `register_space ${shellLiteral(binding.implementation)} implementation ${shellLiteral(binding.capability)} ${shellLiteral(`Implementation capacity for ${binding.capability}`)}`,
      `register_space ${shellLiteral(binding.review)} review ${shellLiteral(binding.capability)} ${shellLiteral(`Independent review capacity for ${binding.capability}`)}`,
    );
  }
  lines.push(
    'run_cli pm project advance --to workspaces-registered',
    'run_cli pm project advance --to active',
    `echo "shared-topology-ready commit=$commit spaces=${TOPOLOGY_BINDINGS.length * 2}"`,
  );
  writeFileSync(script, `${lines.join("\n")}\n`, { mode: 0o700 });
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function prepareSharedTopology(
  t: CaseContext,
  opened: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>,
): Promise<SessionSummary> {
  const setup = await createPmSession(t, opened, "并发验收拓扑准备");
  const events = await t.flows.main.attachEventLog(opened.client, setup.id);
  writeTopologyBootstrapScript(t.env.workspace);
  await t.flows.main.sendPrompt(
    opened.client,
    setup.id,
    `这是确定性的共享 AgentSpace 池准备，不是需求分析或执行工作。直接运行一次 \`bash .genethub/topology-bootstrap.sh\`，不要读取 Skill、目录、业务源码或脚本内容，不要调用 help/schema，不要改写脚本，也不要选择 Workflow 或创建 WorkPackage。脚本成功后只报告最后一行并立即结束本回合。`,
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
      implementations.length >= TOPOLOGY_BINDINGS.length &&
      reviews.length >= TOPOLOGY_BINDINGS.length &&
      snapshot?.type === "snapshot" &&
      snapshot.data.summary.status === "idle"
    ) {
      t.assertions.assert(
        status.workflowRuns.find((run) => run.controllerSessionId === setup.id)?.status ===
          "discussion",
        "topology setup consumed a delivery Workflow Run",
      );
      assertPreboundTopology(t, status);
      return setup;
    }
    await sleep(1_000);
  }
  throw new Error("shared same-project AgentSpace topology was not ready within three minutes");
}

type ProductClient = Awaited<
  ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>
>["client"];

interface ThroughputProfileInput {
  t: CaseContext;
  opened: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
  setupSession: SessionSummary;
  setupStartedAt: number;
  setupFinishedAt: number;
  promptStartedAt: number;
  observedAt: number;
  requirements: ConcurrentRequirement[];
  sessions: Map<string, SessionSummary>;
  terminalObservedAt: Map<string, number>;
  status: PmProjectStatus;
}

async function collectThroughputProfile(input: ThroughputProfileInput) {
  const sessionSpecs = new Map<
    string,
    { task: string; role: "setup" | "pm" | "implementation" | "review"; agentSpace?: string }
  >();
  sessionSpecs.set(input.setupSession.id, { task: "setup", role: "setup" });
  for (const requirement of input.requirements) {
    const pm = input.sessions.get(requirement.id);
    if (pm) sessionSpecs.set(pm.id, { task: requirement.id, role: "pm" });
    for (const item of input.status.workPackages.filter(
      (candidate) => candidate.controllerSessionId === pm?.id,
    )) {
      if (item.workSessionId) {
        sessionSpecs.set(item.workSessionId, {
          task: requirement.id,
          role: "implementation",
          agentSpace: item.agentSpace,
        });
      }
      if (item.reviewSessionId) {
        sessionSpecs.set(item.reviewSessionId, {
          task: requirement.id,
          role: "review",
        });
      }
    }
  }

  const profiles = [];
  for (const [sessionId, spec] of sessionSpecs) {
    profiles.push(await profileSession(input.opened.client, input.status, sessionId, spec));
  }

  return {
    schema: "genehub.pm-throughput-profile.v1",
    setupMs: input.setupFinishedAt - input.setupStartedAt,
    observedRunMs: input.observedAt - input.promptStartedAt,
    runs: input.requirements.map((requirement) => {
      const sessionId = input.sessions.get(requirement.id)?.id;
      const run = input.status.workflowRuns.find(
        (candidate) => candidate.controllerSessionId === sessionId,
      );
      return {
        id: requirement.id,
        status: run?.status,
        terminalMs: input.terminalObservedAt.has(requirement.id)
          ? input.terminalObservedAt.get(requirement.id)! - input.promptStartedAt
          : undefined,
        remainingMs: run?.budget?.remainingMs,
        workSessions: run?.budget?.workSessionsStarted,
        llmRequestsObserved: run?.budget?.llmRequestsObserved,
        llmRequestsRemaining: run?.budget?.llmRequestsRemaining,
        userWaitMs: run?.budget?.userWaitMs,
        wakeDispatches: run?.supervisor.wakeDispatchCount,
        wakeFailures: run?.supervisor.wakeFailedCount,
        coalescedEvents: run?.supervisor.coalescedEventCount,
      };
    }),
    sessions: profiles,
  };
}

async function profileSession(
  client: ProductClient,
  status: PmProjectStatus,
  sessionId: string,
  spec: { task: string; role: "setup" | "pm" | "implementation" | "review"; agentSpace?: string },
) {
  const response = await client.call({ type: "session.get", payload: { sessionId } });
  if (response?.type !== "snapshot") {
    return { id: sessionId, task: spec.task, role: spec.role, error: response?.type ?? "missing" };
  }
  const turns = response.data.items
    .filter((item) => item.type === "turnSummary")
    .map((item) => (item.type === "turnSummary" ? item.stats : undefined))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const firstAt = turns.length > 0 ? Math.min(...turns.map((turn) => turn.startedAtMs)) : undefined;
  const lastAt = turns.length > 0 ? Math.max(...turns.map((turn) => turn.finishedAtMs)) : undefined;
  const ttft = turns
    .map((turn) => turn.usage.avgTtftMs)
    .filter((value): value is number => value !== undefined);
  const workspaceName =
    spec.role === "setup" || spec.role === "pm"
      ? "pm"
      : spec.agentSpace ??
        status.agentSpaces.find((space) => space.workspaceId === response.data.summary.workspaceId)
          ?.name ??
        response.data.summary.workspaceId;
  return {
    id: sessionId,
    task: spec.task,
    role: spec.role,
    model: response.data.summary.modelId,
    status: response.data.summary.status,
    store: `spaces/${workspaceName}/.genethub/sessions/${sessionId}`,
    turns: turns.length,
    activeMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
    firstAt,
    lastAt,
    llmRounds: turns.reduce((sum, turn) => sum + turn.usage.llmRounds, 0),
    toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
    inputTokens: turns.reduce((sum, turn) => sum + turn.usage.inputTokens, 0),
    outputTokens: turns.reduce((sum, turn) => sum + turn.usage.outputTokens, 0),
    avgTtftMs:
      ttft.length > 0 ? Math.round(ttft.reduce((sum, value) => sum + value, 0) / ttft.length) : undefined,
  };
}

function assertPreboundTopology(
  t: CaseContext,
  status: PmProjectStatus,
): void {
  for (const binding of TOPOLOGY_BINDINGS) {
    const worktree = path.join(
      t.env.workspace,
      "worktrees",
      binding.implementation,
      binding.repository,
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
          folders[1] === `../../worktrees/${binding.implementation}/${binding.repository}`,
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

function concurrentRequirements(
  topology: PmProjectStatus,
  workModel: string,
): ConcurrentRequirement[] {
  const workspaceId = (name: string): string => {
    const space = topology.agentSpaces.find((candidate) => candidate.name === name);
    if (!space) throw new Error(`shared topology is missing Agent Space ${name}`);
    return space.workspaceId;
  };
  const common = `这是同一项目内三个并行需求之一。项目初始化和共享拓扑已完成且 phase=active；不要再次执行 pm project init/advance/lifecycle，不要重新注册、重建或记录既有 Space。只管理当前 PM Session 的 Intent、Run、TeamSlot 和 WorkPackage；不得读取、推进、取消或复用其他 PM Session 的包。十分钟主动执行预算与请求预算不可延长。用户已给出最终验收、包划分、分支、AgentSpace workspace id、Agent 与模型；这些信息是完整且可信的派工合同。按系统规则各读取必要 PM Skill 一次后直接派工；除此之外不要调用 agent list、help/schema、ls/find/grep/read，也不要读取产品源码、目录或其他 Session 状态。

PM 只做目标、团队和预算管理：不得读取或修改 repositories/、worktrees/ 中的代码，不运行项目测试，不执行技术评审，不生成 verdict，也不执行 Git 集成。实现与自测由 implementation WorkAgent 完成；候选由另一个 review Space 中的独立 Reviewer 复验。Candidate 出现后，PM 必须按 Supervisor 给出的 \`action=dispatch-independent-review\` 与 \`reviewWorkspace\`，使用**原 WorkPackage id**启动 Reviewer WorkSession；不得新建 Review WorkPackage，也不得因为 Workflow 的 \`review.actor=system\` 就等待 Coordinator 创建 Reviewer。这里的 system 只负责验证 Reviewer 结果、推导事实和推进图。切片 Reviewer 只能因绑定候选自身造成的验收缺陷或明确的集成 seam 判失败：必须拒绝候选中依赖兄弟切片暂缺才成立的偶然绿色断言，但不得仅因责任兄弟包尚未合入、导致最终组合门禁暂时不可观测，就把当前切片判失败或要求它修改责任外路径；本包边界用 fixture/动态探针复验，完整 npm test/build 由合流后系统门禁负责。每份 Reviewer 合同都要求在约 6-12 次 LLM 请求内完成，最多三组只读合并命令：第一组一次取得 HEAD/tree/status/diff/行数等身份与范围证据，第二组一次执行全部定向测试和 build，必要时第三组只补一个失败点；不得逐文件通读确定性生成的同构模块。Reviewer 必须保持候选 worktree 只读：不得 checkout/revert/reset，不得复制候选后通过回退文件反演 baseline，不得写入或清理候选；若命令修改 tracked 文件或留下非忽略文件，必须 review-fail。该约束只提高取证效率，不允许 Reviewer 省略独立命令或让 PM 代评。Worker/Reviewer 末尾的结构化结果由 Coordinator 读取，Coordinator 自行推导 commit/tree、推进 Candidate/Accepted 并在 system integrate 节点串行合入 main。每份 Worker/Reviewer 合同都必须保留系统结果协议：最后一个非空行是唯一的 \`GENEHUB_WORK_RESULT {...}\`，其后不能有文字；实现只允许 status=\`candidate-ready\` 或 \`blocked\`；review-pass 必须使用最小对象 \`{"status":"review-pass","summary":"all bound-candidate gates passed"}\` 且不带 findings，review-fail 必须使用 \`{"status":"review-fail","summary":"acceptance defects remain","findings":[{"severity":"blocking|high|medium|low","title":"...","acceptanceImpact":"...","recommendedAction":"...","estimatedRequests":1}]}\`，findings 只能是对象数组，recommendedAction 必须位于每个 finding 内。\`candidate\` 和 \`failed\` 不是协议值。禁止用“首行 review-pass”或自定义 RESULT 取代它。Reviewer 标记缺失或格式错误时由 Coordinator 自动且仅修复一次；PM 不得续发协议修复、不得自己合成 verdict。PM 在 review-fail 时只依据验收影响、Reviewer 的预计请求数和本 Run 剩余预算选择有界返工或升级用户，不得覆盖 Reviewer verdict。

每个 package put 必须使用消息中给出的完整 argv（包括 --id/--title/--outcome/--repository/--branch/--node/--space-tag）；不得省略字段或重复 implementation 等节点基础标签。Coordinator 返回的 worktree 已由用户创建并在实现/评审 Workspace 中精确注册；不要再建 worktree。只用 OpenCode + ${workModel}，PM 保持 ali/qwen3.8-flash medium。把消息列出的全部命令按顺序放在同一次内置 genehub 批量工具调用中；不要改用 bash。一个 fanout 必须先执行全部 package put，再执行全部 Ready，最后执行全部 agent run；禁止 put A → Ready A → run A → put B，因为第一个 Ready 会封闭 cohort。\`agent run\` 已带 --no-wait，成功返回时 Coordinator 会原子绑定 WorkSession，禁止再手工绑定或伪造状态。派发完立即结束回合，等待 Supervisor 批量唤醒；不要轮询运行中 Session。候选出现后只派发独立 Reviewer；review-pass 后等待 Coordinator 自动接受与集成。`;

  const greenfieldContentContract = `只实现 greenfield 的内容资产包。你独占 src/content/catalog.js、src/content/modules/**、src/content/registry.js；不得修改 scripts/generate-content.mjs、tests/content.test.js、index.html、package.json、src/main.js、src/core/**、scripts/build.mjs 或其他测试。项目已经提供冻结的确定性内容编译器和验收 Oracle，不得重新实现、复制或调试生成器。最多做一次环境检查，随后第一个写操作直接完成 catalog.js：导出 Object.freeze 的 contentCatalog，恰好 126 个具有实际玩法含义的对象，分类严格为 24 tower、24 enemy、18 wave、18 ammo、18 skill、12 effect、12 level；每项必须有唯一 kebab-case id、name、role、element、正整数 basePower、非负整数 baseCost、至少 50 的整数 cadenceMs，以及至少两个有意义 tags。允许用七个明确分组、名称数组和纯映射生成目录，但不得使用 Tower-01、Item-02 等占位名称。目录完成后运行一次 node scripts/generate-content.mjs；冻结编译器会生成并静态注册 126 个签入项目的生产模块，每个模块含 126 级实际 progression 数据和 entry/evaluate/scale/schedule/serialize/validate，规模由冻结 Oracle 验证。若编译器报告目录字段错误，只修 catalog.js 后重跑，不得修改工具或测试。随后运行 node --test tests/content.test.js、npm test、npm run build，提交包含 catalog、modules 和 registry 的干净候选。本包 Reviewer 只复验内容切片自身的目录、生产模块、registry 和冻结内容 Oracle；因 shell 兄弟包尚未合入而导致当前 dist 不含 src/**，不是内容候选的缺陷，不得因此 review-fail 或要求修改 scripts/build.mjs；动态构建边界由 shell Reviewer 用未知深层模块探针复验，真实内容产物在合流后全量 npm test/build 中验证。目标是派发后四分钟内、约 4-8 次 LLM 请求形成候选，不写设计长文。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const greenfieldRulesContract = `只实现 greenfield 的确定性规则包。你独占 src/core/rules.js、tests/core-rules.test.js；不得修改 src/core/engine.js、src/core/index.js、index.html、package.json、src/main.js、src/content/**、scripts/** 或其他测试。严格保留 baseline 已声明的 RULES、normalizeSeed、createWave、upgradeCost、waveReward 六个导出，不新增平衡设计：RULES 的 startCredits=1200、startIntegrity=100、baseEnemyHp=40、baseEnemyDamage=8、baseReward=35、upgradeBaseCost=100、upgradeCostStep=50、maxUpgrades=8、enemiesPerWave=6；createWave(index, seed) 必须生成恰好 6+index 个确定性敌人，敌人 id/hp/damage/reward 只由 index、seed、序号和上述常量推导；upgradeCost(level)=100+50*level；waveReward(index)=35*(index+1)。测试逐项断言上述常量、同 seed 相等、异 seed 不等、非法输入归一化和边界；不得用重复、占位或无语义分支凑行，本包总有效增量不超过 700 行。最多一次合并环境检查，随后直接实现，不得临场调参、扩展玩法或等待其他包；运行 node --test tests/core-rules.test.js、npm test、npm run build并提交干净候选。目标是派发后三分钟内、约 8-12 次 LLM 请求内形成候选。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const greenfieldEngineContract = `只实现 greenfield 的确定性状态引擎包。你独占 src/core/engine.js、src/core/index.js、tests/core-engine.test.js；不得修改 src/core/rules.js、index.html、package.json、src/main.js、src/content/**、scripts/** 或其他测试。消费 baseline 已固定的 RULES/createWave/upgradeCost/waveReward 契约；保留并实现 createGameState、applyDamage、defeatEnemy、purchaseUpgrade、settleWave、advanceGame 六个导出及 index.js 的静态汇总。状态形状固定为 wave/credits/integrity/upgrades/activeWave/defeated/status；createGameState 使用 RULES 初值且 activeWave 必须深度等于 createWave(0, seed)；所有操作返回新对象，不修改输入；purchaseUpgrade 只按 upgradeCost 扣款并在 maxUpgrades 边界拒绝；settleWave 只按 waveReward 结算；advanceGame 只负责令 wave 加一并把 activeWave 设为 createWave(nextWave, seed)，不得自行生成、清空、过滤或调平衡敌人。Node 测试必须用 deepEqual 精确断言 createGameState(seed).activeWave === createWave(0, seed) 与 advanceGame(state, seed).activeWave === createWave(state.wave + 1, seed)，禁止断言 enemies 为空或固定其内容；并覆盖其余状态转移、不可变性、余额/生命/升级边界。不得用重复、占位或无语义分支凑行，本包总有效增量不超过 700 行。最多一次合并环境检查，随后直接实现，不得临场调平衡、扩展玩法或等待规则/内容/壳层包；运行 node --test tests/core-engine.test.js、npm test、npm run build并提交干净候选。目标是派发后三分钟内、约 8-12 次 LLM 请求内形成候选。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const greenfieldShellContract = `只实现 greenfield 的 H5 壳层与构建包。你独占 index.html、src/main.js、src/ui.css、scripts/build.mjs；不得修改 package.json、src/core/**、src/content/**、scripts/generate-content.mjs 或 tests/**。tests/ui-build.test.js 是用户冻结的跨包验收 Oracle，只能运行，不能改写、复制或弱化。main.js 只消费 baseline 已声明的 contentEntries、summarizeContent 与 core 公共导出，提供可运行的 HUD/控制器 DOM 入口和纯函数渲染模型；样式必须集中在 src/ui.css，由 index.html 引用且由 build 复制到 dist/src/ui.css。build 必须每次从干净 dist 开始，动态发现并逐字节复制完整 src/** 树以及 index.html；并行 content 包稍后会新增大量 src/content/modules/** 文件，因此禁止把当前 baseline 的文件名硬编码成固定资产清单。冻结 Oracle 会临时创建一个与内容目录隔离的未知深层源模块，并在 finally 中清理，以证明未来并行包的源文件不会从 dist 丢失，且不干扰内容模块的并发遍历 Oracle。独立 Reviewer 合同必须明确核对 tests/** 未被候选修改、运行冻结 Oracle，并把固定资产清单或遗漏动态探针视为 blocking finding；不得只因当前 baseline 的 npm test/build 退出 0 就判通过。不得用重复、占位或无语义分支凑行，本包总有效增量不超过 700 行。最多一次合并环境检查，随后直接写入、运行 node --test tests/ui-build.test.js、npm test、npm run build并提交干净候选；不得扫描、等待或读取其他包。目标是派发后四分钟内、约 12-18 次 LLM 请求内形成候选。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const featureLevelsContract = `只实现 expedition level 内容包。你独占 src/features/expedition/content/levels/**、src/features/expedition/content/levels-registry.js、scripts/generate-expedition-levels.mjs、tests/expedition-levels.test.js；不得修改 rewards/**、rewards-registry.js、根 registry、baseline、src/main.js、src/features/expedition/index.js、core/** 或其他测试。输出结构已决定：恰好生成 levels/level-000.js..level-023.js 共 24 个生产模块，id=expedition-level-000..023、kind=level；序号 index 的 season=1+floor(index/16)，week=1+(index mod 16)，seasonKey=2026-S<season>-W<两位 week>。每个模块导出 entry/evaluate/serialize/validate；entry 只有 id/kind/seasonKey/records，records 恰好 96 个逐行 Object.freeze 记录，固定字段 slot/difficulty/reward/seed。第一个写操作创建不超过 140 个有效行的单通道 Node 生成器；直接用字符串行数组与 JSON.stringify(record) 组装模块，禁止嵌套模板和自改生成器，立即只运行一次。levels-registry 静态导入全部 24 个 entry 并导出 expeditionLevelEntries。每模块 105-125 个有效行，本包生产模块 2,500-3,200 行；遍历测试断言数量、唯一 id、kind、seasonKey、96 records、四个导出行为和总行数。最多一次合并环境检查，生成后只做一次聚合检查；运行 node --test tests/expedition-levels.test.js、npm test、npm run build并提交干净候选。候选截止派发后四分钟、约 8-14 次 LLM 请求；若生成器或聚合检查失败，不重复改模板，应在剩余合同内直接修正唯一错误。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const featureRewardsContract = `只实现 expedition reward 内容包。你独占 src/features/expedition/content/rewards/**、src/features/expedition/content/rewards-registry.js、scripts/generate-expedition-rewards.mjs、tests/expedition-rewards.test.js；不得修改 levels/**、levels-registry.js、根 registry、baseline、src/main.js、src/features/expedition/index.js、core/** 或其他测试。输出结构已决定：恰好生成 rewards/reward-024.js..reward-047.js 共 24 个生产模块，id=expedition-reward-024..047、kind=reward；序号 index 使用 24..47，season=1+floor(index/16)，week=1+(index mod 16)，seasonKey=2026-S<season>-W<两位 week>。每个模块导出 entry/evaluate/serialize/validate；entry 只有 id/kind/seasonKey/records，records 恰好 96 个逐行 Object.freeze 记录，固定字段 slot/difficulty/reward/seed。第一个写操作创建不超过 140 个有效行的单通道 Node 生成器；直接用字符串行数组与 JSON.stringify(record) 组装模块，禁止嵌套模板和自改生成器，立即只运行一次。rewards-registry 静态导入全部 24 个 entry 并导出 expeditionRewardEntries。每模块 105-125 个有效行，本包生产模块 2,500-3,200 行；遍历测试断言数量、唯一 id、kind、seasonKey、96 records、四个导出行为和总行数。最多一次合并环境检查，生成后只做一次聚合检查；运行 node --test tests/expedition-rewards.test.js、npm test、npm run build并提交干净候选。候选截止派发后四分钟、约 8-14 次 LLM 请求；若生成器或聚合检查失败，不重复改模板，应在剩余合同内直接修正唯一错误。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const featureRulesContract = `只实现 expedition 确定性规则包。你独占 src/features/expedition/core/season.js、src/features/expedition/core/levels.js、src/features/expedition/core/rewards.js、tests/expedition-rules.test.js；不得修改 core/index.js、progress.js、errors.js、baseline、src/main.js、expedition/index.js、content/**、registry.js 或其他测试。保持 baseline 固定导出，实现 UTC season seed，以及 baseline 已预声明的 seasonIdentity(date)：以 2026-01-01 UTC 为 index=0 锚点，按完整 UTC 周计算非负整数 index，再严格推导 season=1+Math.floor(index/16)、week=1+(index%16)、seasonKey=2026-S<season>-W<两位 week>；同一时刻的不同时区表达必须得到相同结果，测试覆盖 index=0、15、16、23、47 和非法/锚点前输入。另实现可注入关卡集合的确定性选择、奖励计算与输入边界；所有规则语义测试必须注入本文件 fixture。空集合 fixture 必须显式传入 []；省略第二参数或显式传入 undefined 都会按 JavaScript 默认参数语义使用 live registry，严禁把它们伪装成空注入并断言 null，Reviewer 看到此类断言必须 review-fail，因为兄弟内容包合入后结果会改变。不得断言 live expeditionLevels 永久为空、长度为 0，或默认 selectExpeditionLevel 永久返回 null；对 live registry 只能断言为空时返回 null、非空时返回其中的成员，且不得与并行内容包的临时未合入状态绑定。测试覆盖确定性、时区和无效输入；不得用重复、占位或无语义分支凑行，本包总有效增量不超过 1,000 行。最多一次合并环境检查，随后直接实现、运行 node --test tests/expedition-rules.test.js、npm test、npm run build并提交干净候选；不得等待内容/进度包。目标是派发后四分钟内、约 12-18 次 LLM 请求内形成候选。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  const featureProgressContract = `只实现 expedition 进度持久化包。你独占 src/features/expedition/core/progress.js、src/features/expedition/core/errors.js、tests/expedition-progress.test.js；不得修改 core/index.js、season.js、levels.js、rewards.js、baseline、src/main.js、expedition/index.js、content/**、registry.js 或其他测试。保持 baseline 固定导出，实现版本化进度序列化/恢复、默认值归一化、损坏输入错误与边界校验；不得用重复、占位或无语义分支凑行，本包总有效增量不超过 1,000 行。最多一次合并环境检查，随后直接实现、运行 node --test tests/expedition-progress.test.js、npm test、npm run build并提交干净候选；不得等待规则/内容包。目标是派发后四分钟内、约 12-18 次 LLM 请求内形成候选。最后一个非空行必须是且只能是 GENEHUB_WORK_RESULT {"status":"candidate-ready","summary":"..."}；若确实无法完成则 status=blocked。`;
  return [
    {
      id: "greenfield",
      title: "并行需求：新建 20–30k 行 H5 项目",
      graph: "feature",
      prompt: `${common}

选择 feature。Intent 是在 repositories/greenfield 从最小骨架交付一个可运行、可测试、可构建的 H5 星港防御项目；最终有效项目源 20,000-30,000 行。必须用同一次 genehub 批量调用执行以下语义完全相同的 argv 顺序：workflow select feature；intent set（验收含 20-30k、生产 registry 可达、npm test/build）；workflow transition aligned + intent.aligned；workflow transition planned + plan.ready；然后严格按三阶段派发四个 disjoint WorkPackage：

阶段 A（全部 Planned put，期间绝不 Ready/Run）：
1. package put --id greenfield-content --title "星港防御生产内容与 registry" --outcome "126 个 registry 可达的统一内容模块、遍历测试和 20k 规模主体，干净候选" --repository greenfield --branch work/greenfield-content --node implement --space-tag greenfield-content
2. package put --id greenfield-rules --title "星港防御确定性规则" --outcome "固定规则常量、seed 波次、升级/奖励计算、规则测试和干净候选" --repository greenfield --branch work/greenfield-rules --node implement --space-tag greenfield-rules
3. package put --id greenfield-engine --title "星港防御确定性状态引擎" --outcome "状态、战斗、资源升级、结算测试和干净候选" --repository greenfield --branch work/greenfield-engine --node implement --space-tag greenfield-engine
4. package put --id greenfield-shell --title "星港防御 H5 壳层与构建" --outcome "可运行入口、HUD、src/ui.css、构建产物、壳层测试和干净候选" --repository greenfield --branch work/greenfield-shell --node implement --space-tag greenfield-shell
阶段 B（四个 put 均成功后）：package transition --id greenfield-content --to ready；package transition --id greenfield-rules --to ready；package transition --id greenfield-engine --to ready；package transition --id greenfield-shell --to ready。
阶段 C（四个 Ready 均成功后）：
1. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("greenfield-content")} --work-package greenfield-content --no-wait，合同逐字采用：${greenfieldContentContract}
2. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("greenfield-rules")} --work-package greenfield-rules --no-wait，合同逐字采用：${greenfieldRulesContract}
3. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("greenfield-engine")} --work-package greenfield-engine --no-wait，合同逐字采用：${greenfieldEngineContract}
4. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("greenfield-shell")} --work-package greenfield-shell --no-wait，合同逐字采用：${greenfieldShellContract}

四个实现必须同时 Running，四个独立 Reviewer 分别复验精确候选；Coordinator 串行集成后再由系统验证总行数、生产可达性、npm test/build。`,
    },
    {
      id: "feature",
      title: "并行需求：在 20–30k 基线上增加 5–10k 行特性",
      graph: "feature",
      prompt: `${common}

选择 feature。Intent 是在已有 20,000-30,000 行 repositories/feature-app 上新增 5,000-10,000 行完整远征赛季模块，不能删除或改写 baseline sectors。必须用同一次 genehub 批量调用执行：workflow select feature；intent set（验收含增量规模、生产可达、UTC season/week/seasonKey、奖励/进度、npm test/build）；aligned；planned；然后严格按三阶段派发：

阶段 A（全部 Planned put，期间绝不 Ready/Run）：
1. package put --id expedition-levels --title "远征赛季关卡内容" --outcome "24 个 registry 可达 level 模块、遍历测试和 2.5k-3.2k 干净候选" --repository feature-app --branch work/expedition-levels --node implement --space-tag expedition-levels
2. package put --id expedition-rewards --title "远征赛季奖励内容" --outcome "24 个 registry 可达 reward 模块、遍历测试和 2.5k-3.2k 干净候选" --repository feature-app --branch work/expedition-rewards --node implement --space-tag expedition-rewards
3. package put --id expedition-rules --title "远征赛季确定性规则" --outcome "UTC seed 与 season/week/seasonKey、关卡选择、奖励计算、边界测试和干净候选" --repository feature-app --branch work/expedition-rules --node implement --space-tag expedition-rules
4. package put --id expedition-progress --title "远征赛季进度持久化" --outcome "版本化序列化/恢复、损坏输入处理、边界测试和干净候选" --repository feature-app --branch work/expedition-progress --node implement --space-tag expedition-progress
阶段 B（四个 put 均成功后）：package transition --id expedition-levels --to ready；package transition --id expedition-rewards --to ready；package transition --id expedition-rules --to ready；package transition --id expedition-progress --to ready。
阶段 C（四个 Ready 均成功后）：
1. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("feature-content")} --work-package expedition-levels --no-wait，合同逐字采用：${featureLevelsContract}
2. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("feature-rewards")} --work-package expedition-rewards --no-wait，合同逐字采用：${featureRewardsContract}
3. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("feature-rules")} --work-package expedition-rules --no-wait，合同逐字采用：${featureRulesContract}
4. agent run --agent ${WORK_AGENT} --model ${workModel} --workspace ${workspaceId("feature-progress")} --work-package expedition-progress --no-wait，合同逐字采用：${featureProgressContract}

四个实现必须同时 Running，四个 Reviewer 独立复验；Coordinator 集成后总增量须为 5k-10k 且 npm test/build 通过。`,
    },
    {
      id: "bugfix",
      title: "并行需求：三个独立 Bug 并发修复",
      graph: "bugfix",
      prompt: `${common}

必须用同一次 genehub 批量调用执行：workflow select bugfix；intent set（验收含三个缺陷各自定向测试、独立 Reviewer、main 上 npm test、至少两个实现 WorkSession 同时 Running，首次 Intent 不传 --affects）；然后在 fix 节点严格按三阶段派发三个包：
阶段 A（先完成全部 Planned put，期间绝不 Ready/Run）：
1. package put --id fix-auth-expiry --title "修复毫秒 expiry 比较" --outcome "复现、回归测试及 src/auth.js 单位修复的干净候选" --repository bugfix-app --branch work/bugfix-auth --node fix --space-tag auth；workspace=${workspaceId("bugfix-auth")}；只改 src/auth.js 与 tests/auth.test.js，运行 npm run test:auth；
2. package put --id fix-inventory-merge --title "修复库存重复合并" --outcome "有限 quantity 正确累加及回归测试的干净候选" --repository bugfix-app --branch work/bugfix-inventory --node fix --space-tag inventory；workspace=${workspaceId("bugfix-inventory")}；只改 src/inventory.js 与 tests/inventory.test.js，运行 npm run test:inventory；
3. package put --id fix-ranking-ties --title "修复同分排序" --outcome "createdAt 升序再 id 排序及回归测试的干净候选" --repository bugfix-app --branch work/bugfix-ranking --node fix --space-tag ranking；workspace=${workspaceId("bugfix-ranking")}；只改 src/ranking.js 与 tests/ranking.test.js，运行 npm run test:ranking。
阶段 B（全部三个 put 成功后）：依次把 fix-auth-expiry、fix-inventory-merge、fix-ranking-ties transition ready。
阶段 C（全部三个 Ready 后）：依次 agent run --agent ${WORK_AGENT} --model ${workModel} --workspace 上述 id --work-package 对应包 --no-wait；合同要求最多一次环境检查、直接复现修复测试提交，最后一个非空行严格为 candidate-ready GENEHUB_WORK_RESULT。三个独立 Reviewer 通过且 Coordinator 串行集成后，main 上 npm test 必须整体通过。必须观察到至少两个实现 WorkSession 同时 Running。`,
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
          ...(item.reviewFindings ? { reviewFindings: item.reviewFindings } : {}),
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

function seedConcurrentProjects(workspace: string): ConcurrentRepositories {
  mkdirSync(path.join(workspace, "repositories"), { recursive: true });
  mkdirSync(path.join(workspace, "worktrees"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".gitignore"),
    ".genethub/\nrepositories/\nworktrees/\n",
  );
  gitInit(workspace);
  git(workspace, ["add", ".gitignore"]);
  git(workspace, ["commit", "-qm", "Seed concurrent PM project"]);

  const greenfield = path.join(workspace, "repositories", "greenfield");
  mkdirSync(path.join(greenfield, "src", "content"), { recursive: true });
  mkdirSync(path.join(greenfield, "src", "core"), { recursive: true });
  mkdirSync(path.join(greenfield, "scripts"), { recursive: true });
  mkdirSync(path.join(greenfield, "tests"), { recursive: true });
  writeFileSync(
    path.join(greenfield, "package.json"),
    `${JSON.stringify({
      name: "greenfield-starport",
      private: true,
      type: "module",
      scripts: { test: "node --test", build: "node scripts/build.mjs" },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(greenfield, "index.html"),
    "<!doctype html><meta charset=\"utf-8\"><title>Starport Defense</title><main id=\"app\"></main><script type=\"module\" src=\"./src/main.js\"></script>\n",
  );
  writeFileSync(
    path.join(greenfield, "src", "content", "registry.js"),
    "export const CONTENT_CATEGORIES = Object.freeze(['tower', 'enemy', 'wave', 'ammo', 'skill', 'effect', 'level']);\nconst categorySet = new Set(CONTENT_CATEGORIES);\nexport const contentEntries = Object.freeze([]);\nexport function summarizeContent(entries = contentEntries) {\n  const counts = {};\n  for (const entry of entries) {\n    const category = typeof entry?.category === 'string' && categorySet.has(entry.category) ? entry.category : 'unknown';\n    counts[category] = (counts[category] ?? 0) + 1;\n  }\n  return counts;\n}\n",
  );
  writeFileSync(
    path.join(greenfield, "src", "content", "catalog.js"),
    "export const contentCatalog = Object.freeze([]);\n",
  );
  writeFileSync(
    path.join(greenfield, "src", "core", "index.js"),
    "export { createGameState, applyDamage, defeatEnemy, purchaseUpgrade, settleWave, advanceGame } from './engine.js';\nexport { RULES, normalizeSeed, createWave, upgradeCost, waveReward } from './rules.js';\n",
  );
  writeFileSync(
    path.join(greenfield, "src", "core", "engine.js"),
    "import { RULES, createWave, upgradeCost, waveReward } from './rules.js';\nexport function createGameState(seed = 1) { return { wave: 0, credits: RULES.startCredits, integrity: RULES.startIntegrity, upgrades: [], activeWave: createWave(0, seed), defeated: 0, status: 'playing' }; }\nexport function applyDamage(state, damage = 0) { return { ...state, integrity: Math.max(0, state.integrity - Math.max(0, damage)) }; }\nexport function defeatEnemy(state) { return { ...state, defeated: state.defeated + 1 }; }\nexport function purchaseUpgrade(state) { return state; }\nexport function settleWave(state) { return { ...state, credits: state.credits + waveReward(state.wave) }; }\nexport function advanceGame(state, seed = 1) { const wave = state.wave + 1; return { ...state, wave, activeWave: createWave(wave, seed) }; }\nvoid upgradeCost;\n",
  );
  writeFileSync(
    path.join(greenfield, "src", "core", "rules.js"),
    "export const RULES = Object.freeze({ startCredits: 1200, startIntegrity: 100, baseEnemyHp: 40, baseEnemyDamage: 8, baseReward: 35, upgradeBaseCost: 100, upgradeCostStep: 50, maxUpgrades: 8, enemiesPerWave: 6 });\nexport const normalizeSeed = (seed = 1) => Math.max(1, Math.trunc(Number(seed) || 1));\nexport function createWave(index = 0, seed = 1) { const wave = Math.max(0, Math.trunc(Number(index) || 0)); const stableSeed = normalizeSeed(seed); const enemies = Array.from({ length: RULES.enemiesPerWave + wave }, (_, ordinal) => ({ id: `w${wave}-s${stableSeed}-e${ordinal}`, hp: RULES.baseEnemyHp + wave + ((stableSeed + ordinal) % 5), damage: RULES.baseEnemyDamage + ((stableSeed + ordinal) % 3), reward: RULES.baseReward + ((stableSeed + ordinal) % 7) })); return { index: wave, seed: stableSeed, enemies }; }\nexport const upgradeCost = (level = 0) => RULES.upgradeBaseCost + RULES.upgradeCostStep * Math.max(0, Math.trunc(Number(level) || 0));\nexport const waveReward = (index = 0) => RULES.baseReward * (Math.max(0, Math.trunc(Number(index) || 0)) + 1);\n",
  );
  writeFileSync(
    path.join(greenfield, "src", "main.js"),
    "export { contentEntries, summarizeContent } from './content/registry.js';\nexport { createGameState, advanceGame } from './core/index.js';\n",
  );
  writeFileSync(
    path.join(greenfield, "tests", "contracts.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { CONTENT_CATEGORIES, contentEntries, summarizeContent } from '../src/content/registry.js';\nimport { createGameState, advanceGame, createWave } from '../src/core/index.js';\n\nconst categories = new Set(CONTENT_CATEGORIES);\n\ntest('content summary is a stable public cross-package contract', () => {\n  assert.deepEqual(summarizeContent([{ category: 'tower' }, { category: 'enemy' }, { category: 'tower' }]), { tower: 2, enemy: 1 });\n  assert.deepEqual(summarizeContent([{ category: 'mystery' }, { category: '<img onerror=1>' }, { category: 42 }, {}, null]), { unknown: 5 });\n});\n\ntest('engine delegates wave construction to the public rules contract', () => {\n  const initial = createGameState(7);\n  assert.deepEqual(initial.activeWave, createWave(0, 7));\n  const next = advanceGame({ ...initial, credits: 777, integrity: 42 }, 9);\n  assert.equal(next.wave, 1);\n  assert.deepEqual(next.activeWave, createWave(1, 9));\n  assert.equal(next.credits, 777);\n  assert.equal(next.integrity, 42);\n});\n\ntest('integrated registry entries remain categorized and fully summarized', () => {\n  for (const entry of contentEntries) assert.ok(categories.has(entry.category), `unexpected category ${entry.category}`);\n  const total = Object.values(summarizeContent()).reduce((sum, count) => sum + count, 0);\n  assert.equal(total, contentEntries.length);\n});\n",
  );
  writeFileSync(
    path.join(greenfield, "scripts", "build.mjs"),
    "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('index.html', 'dist/index.html');\n",
  );
  writeFileSync(
    path.join(greenfield, "scripts", "generate-content.mjs"),
    readFileSync(
      new URL("./fixtures/greenfield/generate-content.mjs", import.meta.url),
      "utf8",
    ),
  );
  writeFileSync(
    path.join(greenfield, "tests", "content.test.js"),
    readFileSync(
      new URL("./fixtures/greenfield/content.test.js", import.meta.url),
      "utf8",
    ),
  );
  writeFileSync(
    path.join(greenfield, "tests", "ui-build.test.js"),
    readFileSync(
      new URL("./fixtures/greenfield/ui-build.test.js", import.meta.url),
      "utf8",
    ),
  );
  writeFileSync(path.join(greenfield, ".gitignore"), "dist/\nnode_modules/\n");
  gitInit(greenfield);
  git(greenfield, ["add", "-A"]);
  git(greenfield, ["commit", "-qm", "Seed minimal greenfield repository"]);

  const feature = path.join(workspace, "repositories", "feature-app");
  mkdirSync(path.join(feature, "src", "baseline"), { recursive: true });
  mkdirSync(path.join(feature, "src", "features", "expedition", "content"), {
    recursive: true,
  });
  mkdirSync(path.join(feature, "src", "features", "expedition", "content", "levels"), {
    recursive: true,
  });
  mkdirSync(path.join(feature, "src", "features", "expedition", "content", "rewards"), {
    recursive: true,
  });
  mkdirSync(path.join(feature, "src", "features", "expedition", "core"), {
    recursive: true,
  });
  mkdirSync(path.join(feature, "tests"), { recursive: true });
  mkdirSync(path.join(feature, "scripts"), { recursive: true });
  writeFileSync(
    path.join(feature, "package.json"),
    `${JSON.stringify({
      name: "feature-scale-app",
      private: true,
      type: "module",
      scripts: { test: "node --test", build: "node scripts/build.mjs" },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(feature, "index.html"),
    "<!doctype html><meta charset=\"utf-8\"><title>Feature Scale App</title><script type=\"module\" src=\"./src/main.js\"></script>\n",
  );
  writeFileSync(
    path.join(feature, "src", "main.js"),
    "export { baselineSectors, simulateBaseline } from './baseline/index.js';\nexport { expeditionLevels, seasonSeed, seasonIdentity, selectExpeditionLevel, calculateExpeditionReward, serializeExpeditionProgress, restoreExpeditionProgress } from './features/expedition/index.js';\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "registry.js"),
    "import { expeditionLevelEntries } from './content/levels-registry.js';\nimport { expeditionRewardEntries } from './content/rewards-registry.js';\nexport const expeditionLevels = Object.freeze([...expeditionLevelEntries, ...expeditionRewardEntries]);\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "content", "levels-registry.js"),
    "export const expeditionLevelEntries = Object.freeze([]);\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "content", "rewards-registry.js"),
    "export const expeditionRewardEntries = Object.freeze([]);\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "core", "index.js"),
    "export { seasonSeed, seasonIdentity } from './season.js';\nexport { selectExpeditionLevel } from './levels.js';\nexport { calculateExpeditionReward } from './rewards.js';\nexport { serializeExpeditionProgress, restoreExpeditionProgress } from './progress.js';\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "core", "season.js"),
    "export const seasonSeed = (date = new Date(0)) => date.toISOString().slice(0, 10);\nexport const seasonIdentity = (_date = new Date('2026-01-01T00:00:00.000Z')) => ({ season: 1, week: 1, seasonKey: '2026-S1-W01' });\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "core", "levels.js"),
    "import { expeditionLevels } from '../registry.js';\nexport const selectExpeditionLevel = (_seed, levels = expeditionLevels) => levels[0] ?? null;\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "core", "rewards.js"),
    "export const calculateExpeditionReward = () => 0;\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "core", "errors.js"),
    "export class ExpeditionProgressError extends Error {}\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "core", "progress.js"),
    "export const serializeExpeditionProgress = (value = {}) => JSON.stringify(value);\nexport const restoreExpeditionProgress = (value = '{}') => JSON.parse(value);\n",
  );
  writeFileSync(
    path.join(feature, "src", "features", "expedition", "index.js"),
    "export { expeditionLevels } from './registry.js';\nexport { seasonSeed, seasonIdentity, selectExpeditionLevel, calculateExpeditionReward, serializeExpeditionProgress, restoreExpeditionProgress } from './core/index.js';\n",
  );
  writeFileSync(
    path.join(feature, "tests", "baseline.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { baselineSectors, simulateBaseline } from '../src/main.js';\ntest('all baseline sectors are live', () => { assert.equal(baselineSectors.length, 140); const result = simulateBaseline({ wave: 7, resources: 9000 }); assert.equal(result.sectors, 140); assert.ok(result.threat > 0); });\n",
  );
  writeFileSync(
    path.join(feature, "tests", "feature-contracts.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { expeditionLevels, selectExpeditionLevel } from '../src/main.js';\n\ntest('expedition registry remains compatible across parallel packages', () => {\n  assert.ok(Array.isArray(expeditionLevels));\n  assert.ok([0, 24, 48].includes(expeditionLevels.length));\n  assert.equal(new Set(expeditionLevels.map((entry) => entry.id)).size, expeditionLevels.length);\n  const selected = selectExpeditionLevel('cross-package-contract');\n  if (expeditionLevels.length === 0) assert.equal(selected, null);\n  else assert.ok(selected && expeditionLevels.some((entry) => entry.id === selected.id));\n});\n",
  );
  writeFileSync(
    path.join(feature, "scripts", "build.mjs"),
    "import { mkdirSync, copyFileSync, cpSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('index.html', 'dist/index.html');\ncpSync('src', 'dist/src', { recursive: true });\n",
  );
  writeFileSync(path.join(feature, ".gitignore"), "dist/\nnode_modules/\n");
  seedFeatureBaselineSource(feature);
  gitInit(feature);
  git(feature, ["add", "-A"]);
  git(feature, ["commit", "-qm", "Seed 20k feature baseline"]);

  const bugfix = path.join(workspace, "repositories", "bugfix-app");
  seedBugfixProject(bugfix);

  return { greenfield, feature, bugfix };
}

function seedFeatureBaselineSource(project: string): void {
  const root = path.join(project, "src", "baseline");
  const imports: string[] = [];
  const names: string[] = [];
  for (let sectorIndex = 0; sectorIndex < 140; sectorIndex += 1) {
    const suffix = String(sectorIndex).padStart(3, "0");
    const name = `sector${suffix}`;
    const waves = Array.from({ length: 72 }, (_, waveIndex) => {
      const threat = 12 + ((sectorIndex * 17 + waveIndex * 11) % 89);
      const speed = 1 + ((sectorIndex + waveIndex * 3) % 9);
      return `    Object.freeze({ id: 'wave-${suffix}-${String(waveIndex).padStart(2, "0")}', threat: ${threat}, speed: ${speed} }),`;
    });
    const modules = Array.from({ length: 72 }, (_, moduleIndex) => {
      const power = 8 + ((sectorIndex * 13 + moduleIndex * 5) % 67);
      const cost = 40 + ((sectorIndex * 19 + moduleIndex * 23) % 360);
      return `    Object.freeze({ id: 'module-${suffix}-${String(moduleIndex).padStart(2, "0")}', power: ${power}, cost: ${cost} }),`;
    });
    writeFileSync(
      path.join(root, `${name}.js`),
      [
        `export const ${name} = Object.freeze({`,
        `  id: 'sector-${suffix}',`,
        "  waves: Object.freeze([",
        ...waves,
        "  ]),",
        "  modules: Object.freeze([",
        ...modules,
        "  ]),",
        "});",
        `export function simulate${name[0]!.toUpperCase()}${name.slice(1)}(input = {}) {`,
        "  const wave = Math.max(0, Number.isFinite(input.wave) ? Math.trunc(input.wave) : 0);",
        "  const resources = Math.max(0, Number.isFinite(input.resources) ? input.resources : 0);",
        `  const selected = ${name}.waves[wave % ${name}.waves.length];`,
        `  const defense = ${name}.modules.filter((item) => item.cost <= resources).reduce((sum, item) => sum + item.power, 0);`,
        `  return { sector: ${name}.id, threat: selected.threat * selected.speed, defense };`,
        "}",
        "",
      ].join("\n"),
    );
    const simulation = `simulate${name[0]!.toUpperCase()}${name.slice(1)}`;
    imports.push(`import { ${name}, ${simulation} } from './${name}.js';`);
    names.push(name);
  }
  const simulations = names.map(
    (name) => `    simulate${name[0]!.toUpperCase()}${name.slice(1)}(input),`,
  );
  writeFileSync(
    path.join(root, "index.js"),
    [
      ...imports,
      `export const baselineSectors = Object.freeze([${names.join(", ")}]);`,
      "export function simulateBaseline(input = {}) {",
      "  const snapshots = [",
      ...simulations,
      "  ];",
      "  return snapshots.reduce((summary, item) => ({ sectors: summary.sectors + 1, threat: summary.threat + item.threat, defense: summary.defense + item.defense }), { sectors: 0, threat: 0, defense: 0 });",
      "}",
      "",
    ].join("\n"),
  );
}

function seedBugfixProject(project: string): void {
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(path.join(project, "tests"), { recursive: true });
  mkdirSync(path.join(project, "scripts"), { recursive: true });
  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify({
      name: "parallel-bugfix-app",
      private: true,
      type: "module",
      scripts: {
        test: "node --test",
        "test:auth": "node --test tests/auth.test.js",
        "test:inventory": "node --test tests/inventory.test.js",
        "test:ranking": "node --test tests/ranking.test.js",
        build: "node scripts/build.mjs",
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(project, "src", "auth.js"),
    "export function isSessionValid(session, nowMs = Date.now()) { return Number(session.expiresAtMs) > Math.floor(nowMs / 1000); }\n",
  );
  writeFileSync(
    path.join(project, "src", "inventory.js"),
    "export function mergeInventory(items = []) { const merged = new Map(); for (const item of items) merged.set(item.id, { ...item }); return [...merged.values()]; }\n",
  );
  writeFileSync(
    path.join(project, "src", "ranking.js"),
    "export function rankPlayers(players = []) { return [...players].sort((left, right) => right.score - left.score); }\n",
  );
  writeFileSync(
    path.join(project, "tests", "auth.test.js"),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { isSessionValid } from '../src/auth.js'; test('expired millisecond sessions are rejected', () => assert.equal(isSessionValid({ expiresAtMs: 1_699_999_999_000 }, 1_700_000_000_000), false));\n",
  );
  writeFileSync(
    path.join(project, "tests", "inventory.test.js"),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { mergeInventory } from '../src/inventory.js'; test('duplicate finite quantities accumulate', () => assert.deepEqual(mergeInventory([{ id: 'ore', quantity: 2 }, { id: 'ore', quantity: 3 }]), [{ id: 'ore', quantity: 5 }]));\n",
  );
  writeFileSync(
    path.join(project, "tests", "ranking.test.js"),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { rankPlayers } from '../src/ranking.js'; test('ties use createdAt then id', () => assert.deepEqual(rankPlayers([{ id: 'z', score: 9, createdAt: 2 }, { id: 'b', score: 9, createdAt: 1 }, { id: 'a', score: 9, createdAt: 1 }]).map((item) => item.id), ['a', 'b', 'z']));\n",
  );
  writeFileSync(
    path.join(project, "scripts", "build.mjs"),
    "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); writeFileSync('dist/verified.txt', 'parallel bugfix build');\n",
  );
  writeFileSync(path.join(project, ".gitignore"), "dist/\nnode_modules/\n");
  gitInit(project);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "Seed three reproducible bugs"]);
}

function assertConcurrentDeliverables(
  t: CaseContext,
  repositories: ConcurrentRepositories,
  featureBaselineLines: number,
): void {
  for (const [name, repository] of Object.entries(repositories)) {
    t.assertions.assert(
      git(repository, ["branch", "--show-current"]) === "main",
      `${name} repository is not on main`,
    );
    t.assertions.assert(
      git(repository, ["status", "--porcelain"]) === "",
      `${name} repository is dirty`,
    );
  }
  t.assertions.assert(
    existsSync(path.join(repositories.greenfield, "index.html")) &&
      existsSync(path.join(repositories.greenfield, "src", "main.js")),
    "greenfield H5 entry is missing",
  );
  const greenfieldLines = effectiveProjectSourceLines(repositories.greenfield);
  t.assertions.assert(
    greenfieldLines >= 20_000 && greenfieldLines <= 30_000,
    `greenfield delivered ${greenfieldLines} effective lines instead of 20k-30k`,
  );
  const greenfieldModules = countJavaScriptFiles(
    path.join(repositories.greenfield, "src", "content"),
    new Set(["catalog.js", "registry.js"]),
  );
  t.assertions.assert(
    greenfieldModules === 126,
    `greenfield content registry has ${greenfieldModules}/126 modules`,
  );
  const featureLines = effectiveProjectSourceLines(repositories.feature);
  const featureAddedLines = featureLines - featureBaselineLines;
  t.assertions.assert(
    featureAddedLines >= 5_000 && featureAddedLines <= 10_000,
    `feature added ${featureAddedLines} effective lines instead of 5k-10k`,
  );
  const featureSource = readFileSync(path.join(repositories.feature, "src", "main.js"), "utf8");
  t.assertions.assert(/expedition/i.test(featureSource), "expedition feature is not production-reachable");
  const expeditionModules = countJavaScriptFiles(
    path.join(repositories.feature, "src", "features", "expedition", "content"),
    new Set(["levels-registry.js", "rewards-registry.js"]),
  );
  t.assertions.assert(
    expeditionModules === 48,
    `expedition content has ${expeditionModules}/48 modules`,
  );

  const bugfixSource = ["auth.js", "inventory.js", "ranking.js"]
    .map((file) => readFileSync(path.join(repositories.bugfix, "src", file), "utf8"))
    .join("\n");
  t.assertions.assert(!/Math\.floor\(nowMs\s*\/\s*1000\)/.test(bugfixSource), "auth expiry bug remains");
  t.assertions.assert(/quantity/.test(bugfixSource), "inventory merge fix is missing");
  t.assertions.assert(/createdAt/.test(bugfixSource), "ranking tie-break fix is missing");

  for (const repository of Object.values(repositories)) {
    assertRepositoryScripts(t, repository);
  }
}

function countJavaScriptFiles(root: string, excluded = new Set<string>()): number {
  let total = 0;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js") && !excluded.has(entry.name)) total += 1;
    }
  };
  walk(root);
  return total;
}

function assertRepositoryScripts(t: CaseContext, repository: string): void {
  const repositoryName = path.basename(repository);
  for (const script of ["test", "build"]) {
    const result = spawnSync("npm", ["run", script], {
      cwd: repository,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const logName = `pm-final-${repositoryName}-${script}.log`;
    writeFileSync(
      path.join(path.dirname(t.env.logs), logName),
      [
        `repository=${repositoryName}`,
        `command=npm run ${script}`,
        `status=${result.status ?? "null"}`,
        `signal=${result.signal ?? "none"}`,
        "--- stdout ---",
        result.stdout || "",
        "--- stderr ---",
        result.stderr || "",
        "",
      ].join("\n"),
      "utf8",
    );
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    t.assertions.assert(
      result.status === 0,
      `npm run ${script} failed for ${repositoryName}; full output: logs/lease/${logName}; tail: ${(
        combinedOutput || "no output"
      ).slice(-4_000)}`,
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

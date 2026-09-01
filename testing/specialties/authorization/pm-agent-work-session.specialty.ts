import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";

import { defineSpecialty } from "../../framework/public.ts";

const MODEL = "deepseek/deepseek-v4-flash";

function terminalCount(events: Array<{ type?: string }>): number {
  return events.filter((event) =>
    ["turnCompleted", "turnFailed", "turnCanceled"].includes(event.type ?? ""),
  ).length;
}

function completedCount(events: Array<{ type?: string }>): number {
  return events.filter((event) => event.type === "turnCompleted").length;
}

function eventTrace(events: Array<{ type?: string; raw: unknown }>): string {
  return JSON.stringify(events.map((event) => ({ type: event.type, raw: event.raw })));
}

function activeFixtureAgentPids(root: string): number[] {
  const lifecycleLog = `${root}/fixture-acp-agent-processes.jsonl`;
  if (!existsSync(lifecycleLog)) return [];
  const pids = readFileSync(lifecycleLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as { event?: string; pid?: number };
        return record.event === "started" && Number.isSafeInteger(record.pid)
          ? [record.pid as number]
          : [];
      } catch {
        return [];
      }
    });
  return [...new Set(pids)].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

defineSpecialty(
  {
    id: "specialty.authorization.pm-agent-work-session",
    title: "A PM Agent owns Agent Space and WorkSession mutations end to end",
    oracle:
      "a confined built-in PM uses the public CLI to initialize Builder and project state, register a local Agent Space, and start a third-party-adapter WorkAgent in its workflow-bound worktree; users can observe and fork its WorkSession but cannot mutate either managed resource",
    catches: [
      "PM identity is trusted from request payload instead of the daemon child",
      "ordinary users can mutate WorkSessions or managed Agent Spaces",
      "PM-created WorkSessions are indistinguishable from ordinary conversations",
      "a PM blocks itself by omitting --no-wait while dispatching a WorkAgent",
      "multiline PM contracts are altered by shell expansion before reaching a WorkAgent",
      "a committed Provider Skill change can be re-recorded against a stale Builder lock",
      "a failed supervisor wake retries on every two-second sampler tick",
      "forking a WorkSession preserves its privileged role",
      "a PM bypasses the project-owned Reviewer activity or expects the Coordinator to replace team dispatch",
      "a PM has to reconstruct exact Intent, package, and candidate identity inside an ad-hoc Reviewer prompt",
      "the project-owned Reviewer prompt permits slice-local cardinality assertions against a sibling-dependent aggregate",
      "high-frequency WorkSession authorization repeats a synchronous Builder tree walk and starves same-project status requests",
      "settled implementation and Reviewer adapter processes accumulate until the next Reviewer startup wave wedges the daemon",
      "graceful daemon shutdown serializes one process census per live Agent and leaves test-owned Agent servers orphaned",
    ],
    tags: ["core", "authorization", "pm-agent-mvp", "pm-agent-work-session"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 120_000,
    timeoutMs: 240_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  },
  async (t) => {
    const workAgentId = t.flows.main.installFixtureAcpAgent(t.env);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const createdPm = await opened.client.call({
        type: "pm.session.create",
        payload: {
          workspaceId: opened.workspaceId,
          modelId: MODEL,
          modeId: null,
          effortId: "medium",
          title: "Project manager",
        },
      });
      t.assertions.assert(createdPm?.type === "session", `pm.session.create returned ${createdPm?.type}`);
      if (createdPm?.type !== "session") return;
      const pm = createdPm.data;
      t.assertions.assert(pm.kind === "pm", `PM kind was ${pm.kind}`);
      t.assertions.assert(pm.capabilities?.archive === false && pm.capabilities.delete === false, "PM retention capabilities drifted");
      const workspacesAfterPmBootstrap = await opened.client.call({ type: "workspace.list" });
      const pmWorkspace =
        workspacesAfterPmBootstrap?.type === "workspaces"
          ? workspacesAfterPmBootstrap.data.find((workspace) => workspace.id === pm.workspaceId)
          : undefined;
      t.assertions.assert(
        pmWorkspace?.kind === "agentSpace" && pmWorkspace.parentWorkspaceId === opened.workspaceId,
        `PM Session did not run in the project-managed PM AgentSpace: ${JSON.stringify(pmWorkspace)}`,
      );

      const duplicatePm = await opened.client.call({
        type: "pm.session.create",
        payload: {
          workspaceId: opened.workspaceId,
          modelId: MODEL,
          modeId: null,
          title: null,
        },
      });
      t.assertions.assert(
        duplicatePm?.type === "session" &&
          duplicatePm.data.id !== pm.id &&
          duplicatePm.data.kind === "pm" &&
          duplicatePm.data.effortId === "medium",
        "the same project did not mint an independent medium-effort second PM session for a legacy caller",
      );
      const duplicatePmId = duplicatePm?.type === "session" ? duplicatePm.data.id : "";

      const pmEvents = await t.flows.main.attachEventLog(opened.client, pm.id);

      // Repository contents are fixture input. The PM Space is deliberately
      // confined to spaces/pm, so the PM may only mutate project state through
      // its authenticated CLI/Coordinator control plane.
      mkdirSync(`${t.env.workspace}/repositories/game`, { recursive: true });
      mkdirSync(`${t.env.workspace}/worktrees/implementation`, { recursive: true });
      mkdirSync(`${t.env.workspace}/spaces/implementation`, { recursive: true });
      mkdirSync(`${t.env.workspace}/spaces/review`, { recursive: true });
      mkdirSync(`${t.env.workspace}/skills/project-contract`, { recursive: true });
      writeFileSync(
        `${t.env.workspace}/.gitignore`,
        [
          ".genethub/",
          "repositories/",
          "worktrees/",
          "spaces/*/.pipebuilder/",
          "spaces/*/.agents/",
          "spaces/*/.cursor/",
          "spaces/*/.codebuddy/",
          "spaces/*/.claude/",
          "spaces/pm/pm-*.log",
          "spaces/pm/pm-*.json",
          "spaces/*/AGENTS.md",
          "spaces/*/CLAUDE.md",
          "",
        ].join("\n"),
      );
      writeFileSync(
        `${t.env.workspace}/skills/project-contract/SKILL.md`,
        "---\nname: project-contract\ndescription: Keep the gameplay contract deterministic.\n---\n\n# Project contract\n\nKeep the game deterministic.\n",
      );
      writeFileSync(
        `${t.env.workspace}/spaces/implementation/pipespace.json`,
        '{"schema":"pipespace.v1","name":"implementation","agents":["codex"],"skills":["project-contract"],"tags":[],"skillProviders":[{"type":"folder","path":"../../skills"}]}\n',
      );
      writeFileSync(
        `${t.env.workspace}/spaces/implementation/implementation.code-workspace`,
        '{"folders":[{"name":"implementation","path":"."},{"name":"game","path":"../../worktrees/implementation/game"}]}\n',
      );
      writeFileSync(
        `${t.env.workspace}/spaces/review/pipespace.json`,
        '{"schema":"pipespace.v1","name":"review","agents":["codex"],"skills":["project-contract"],"tags":[],"skillProviders":[{"type":"folder","path":"../../skills"}]}\n',
      );
      writeFileSync(
        `${t.env.workspace}/spaces/review/review.code-workspace`,
        '{"folders":[{"name":"review","path":"."},{"name":"game","path":"../../worktrees/implementation/game"}]}\n',
      );
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.env.workspace });
      execFileSync("git", ["config", "user.name", "GeneHub PM Fixture"], { cwd: t.env.workspace });
      execFileSync("git", ["config", "user.email", "pm-fixture@genehub.invalid"], { cwd: t.env.workspace });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: `${t.env.workspace}/repositories/game` });
      execFileSync("git", ["config", "user.name", "Fixture WorkAgent"], { cwd: `${t.env.workspace}/repositories/game` });
      execFileSync("git", ["config", "user.email", "work-fixture@genehub.invalid"], { cwd: `${t.env.workspace}/repositories/game` });
      writeFileSync(`${t.env.workspace}/repositories/game/README.md`, "# Game baseline\n");
      execFileSync("git", ["add", "README.md"], { cwd: `${t.env.workspace}/repositories/game` });
      execFileSync("git", ["commit", "-qm", "Create business baseline"], { cwd: `${t.env.workspace}/repositories/game` });
      execFileSync(
        "git",
        ["worktree", "add", "-q", "-b", "work/gameplay", `${t.env.workspace}/worktrees/implementation/game`, "main"],
        { cwd: `${t.env.workspace}/repositories/game` },
      );
      execFileSync("git", ["add", ".gitignore", "spaces/pm", "spaces/implementation", "spaces/review", "skills/project-contract"], {
        cwd: t.env.workspace,
      });
      execFileSync("git", ["commit", "-qm", "Initialize PM project topology"], { cwd: t.env.workspace });

      const initializeCommand = [
        '"$GENEHUB_CLI" pm project init',
        '"$GENEHUB_CLI" pm project intent set --outcome "Deliver a controlled gameplay package" --acceptance "The WorkAgent session is observable, isolated, and PM-controlled"',
        '"$GENEHUB_CLI" pm project advance --to git-ready',
        '"$GENEHUB_CLI" agent-space check implementation',
        '"$GENEHUB_CLI" agent-space explain implementation',
        '"$GENEHUB_CLI" agent-space build implementation --dry-run --require-no-post-commands',
        '"$GENEHUB_CLI" agent-space build implementation --require-no-post-commands',
        '"$GENEHUB_CLI" agent-space verify implementation',
        '"$GENEHUB_CLI" agent-space check review',
        '"$GENEHUB_CLI" agent-space build review --dry-run --require-no-post-commands',
        '"$GENEHUB_CLI" agent-space build review --require-no-post-commands',
        '"$GENEHUB_CLI" agent-space verify review',
        '"$GENEHUB_CLI" pm project advance --to topology-verified',
      ].join(" && ");
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: initializeCommand } } },
        { text: "The local Git project and implementation Agent Space are verified." },
      );
      const terminalsBeforeInitialization = terminalCount(pmEvents);
      const completionsBeforeInitialization = completedCount(pmEvents);
      await t.flows.main.sendPrompt(opened.client, pm.id, "初始化本地项目与实现拓扑。");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === terminalsBeforeInitialization + 1, 45_000);
      t.assertions.assert(
        completedCount(pmEvents) === completionsBeforeInitialization + 1,
        `PM initialization turn failed: ${eventTrace(pmEvents)}`,
      );

      const workspaceFile = `${t.env.workspace}/spaces/implementation/implementation.code-workspace`;
      const initializationSnapshot = await opened.client.call({
        type: "session.get",
        payload: { sessionId: pm.id },
      });
      t.assertions.assert(
        existsSync(workspaceFile),
        `PM initialization left no Agent Space source: snapshot=${JSON.stringify(initializationSnapshot)}`,
      );
      t.assertions.assert(
        existsSync(`${t.env.workspace}/spaces/implementation/.pipebuilder/lock.json`),
        `PM initialization left no Builder ownership lock: snapshot=${JSON.stringify(initializationSnapshot)}`,
      );
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: [
                '"$GENEHUB_CLI" workspace register-agent-space spaces/implementation/implementation.code-workspace',
                '"$GENEHUB_CLI" workspace register-agent-space spaces/review/review.code-workspace',
              ].join(" && "),
            },
          },
        },
        { text: "The implementation and review Agent Spaces are registered." },
      );
      const terminalsBeforeRegistration = terminalCount(pmEvents);
      const completionsBeforeRegistration = completedCount(pmEvents);
      await t.flows.main.sendPrompt(opened.client, pm.id, "注册实现 Agent Space。");
      try {
        await t.tools.waitUntil(() => terminalCount(pmEvents) === terminalsBeforeRegistration + 1, 15_000);
      } catch {
        throw new Error(`PM registration turn did not terminate: ${eventTrace(pmEvents)}`);
      }
      t.assertions.assert(
        completedCount(pmEvents) === completionsBeforeRegistration + 1,
        `PM registration turn failed: ${eventTrace(pmEvents)}`,
      );

      const listedWorkspaces = await opened.client.call({ type: "workspace.list" });
      const agentSpace =
        listedWorkspaces?.type === "workspaces"
          ? listedWorkspaces.data.find(
              (workspace) => workspace.kind === "agentSpace" && workspace.name === "implementation",
            )
          : undefined;
      const reviewSpace =
        listedWorkspaces?.type === "workspaces"
          ? listedWorkspaces.data.find(
              (workspace) => workspace.kind === "agentSpace" && workspace.name === "review",
            )
          : undefined;
      t.assertions.assert(agentSpace !== undefined, "the PM CLI did not register an Agent Space");
      t.assertions.assert(reviewSpace !== undefined, "the PM CLI did not register a review Agent Space");
      if (!agentSpace || !reviewSpace) return;
      t.assertions.assert(
        agentSpace.capabilities?.createSession === true &&
          agentSpace.capabilities.rename === false &&
          agentSpace.capabilities.remove === false,
        `unexpected Agent Space capabilities: ${JSON.stringify(agentSpace.capabilities)}`,
      );

      t.assertions.assert(Boolean(duplicatePmId), "the sibling PM Session id is missing");
      const siblingEvents = await t.flows.main.attachEventLog(opened.client, duplicatePmId);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: '"$GENEHUB_CLI" workspace register-agent-space spaces/implementation/implementation.code-workspace',
            },
          },
        },
        { text: "The existing project Agent Space is reused without changing its owner." },
      );
      const siblingTerminals = terminalCount(siblingEvents);
      const siblingCompletions = completedCount(siblingEvents);
      await t.flows.main.sendPrompt(
        opened.client,
        duplicatePmId,
        "幂等复用项目已经注册的实现 Agent Space。",
      );
      await t.tools.waitUntil(() => terminalCount(siblingEvents) === siblingTerminals + 1, 15_000);
      t.assertions.assert(
        completedCount(siblingEvents) === siblingCompletions + 1,
        `sibling PM could not rediscover the shared Agent Space: ${eventTrace(siblingEvents)}`,
      );

      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: t.env.workspace,
        encoding: "utf8",
      }).trim();
      const activateCommand = [
        `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${sourceCommit} --tag gameplay`,
        `"$GENEHUB_CLI" pm project space record --name review --purpose "Independently review gameplay candidates" --path spaces/review --workspace ${reviewSpace.id} --commit ${sourceCommit} --role review --tag gameplay`,
        '"$GENEHUB_CLI" pm project advance --to workspaces-registered',
        '"$GENEHUB_CLI" pm project advance --to active',
        '"$GENEHUB_CLI" pm project workflow select --graph feature',
        '"$GENEHUB_CLI" pm project workflow transition --edge aligned --fact intent.aligned',
        '"$GENEHUB_CLI" pm project workflow transition --edge planned --fact plan.ready',
        'if "$GENEHUB_CLI" pm project package put --id legacy-space --title "Legacy package" --outcome "Must be rejected" --space implementation --repository game --branch work/gameplay --node implement; then exit 76; fi',
        '"$GENEHUB_CLI" pm project package put --id wp-gameplay --title "Gameplay package" --outcome "Produce the gameplay candidate" --space-tag gameplay --repository game --branch work/gameplay --node implement',
        `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${sourceCommit} --tag gameplay --tag webgl2`,
        '"$GENEHUB_CLI" pm project package transition --id wp-gameplay --to ready',
        '"$GENEHUB_CLI" pm project workflow status > pm-workflow-status.json',
      ].join(" && ");
      const terminalsBeforeActivation = terminalCount(pmEvents);
      const completionsBeforeActivation = completedCount(pmEvents);
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: activateCommand } } },
        { text: "The verified Space and ready work package are durable." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "记录 Space 并激活玩法工作包。");
      await t.tools.waitUntil(
        () => terminalCount(pmEvents) === terminalsBeforeActivation + 1,
        30_000,
      );
      t.assertions.assert(
        completedCount(pmEvents) === completionsBeforeActivation + 1,
        `PM activation turn failed: ${eventTrace(pmEvents)}`,
      );

      const compactStatusPath = `${t.env.workspace}/spaces/pm/pm-workflow-status.json`;
      const compactStatusRaw = readFileSync(compactStatusPath, "utf8");
      const compactStatus = JSON.parse(compactStatusRaw) as {
        data?: {
          project?: { phase?: string };
          run?: { controllerSessionId?: string; resourceCapacities?: unknown[] };
          workPackages?: Array<{ controllerSessionId?: string }>;
          agentSpaces?: Array<{ name?: string; tags?: string[] }>;
        };
      };
      t.assertions.assert(
        Buffer.byteLength(compactStatusRaw) < 64 * 1024 &&
          compactStatus.data?.project?.phase === "active" &&
          compactStatus.data.run?.controllerSessionId === pm.id &&
          (compactStatus.data.run.resourceCapacities?.length ?? 0) > 0 &&
          compactStatus.data.workPackages?.every(
            (item) => item.controllerSessionId === pm.id,
          ) === true &&
          compactStatus.data.agentSpaces?.some(
            (space) => space.name === "implementation" && space.tags?.includes("gameplay"),
          ),
        `compact PM Session status drifted: bytes=${Buffer.byteLength(compactStatusRaw)} status=${compactStatusRaw}`,
      );

      const publicProject = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      const projectedRun =
        publicProject?.type === "projectStatus"
          ? publicProject.data.workflowRuns.find(
              (run) => run.controllerSessionId === pm.id,
            )
          : undefined;
      const featureDefinition =
        publicProject?.type === "projectStatus"
          ? publicProject.data.workflowCatalog.workflows.find((workflow) => workflow.id === "feature")
          : undefined;
      const reviewNode = featureDefinition?.nodes.find((node) => node.id === "review");
      const integrationNode = featureDefinition?.nodes.find((node) => node.id === "integrate");
      const reviewTriageNode = featureDefinition?.nodes.find((node) => node.id === "review-triage");
      t.assertions.assert(
          publicProject?.type === "projectStatus" &&
          publicProject.data.phase === "active" &&
          publicProject.data.agentSpaces[0]?.role === "implementation" &&
          publicProject.data.agentSpaces[0]?.resourceState === "idle" &&
          publicProject.data.agentSpaces[0]?.tags.includes("webgl2") &&
          projectedRun?.budget?.wallClockMs === 600_000 &&
          projectedRun.budget.remainingMs > 0 &&
          projectedRun.budget.maxWorkSessions === 16 &&
          projectedRun.budget.maxConcurrentWorkSessions === 4 &&
          projectedRun.budget.workSessionsStarted === 0 &&
          projectedRun.budget.activeWorkSessions === 0 &&
          reviewNode?.actor === "reviewer" &&
          integrationNode?.actor === "system" &&
          reviewTriageNode?.actor === "pm" &&
          projectedRun.resourceCapacities.some(
              (capacity) =>
                capacity.nodeId === "implement" &&
                capacity.maxItems === 4 &&
                capacity.allocatedItems === 1 &&
                capacity.matchingSpaces === 1 &&
                capacity.availableSpaces === 0 &&
                capacity.availableSlots === 0,
            ) &&
          publicProject.data.workPackages.some(
            (item) =>
              item.id === "wp-gameplay" &&
              item.requiredSpaceTags.includes("gameplay") &&
              item.agentSpace === "implementation" &&
              item.repository === "game" &&
              Boolean(item.workflowRunId) &&
              Boolean(item.nodeInstanceId),
          ),
        `public PM project projection drifted: ${JSON.stringify(publicProject)}`,
      );

      const driftTerminals = terminalCount(pmEvents);
      const driftCompletions = completedCount(pmEvents);
      const manifestPath = "spaces/implementation/pipespace.json";
      const manifestAbsolutePath = `${t.env.workspace}/${manifestPath}`;
      const manifestBeforeDrift = readFileSync(manifestAbsolutePath, "utf8");
      writeFileSync(manifestAbsolutePath, `${manifestBeforeDrift}\n`);
      const driftResult = "pm-space-drift-check.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `if "$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package wp-gameplay --no-wait "This dispatch must be rejected." > ${driftResult} 2>&1; then exit 71; fi`,
            },
          },
        },
        { text: "Dispatch was rejected while the recorded Agent Space Builder identity drifted." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "验证 Agent Space 漂移会在派发前失败关闭。");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === driftTerminals + 1, 15_000);
      writeFileSync(manifestAbsolutePath, manifestBeforeDrift);
      const driftResultPath = `${t.env.workspace}/spaces/pm/${driftResult}`;
      t.assertions.assert(
        completedCount(pmEvents) === driftCompletions + 1 &&
          existsSync(driftResultPath) &&
          /Builder verification|PB017|changed|uncommitted tracked source/i.test(
            readFileSync(driftResultPath, "utf8"),
          ),
        `drift dispatch did not fail closed: ${eventTrace(pmEvents)}`,
      );
      const sessionsAfterDrift = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: agentSpace.id, includeArchived: true },
      });
      t.assertions.assert(
        sessionsAfterDrift?.type === "sessions" &&
          sessionsAfterDrift.data.every((session) => session.kind !== "work"),
        `drift created a WorkSession before rejection: ${JSON.stringify(sessionsAfterDrift)}`,
      );

      const sourceDriftTerminals = terminalCount(pmEvents);
      const sourceDriftCompletions = completedCount(pmEvents);
      const uncommittedProviderRoot = `${t.env.workspace}/skills/uncommitted-provider`;
      mkdirSync(uncommittedProviderRoot, { recursive: true });
      writeFileSync(
        `${uncommittedProviderRoot}/SKILL.md`,
        "---\nname: uncommitted-provider\ndescription: must invalidate recorded project evidence\n---\n",
      );
      const sourceDriftResult = "pm-project-source-drift-check.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `if "$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package wp-gameplay --no-wait "This dispatch must also be rejected." > ${sourceDriftResult} 2>&1; then exit 74; fi`,
            },
          },
        },
        { text: "Dispatch was rejected while the outer project source commit drifted." },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        pm.id,
        "验证未提交的根 Provider 源码会在派发前失败关闭。",
      );
      await t.tools.waitUntil(() => terminalCount(pmEvents) === sourceDriftTerminals + 1, 15_000);
      rmSync(uncommittedProviderRoot, { recursive: true, force: true });
      const sourceDriftResultPath = `${t.env.workspace}/spaces/pm/${sourceDriftResult}`;
      t.assertions.assert(
        completedCount(pmEvents) === sourceDriftCompletions + 1 &&
          existsSync(sourceDriftResultPath) &&
          /PB017|ownership lock|planned artifacts|untracked|project source|source commit|differ/i.test(
            readFileSync(sourceDriftResultPath, "utf8"),
          ),
        `outer project source drift did not fail closed: ${eventTrace(pmEvents)}`,
      );

      const staleProviderTerminals = terminalCount(pmEvents);
      const staleProviderCompletions = completedCount(pmEvents);
      const providerSkillPath = `${t.env.workspace}/skills/project-contract/SKILL.md`;
      const providerBeforeDrift = readFileSync(providerSkillPath, "utf8");
      writeFileSync(
        providerSkillPath,
        "---\nname: project-contract\ndescription: A changed contract that requires a rebuild.\n---\n\n# Changed contract\n",
      );
      execFileSync("git", ["add", "skills/project-contract/SKILL.md"], { cwd: t.env.workspace });
      execFileSync("git", ["commit", "-qm", "Change Provider Skill without rebuilding"], { cwd: t.env.workspace });
      const staleSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: t.env.workspace,
        encoding: "utf8",
      }).trim();
      const staleProviderResult = "pm-stale-provider-lock-check.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: [
                `if "$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${staleSourceCommit} > ${staleProviderResult} 2>&1; then exit 75; fi`,
                `printf '%s\\n' 'stale-provider-rejected' >> ${staleProviderResult}`,
              ].join(" && "),
            },
          },
        },
        { text: "A committed Provider change was rejected until source and Builder lock matched again." },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        pm.id,
        "验证已提交的 Provider Skill 不能用过期 Builder lock 重新登记。",
      );
      await t.tools.waitUntil(() => terminalCount(pmEvents) === staleProviderTerminals + 1, 30_000);
      const staleProviderResultPath = `${t.env.workspace}/spaces/pm/${staleProviderResult}`;
      const staleProviderOutput = existsSync(staleProviderResultPath)
        ? readFileSync(staleProviderResultPath, "utf8")
        : "missing stale Provider result";
      t.assertions.assert(
        completedCount(pmEvents) === staleProviderCompletions + 1 &&
          staleProviderOutput.includes("stale-provider-rejected"),
        `stale Provider lock was re-recorded: output=${staleProviderOutput} events=${eventTrace(pmEvents)}`,
      );

      // The recorded Space is an immutable Builder snapshot. A later clean
      // commit may change its Provider source, but dispatch must keep using
      // the previously verified Space bytes until an explicit re-record. This
      // also proves the hot authorization path does not repeat the synchronous
      // Builder source/artifact walk on the daemon's single WASM fiber.
      const pinnedDispatchTerminals = terminalCount(pmEvents);
      const pinnedDispatchCompletions = completedCount(pmEvents);
      const pinnedDispatchResult = "pm-pinned-space-dispatch.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `if "$GENEHUB_CLI" agent run --agent ${workAgentId} --work-package wp-gameplay --cwd ${t.env.workspace}/spaces/implementation --no-wait "This cwd must be rejected after authorization." > ${pinnedDispatchResult} 2>&1; then exit 77; fi`,
            },
          },
        },
        { text: "The pinned Agent Space remained dispatchable; the unrelated cwd contract was rejected." },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        pm.id,
        "验证已固定的 Agent Space 不会因 Provider 后续提交而在每次派发时重复重建身份。",
      );
      await t.tools.waitUntil(
        () => terminalCount(pmEvents) === pinnedDispatchTerminals + 1,
        15_000,
      );
      const pinnedDispatchOutputPath = `${t.env.workspace}/spaces/pm/${pinnedDispatchResult}`;
      const pinnedDispatchOutput = existsSync(pinnedDispatchOutputPath)
        ? readFileSync(pinnedDispatchOutputPath, "utf8")
        : "missing pinned dispatch result";
      const statusAfterPinnedDispatch = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(
        completedCount(pmEvents) === pinnedDispatchCompletions + 1 &&
          /fixed by its durable work package/i.test(pinnedDispatchOutput) &&
          !/Builder verification|PB017|ownership lock|planned artifacts/i.test(pinnedDispatchOutput) &&
          statusAfterPinnedDispatch?.type === "projectStatus" &&
          statusAfterPinnedDispatch.data.agentSpaces.some(
            (space) =>
              space.workspaceId === agentSpace.id &&
              space.resourceState === "idle" &&
              !space.workPackageId &&
              !space.workSessionId,
          ),
        `pinned Agent Space dispatch repeated Builder verification or leaked its lease: output=${pinnedDispatchOutput} status=${JSON.stringify(statusAfterPinnedDispatch)}`,
      );

      writeFileSync(providerSkillPath, providerBeforeDrift);
      execFileSync("git", ["add", "skills/project-contract/SKILL.md"], { cwd: t.env.workspace });
      execFileSync("git", ["commit", "-qm", "Restore Provider Skill fixture"], { cwd: t.env.workspace });
      const restoredSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: t.env.workspace,
        encoding: "utf8",
      }).trim();
      const restoreTerminals = terminalCount(pmEvents);
      const restoreCompletions = completedCount(pmEvents);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: [
                '"$GENEHUB_CLI" agent-space verify implementation',
                '"$GENEHUB_CLI" agent-space verify review',
                `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${restoredSourceCommit} --tag gameplay --tag webgl2`,
                `"$GENEHUB_CLI" pm project space record --name review --purpose "Independently review gameplay candidates" --path spaces/review --workspace ${reviewSpace.id} --commit ${restoredSourceCommit} --role review --tag gameplay`,
              ].join(" && "),
            },
          },
        },
        { text: "The restored Provider source and Builder lock are recorded again." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "恢复已验证的 Agent Space 证据。");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === restoreTerminals + 1, 15_000);
      t.assertions.assert(
        completedCount(pmEvents) === restoreCompletions + 1,
        `restored Agent Space evidence was not accepted: ${eventTrace(pmEvents)}`,
      );

      const rejectedCwdTerminals = terminalCount(pmEvents);
      const rejectedCwdCompletions = completedCount(pmEvents);
      const rejectedCwdResult = "pm-invalid-cwd-dispatch.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `if "$GENEHUB_CLI" agent run --agent ${workAgentId} --work-package wp-gameplay --cwd ${t.env.workspace}/spaces/implementation --no-wait "This dispatch must be rejected before session creation." > ${rejectedCwdResult} 2>&1; then exit 76; fi`,
            },
          },
        },
        { text: "The invalid cwd was rejected without leaking the Agent Space reservation." },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        pm.id,
        "验证被拒绝的 WorkAgent cwd 会原子释放预约。",
      );
      await t.tools.waitUntil(
        () => terminalCount(pmEvents) === rejectedCwdTerminals + 1,
        15_000,
      );
      const rejectedCwdOutput = `${t.env.workspace}/spaces/pm/${rejectedCwdResult}`;
      const statusAfterRejectedCwd = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(
        completedCount(pmEvents) === rejectedCwdCompletions + 1 &&
          existsSync(rejectedCwdOutput) &&
          /fixed by its durable work package/i.test(readFileSync(rejectedCwdOutput, "utf8")) &&
          statusAfterRejectedCwd?.type === "projectStatus" &&
          statusAfterRejectedCwd.data.agentSpaces.some(
            (space) =>
              space.workspaceId === agentSpace.id &&
              space.resourceState === "idle" &&
              !space.workPackageId &&
              !space.workSessionId,
          ),
        `rejected cwd leaked a reservation: output=${
          existsSync(rejectedCwdOutput) ? readFileSync(rejectedCwdOutput, "utf8") : "missing"
        } status=${JSON.stringify(statusAfterRejectedCwd)}`,
      );

      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "workspace.registerAgentSpace",
            payload: { source: workspaceFile },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "workspace.rename",
            payload: { workspaceId: agentSpace.id, name: "user-renamed" },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "workspace.remove", payload: { workspaceId: agentSpace.id } }),
        "forbidden",
      );

      const pmCompletions = completedCount(pmEvents);
      const pmTerminals = terminalCount(pmEvents);
      const literalWorkPrompt = [
        "Implement the gameplay package. Use `git status` and $PROJECT literally.",
        "  Preserve this indented acceptance note.",
        "Preserve two trailing spaces after this sentence.  ",
        "",
        "",
      ].join("\n");
      const dispatchCommand = [
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package wp-gameplay --message - > pm-work-dispatch.json <<'GENEHUB_PROMPT'`,
        literalWorkPrompt,
        "GENEHUB_PROMPT",
      ].join("\n");
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              // Deliberately omit --no-wait. The authenticated PM control
              // surface must still return immediately and keep the manager
              // available while its WorkSession runs.
              command: dispatchCommand,
            },
          },
        },
        { text: "The WorkAgent is running." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "启动玩法 WorkAgent。");

      let workId = "";
      let lastSessions: unknown = null;
      try {
        await t.tools.waitUntil(async () => {
          const sessions = await opened.client.call({
            type: "session.list",
            payload: { workspaceId: agentSpace.id, includeArchived: true },
          });
          lastSessions = sessions;
          const work =
            sessions?.type === "sessions" ? sessions.data.find((session) => session.kind === "work") : undefined;
          workId = work?.id ?? "";
          return workId.length > 0;
        }, 15_000);
      } catch {
        throw new Error(
          `PM did not create a WorkSession: events=${eventTrace(pmEvents)} sessions=${JSON.stringify(lastSessions)}`,
        );
      }
      await t.tools.waitUntil(() => terminalCount(pmEvents) === pmTerminals + 1, 15_000);
      t.assertions.assert(
        completedCount(pmEvents) === pmCompletions + 1,
        `PM WorkAgent launch turn failed: ${eventTrace(pmEvents)}`,
      );
      const dispatchResult = `${t.env.workspace}/spaces/pm/pm-work-dispatch.json`;
      t.assertions.assert(
        existsSync(dispatchResult) && readFileSync(dispatchResult, "utf8").includes('"waited":false'),
        `PM dispatch was not forced non-blocking: ${existsSync(dispatchResult) ? readFileSync(dispatchResult, "utf8") : "missing CLI output"}`,
      );
      const atomicallyBound = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      const boundPackage =
        atomicallyBound?.type === "projectStatus"
          ? atomicallyBound.data.workPackages.find(
              (item) => item.controllerSessionId === pm.id && item.id === "wp-gameplay",
            )
          : undefined;
      t.assertions.assert(
        boundPackage?.status === "running" && boundPackage.workSessionId === workId,
        `agent run did not atomically bind the WorkSession: ${JSON.stringify(boundPackage)}`,
      );

      const bindTerminals = terminalCount(pmEvents);
      const bindCompletions = completedCount(pmEvents);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `"$GENEHUB_CLI" pm project package transition --id wp-gameplay --to running --session ${workId} > pm-running-transition.json`,
            },
          },
        },
        { text: "The WorkSession is bound to the durable package." },
        {
          text: "This first supervisor attempt must be interrupted by the component reload.",
          delayMs: 10_000,
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" pm project package transition --id wp-gameplay --to blocked --reason "Fixture WorkAgent produced no Git candidate"',
            },
          },
        },
        { text: "The completed fixture session was observed and the package was safely blocked." },
        { status: 402 },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" pm project workflow transition --edge recovery-prepared --fact recovery.ready && "$GENEHUB_CLI" pm project lifecycle --to waiting-user',
            },
          },
        },
        { text: "Recovery evidence is prepared. The declared choice now belongs to the user." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "把新 WorkSession 绑定到对应工作包。");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === bindTerminals + 1, 15_000);
      t.assertions.assert(
        completedCount(pmEvents) === bindCompletions + 1,
        `PM WorkSession binding turn failed: ${eventTrace(pmEvents)}`,
      );
      const runningTransition = `${t.env.workspace}/spaces/pm/pm-running-transition.json`;
      t.assertions.assert(
        existsSync(runningTransition) &&
          readFileSync(runningTransition, "utf8").includes("finishTurnAfterReadyDispatches"),
        `running transition did not tell the PM to yield to the supervisor: ${existsSync(runningTransition) ? readFileSync(runningTransition, "utf8") : "missing CLI output"}`,
      );
      const workEvents = await t.flows.main.attachEventLog(opened.client, workId);
      let completedWork = await opened.client.call({ type: "session.get", payload: { sessionId: workId } });
      await t.tools.waitUntil(async () => {
        completedWork = await opened.client.call({ type: "session.get", payload: { sessionId: workId } });
        return (
          completedWork?.type === "snapshot" &&
          completedWork.data.summary.status !== "running" &&
          completedWork.data.items.some((item) => item.type === "turnSummary")
        );
      }, 45_000);
      t.assertions.assert(
        completedWork?.type === "snapshot" && completedWork.data.summary.status === "idle",
        `WorkAgent turn failed: snapshot=${JSON.stringify(completedWork)} events=${eventTrace(workEvents)}`,
      );

      // The supervisor handoff is durable until its exact PM turn completes.
      // Force an in-place component reload while the first wake turn is still
      // waiting on the delayed model response. The replacement daemon must
      // detect the open round and resend the same pending wake.
      const projectState = `${t.env.data}/pm-projects/${opened.workspaceId}.json`;
      await t.tools.waitUntil(async () => {
        const [project, pmSnapshot] = await Promise.all([
          opened.client.call({
            type: "pm.project.status",
            payload: { workspaceId: opened.workspaceId },
          }),
          opened.client.call({ type: "session.get", payload: { sessionId: pm.id } }),
        ]);
        const run =
          project?.type === "projectStatus"
            ? project.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)
            : undefined;
        return run?.supervisor.wakePending === true && pmSnapshot?.type === "snapshot" &&
          pmSnapshot.data.summary.status === "running";
      }, 30_000);
      const endpointBefore = JSON.parse(
        execFileSync(opened.daemon.genet, ["daemon", "endpoint"], {
          env: opened.daemon.env,
          encoding: "utf8",
        }),
      ) as { wsUrl: string; admission: { pid: number } };
      const command = readFileSync(`/proc/${endpointBefore.admission.pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      const componentFlag = command.indexOf("--component");
      const component = componentFlag >= 0 ? command[componentFlag + 1] : undefined;
      t.assertions.assert(
        component?.includes("/.test-runtime/") === true,
        `reload fixture could not resolve the lease component: ${command.join(" ")}`,
      );
      if (!component) return;
      const touched = new Date(Date.now() + 2_000);
      utimesSync(component, touched, touched);
      await t.tools.waitUntil(() => {
        try {
          const endpoint = JSON.parse(
            execFileSync(opened.daemon.genet, ["daemon", "endpoint"], {
              env: opened.daemon.env,
              encoding: "utf8",
            }),
          ) as { wsUrl: string };
          return endpoint.wsUrl !== endpointBefore.wsUrl;
        } catch {
          return false;
        }
      }, 30_000);
      let recoveredProject: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        try {
          recoveredProject = await opened.client.call({
            type: "pm.project.status",
            payload: { workspaceId: opened.workspaceId },
          });
        } catch {
          // A read racing the deliberate in-place reload has no side effect;
          // retry it after the product client redials the replacement daemon.
          return false;
        }
        return (
          recoveredProject?.type === "projectStatus" &&
          recoveredProject.data.workPackages.some(
            (item) => item.id === "wp-gameplay" && item.status === "blocked",
          )
        );
      }, 45_000);
      t.assertions.assert(
        recoveredProject?.type === "projectStatus",
        `PM supervisor did not recover after reload: ${JSON.stringify(recoveredProject)}`,
      );

      let failedWakeState:
        | {
            sessionSupervisors?: Record<
              string,
              { wakePending?: boolean; wakeTurnId?: string; wakeRetryAtMs?: number }
            >;
          }
        | undefined;
      await t.tools.waitUntil(() => {
        if (!existsSync(projectState)) return false;
        failedWakeState = JSON.parse(readFileSync(projectState, "utf8")) as typeof failedWakeState;
        const runSupervisor = failedWakeState?.sessionSupervisors?.[pm.id];
        return (
          runSupervisor?.wakePending === true &&
          !runSupervisor.wakeTurnId &&
          typeof runSupervisor.wakeRetryAtMs === "number"
        );
      }, 30_000);
      const persistedRetryRemaining =
        (failedWakeState?.sessionSupervisors?.[pm.id]?.wakeRetryAtMs ?? 0) - Date.now();
      t.assertions.assert(
        persistedRetryRemaining >= 20_000 && persistedRetryRemaining <= 31_000,
        `first failed PM wake did not persist a 30-second retry: ${JSON.stringify(failedWakeState)}`,
      );
      const failedWakeObservedAt = Date.now();
      const requestsAfterFailedWake = opened.mock.requests.length;
      await t.tools.waitUntil(() => Date.now() - failedWakeObservedAt >= 5_000, 7_000);
      t.assertions.assert(
        opened.mock.requests.length === requestsAfterFailedWake,
        `failed PM supervisor wake retried on the two-second sampler: requests=${opened.mock.requests.length - requestsAfterFailedWake}`,
      );
      let waitingAfterBackoff: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        waitingAfterBackoff = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        const run = waitingAfterBackoff?.type === "projectStatus"
          ? waitingAfterBackoff.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)
          : undefined;
        return (
          waitingAfterBackoff?.type === "projectStatus" &&
          waitingAfterBackoff.data.lifecycle === "active" &&
          run?.supervisor.mode === "waitingUser" &&
          typeof run.budget?.userWaitStartedAtMs === "number" &&
          (run.budget?.remainingMs ?? 0) > 0 &&
          run?.activeNodes.includes("recover") === true &&
          run.availableEdges.some((edge) => edge.id === "cancel" && edge.chooseBy === "user" && edge.satisfied)
        );
      }, 45_000);
      await t.tools.waitUntil(
        () => opened.mock.requests.length >= requestsAfterFailedWake + 2,
        30_000,
      );
      const observedRetryDelay = Date.now() - failedWakeObservedAt;
      t.assertions.assert(
        observedRetryDelay >= 25_000,
        `failed PM supervisor wake ignored its 30-second backoff (${observedRetryDelay}ms)`,
      );
      t.assertions.assert(
        opened.mock.requests.length === requestsAfterFailedWake + 2,
        `provider failure created a retry storm instead of one tool round: requests=${opened.mock.requests.length - requestsAfterFailedWake}`,
      );
      const waitingRunSupervisor = waitingAfterBackoff?.type === "projectStatus"
        ? waitingAfterBackoff.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.supervisor
        : undefined;
      t.assertions.assert(
        waitingAfterBackoff?.type === "projectStatus" &&
          (waitingRunSupervisor?.wakeDispatchCount ?? 0) >= 2 &&
          (waitingRunSupervisor?.wakeFailedCount ?? 0) >= 1,
        `supervisor telemetry did not preserve dispatch/failure evidence: ${JSON.stringify(waitingAfterBackoff)}`,
      );
      if (waitingAfterBackoff?.type === "projectStatus") {
        t.note(
          `pm-supervisor-metrics ${JSON.stringify({
            wakeDispatchCount: waitingRunSupervisor?.wakeDispatchCount,
            wakeFailedCount: waitingRunSupervisor?.wakeFailedCount,
            coalescedEventCount: waitingRunSupervisor?.coalescedEventCount,
          })}`,
        );
      }
      const waitingRun = waitingAfterBackoff?.type === "projectStatus"
        ? waitingAfterBackoff.data.workflowRuns.find(
            (item) => item.controllerSessionId === pm.id,
          )
        : undefined;
      if (!waitingRun) throw new Error("the waiting PM Run disappeared before user decision");

      const humanDecision = await opened.client.call({
        type: "pm.workflow.transition",
        payload: {
          workspaceId: opened.workspaceId,
          sessionId: pm.id,
          edgeId: "cancel",
          expectedRevision: waitingRun.revision,
          facts: [],
        },
      });
      t.assertions.assert(
        humanDecision?.type === "projectStatus" &&
          humanDecision.data.lifecycle === "active" &&
          humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.status === "cancelled" &&
          (humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.budget?.userWaitMs ?? 0) > 0 &&
          humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.budget?.userWaitStartedAtMs == null &&
          humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.supervisor.mode ===
            "terminal" &&
          humanDecision.data.workflowRuns
            .find((item) => item.controllerSessionId === pm.id)
            ?.teamSlots.find((slot) => slot.workPackageId === "wp-gameplay")?.workSessionId == null &&
          humanDecision.data.workPackages.find((item) => item.id === "wp-gameplay")?.status === "cancelled",
        `the user decision did not settle the failed attempt: ${JSON.stringify(humanDecision)}`,
      );
      const decisionOverview = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(
        decisionOverview?.type === "projectStatus" &&
          decisionOverview.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.status ===
            "cancelled" &&
          decisionOverview.data.workflowRuns.find((item) => item.controllerSessionId === duplicatePmId)?.status ===
            "discussion",
        `the project overview did not preserve the sibling PM Run: ${JSON.stringify(decisionOverview)}`,
      );

      const snapshot = completedWork;
      t.assertions.assert(snapshot?.type === "snapshot", `session.get returned ${snapshot?.type}`);
      if (snapshot?.type !== "snapshot") return;
      const work = snapshot.data.summary;
      t.assertions.assert(work.kind === "work", `WorkSession kind was ${work.kind}`);
      t.assertions.assert(work.work?.workPackageId === "wp-gameplay", `work metadata ${JSON.stringify(work.work)}`);
      t.assertions.assert(work.work?.controllerSessionId === pm.id, "WorkSession controller is not the PM session");
      const workText = snapshot.data.items
        .filter((item) => item.type === "assistantMessage")
        .map((item) => (item.type === "assistantMessage" ? item.text : ""))
        .join("\n");
      const workPrompt = snapshot.data.items
        .filter((item) => item.type === "userMessage")
        .map((item) => (item.type === "userMessage" ? item.text : ""))
        .join("\n");
      t.assertions.assert(
        workPrompt === literalWorkPrompt,
        `explicit stdin changed the WorkAgent contract: ${JSON.stringify(workPrompt)}`,
      );
      t.assertions.assert(
        workText.includes(`cwd=${t.env.workspace}/worktrees/implementation/game`),
        `WorkSession did not report its DAG slot: ${workText}`,
      );
      t.assertions.assert(
        work.capabilities?.send === false &&
          work.capabilities.interrupt === false &&
          work.capabilities.delete === false &&
          work.capabilities.fork === true,
        `unexpected WorkSession capabilities: ${JSON.stringify(work.capabilities)}`,
      );

      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "session.send",
            payload: {
              sessionId: workId,
              text: "user tries to redirect work",
              attachments: [],
              artifactPreviewBaseUrl: null,
              continuesRound: null,
            },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "session.archive", payload: { sessionId: workId, archived: true } }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "session.delete", payload: { sessionId: workId } }),
        "forbidden",
      );

      const turn = snapshot.data.items.find((item) => item.type === "turnSummary");
      t.assertions.assert(turn?.type === "turnSummary", "completed WorkSession has no forkable turn summary");
      if (turn?.type !== "turnSummary") return;
      const forked = await opened.client.call({
        type: "session.fork",
        payload: {
          sessionId: workId,
          turnId: turn.stats.turnId,
          target: { agentId: "genet", workspaceId: agentSpace.id, modelId: MODEL },
        },
      });
      t.assertions.assert(
        forked?.type === "session" && forked.data.kind === "normal" && forked.data.work === undefined,
        `fork preserved managed role: ${JSON.stringify(forked)}`,
      );

      const ordinary = await opened.client.call({
        type: "session.create",
        payload: {
          workspaceId: agentSpace.id,
          agentId: "genet",
          modelId: MODEL,
          modeId: null,
          title: "User inquiry",
          cwd: null,
        },
      });
      t.assertions.assert(
        ordinary?.type === "session" && ordinary.data.kind === "normal",
        "the user could not open an ordinary conversation in the Agent Space",
      );

      // Every Workflow, including bugfix, must persist an outcome and
      // acceptance criteria before it may create a WorkPackage. Exercise the
      // fail-closed pre-Intent path first, then prove revision one unlocks a
      // final package through the public CLI.
      const siblingPreIntentCommand = [
        '"$GENEHUB_CLI" pm project workflow select --graph bugfix',
        'if "$GENEHUB_CLI" pm project package put --id sibling-preintent --title "Pre-intent package" --outcome "Must be rejected without acceptance criteria" --space-tag gameplay --repository game --branch work/gameplay --node fix; then exit 76; fi',
        '"$GENEHUB_CLI" pm project intent set --outcome "Deliver the accepted bugfix package" --acceptance "The final package remains dispatchable under revision one"',
        '"$GENEHUB_CLI" pm project workflow transition --edge aligned --fact intent.aligned',
        '"$GENEHUB_CLI" pm project package put --id sibling-preintent --title "Accepted bugfix package" --outcome "Remain dispatchable under the persisted Intent" --space-tag gameplay --repository game --branch work/gameplay --node fix',
        '"$GENEHUB_CLI" pm project workflow status > pm-sibling-preintent-status.json',
      ].join(" && ");
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: siblingPreIntentCommand } } },
        { text: "无验收标准的派工已被拒绝；revision 1 下的最终工作包保持可派发。" },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        duplicatePmId,
        "先验证无验收标准时不能派工，再建立 revision 1 并绑定最终 bugfix 工作包。",
      );
      let siblingPreIntentSnapshot: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(
        async () => {
          siblingPreIntentSnapshot = await opened.client.call({
            type: "session.get",
            payload: { sessionId: duplicatePmId },
          });
          return siblingPreIntentSnapshot?.type === "snapshot" &&
            siblingPreIntentSnapshot.data.summary.status === "idle" &&
            siblingPreIntentSnapshot.data.items.filter((item) => item.type === "turnSummary").length >= 2;
        },
        30_000,
      );
      const siblingPreIntentStatusPath = `${t.env.workspace}/spaces/pm/pm-sibling-preintent-status.json`;
      const siblingPreIntentStatus = existsSync(siblingPreIntentStatusPath)
        ? JSON.parse(readFileSync(siblingPreIntentStatusPath, "utf8")) as {
            data?: {
              run?: { intent?: { revision?: number } };
              workPackages?: Array<{ id?: string; status?: string; blockReason?: string | null }>;
            };
          }
        : undefined;
      const siblingPreIntentPackage = siblingPreIntentStatus?.data?.workPackages?.find(
        (item) => item.id === "sibling-preintent",
      );
      t.assertions.assert(
        siblingPreIntentSnapshot?.type === "snapshot" &&
          siblingPreIntentStatus?.data?.run?.intent?.revision === 1 &&
          siblingPreIntentPackage?.status === "planned" &&
          !siblingPreIntentPackage.blockReason,
        `the Intent gate did not reject then unlock the final package: snapshot=${JSON.stringify(siblingPreIntentSnapshot)} status=${JSON.stringify(siblingPreIntentStatus)}`,
      );

      // Exercise the failed-review retry path through the real daemon, CLI,
      // ACP adapter and supervisor. The immutable failed package keeps its
      // evidence, while a new package in the same PM Session and exact Git
      // lineage may reuse the now-idle implementation Space.
      const implementationWorktree = `${t.env.workspace}/worktrees/implementation/game`;
      const fixtureProcessesBeforeManagedPair = activeFixtureAgentPids(t.env.root).length;
      writeFileSync(
        `${implementationWorktree}/fixture-candidate.txt`,
        "candidate that requires one bounded review correction\n",
      );
      execFileSync("git", ["add", "fixture-candidate.txt"], { cwd: implementationWorktree });
      execFileSync("git", ["commit", "-qm", "Create failed-review fixture candidate"], {
        cwd: implementationWorktree,
      });

      const createFailedCandidate = [
        '"$GENEHUB_CLI" pm project package transition --id sibling-preintent --to cancelled',
        '"$GENEHUB_CLI" pm project package put --id failed-review-original --title "Failed review original" --outcome "Preserve a failed independent review" --space-tag gameplay --repository game --branch work/gameplay --node fix',
        '"$GENEHUB_CLI" pm project package transition --id failed-review-original --to ready',
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package failed-review-original --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"`,
      ].join(" && ");
      const dispatchFailedReview =
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${reviewSpace.id} --work-package failed-review-original --no-wait "GENEHUB_FIXTURE_REVIEW_FAIL"`;
      const bindReworkPackage = [
        '"$GENEHUB_CLI" pm project workflow transition --edge review-rework --fact review.rework.ready',
        '"$GENEHUB_CLI" pm project package put --id failed-review-retry --title "Failed review retry" --outcome "Apply the bounded reviewer correction" --space-tag gameplay --repository game --branch work/gameplay --node fix',
      ].join(" && ");
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: createFailedCandidate } } },
        { text: "The implementation fixture is dispatched; the supervisor owns candidate observation." },
        { tool: { name: "bash", arguments: { command: dispatchFailedReview } } },
        { text: "The independent review fixture is dispatched." },
        { tool: { name: "bash", arguments: { command: bindReworkPackage } } },
        { text: "The bounded rework package preserves and reuses the exact failed lineage." },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        duplicatePmId,
        "执行一次独立评审失败，并绑定精确沿袭的返工包。",
      );

      let reworkStatus: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        reworkStatus = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return reworkStatus?.type === "projectStatus" &&
          reworkStatus.data.workPackages.some(
            (item) => item.id === "failed-review-retry" && item.status === "planned",
          );
      }, 60_000);
      const reviewDispatchWake = await opened.client.call({
        type: "session.get",
        payload: { sessionId: duplicatePmId },
      });
      const reviewDispatchPrompt =
        reviewDispatchWake?.type === "snapshot"
          ? reviewDispatchWake.data.items.find(
              (item) =>
                item.type === "userMessage" &&
                item.text.includes("动作=派发独立评审") &&
                item.text.includes(`reviewWorkspace=${reviewSpace.id}`) &&
                item.text.includes("`review` 是真实 `actor: reviewer` 活动"),
            )
          : undefined;
      t.assertions.assert(
        reviewDispatchPrompt !== undefined,
        `the public supervisor event did not give the PM an unambiguous independent-review dispatch target: ${JSON.stringify(reviewDispatchWake)}`,
      );
      const reworkRun =
        reworkStatus?.type === "projectStatus"
          ? reworkStatus.data.workflowRuns.find(
              (item) => item.controllerSessionId === duplicatePmId,
            )
          : undefined;
      const failedOriginal =
        reworkStatus?.type === "projectStatus"
          ? reworkStatus.data.workPackages.find((item) => item.id === "failed-review-original")
          : undefined;
      const failedReviewSnapshot = failedOriginal?.reviewSessionId
        ? await opened.client.call({
            type: "session.get",
            payload: { sessionId: failedOriginal.reviewSessionId },
          })
        : undefined;
      await t.tools.waitUntil(
        () => activeFixtureAgentPids(t.env.root).length <= fixtureProcessesBeforeManagedPair,
        10_000,
      );
      const retryPackage =
        reworkStatus?.type === "projectStatus"
          ? reworkStatus.data.workPackages.find((item) => item.id === "failed-review-retry")
          : undefined;
      t.assertions.assert(
        reworkStatus?.type === "projectStatus" &&
          failedOriginal?.status === "cancelled" &&
          failedOriginal.reviewVerdict === "fail" &&
          Boolean(failedOriginal.workSessionId) &&
          Boolean(failedOriginal.reviewSessionId) &&
          failedOriginal.workSessionId !== failedOriginal.reviewSessionId &&
          failedReviewSnapshot?.type === "snapshot" &&
          failedReviewSnapshot.data.summary.work?.workflowPrompt?.includes(
            '"schema": "genehub-pm-review-context.v1"',
          ) === true &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            '"id": "failed-review-original"',
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            '"outcome": "Preserve a failed independent review"',
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            '"acceptance": [',
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            "共享聚合入口会随兄弟包合入而变化",
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            "至少包含一种目标类型和一种兄弟类型的混合 fixture",
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            "Managed implementation contract part 1/1: GENEHUB_FIXTURE_CANDIDATE_READY",
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            `"commit": "${failedOriginal.candidateCommit}"`,
          ) &&
          failedReviewSnapshot.data.summary.work.workflowPrompt.includes(
            `"tree": "${failedOriginal.candidateTree}"`,
          ) &&
          activeFixtureAgentPids(t.env.root).length <= fixtureProcessesBeforeManagedPair &&
          retryPackage?.status === "planned" &&
          retryPackage.agentSpace === "implementation" &&
          retryPackage.repository === failedOriginal.repository &&
          retryPackage.branch === failedOriginal.branch &&
          reworkRun?.activeNodes.includes("fix") === true &&
          reworkRun.nodeInstances.some(
            (instance) => instance.nodeId === "fix" && instance.iteration === 2,
          ) &&
          reworkRun.teamSlots.find(
            (slot) => slot.workPackageId === "failed-review-original",
          )?.status === "cancelled" &&
          reworkRun.teamSlots.find(
            (slot) => slot.workPackageId === "failed-review-original",
          )?.workSessionId == null,
        `failed-review rework did not preserve exact evidence and lineage: ${JSON.stringify(reworkStatus)}`,
      );

      // The project projection can expose the newly bound rework package a
      // few milliseconds before the supervisor-owned PM turn that created it
      // has written its terminal event. Do not race a second user instruction
      // into that still-running public Session.
      await t.tools.waitUntil(async () => {
        const snapshot = await opened.client.call({
          type: "session.get",
          payload: { sessionId: duplicatePmId },
        });
        return (
          snapshot?.type === "snapshot" &&
          snapshot.data.summary.status === "idle" &&
          snapshot.data.items.filter((item) => item.type === "turnSummary")
            .length >= 5
        );
      }, 30_000);

      // Exercise the complete project-owned Workflow template migration
      // through public PM/user surfaces. The old baseline remains usable;
      // preparation creates only an inert bundle. A real settled Reviewer
      // WorkSession from the verified review-only Space binds the digest,
      // then the authenticated user approves before transactional promotion.
      const oldTemplateMarker = {
        schema: "genehub-pm-space-template.v1",
        version: "2",
        contentDigest: "fixture-old-template",
      };
      writeFileSync(
        `${t.env.workspace}/spaces/pm/template.json`,
        `${JSON.stringify(oldTemplateMarker, null, 2)}\n`,
      );
      execFileSync("git", ["add", "spaces/pm/template.json"], { cwd: t.env.workspace });
      execFileSync("git", ["commit", "-qm", "Pin the previous PM template baseline"], {
        cwd: t.env.workspace,
      });
      const templateSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: t.env.workspace,
        encoding: "utf8",
      }).trim();
      const outdatedTemplate = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId, sessionId: duplicatePmId },
      });
      t.assertions.assert(
        outdatedTemplate?.type === "projectStatus" &&
          outdatedTemplate.data.template.upgradeAvailable &&
          outdatedTemplate.data.template.installedVersion === "2",
        `the optional template migration was not reported: ${JSON.stringify(outdatedTemplate)}`,
      );

      let improvementCommandSequence = 0;
      const runImprovementCommand = async (command: string, prompt: string) => {
        const terminals = terminalCount(siblingEvents);
        const completions = completedCount(siblingEvents);
        const successMarker = `${t.env.root}/pm-improvement-command-${++improvementCommandSequence}.ok`;
        const verifiedCommand = `${command} && printf 'ok\\n' > "${successMarker}"`;
        opened.mock.script(
          { tool: { name: "bash", arguments: { command: verifiedCommand } } },
          { text: "Workflow 改进治理操作已完成。" },
        );
        await t.flows.main.sendPrompt(opened.client, duplicatePmId, prompt);
        await t.tools.waitUntil(
          () => terminalCount(siblingEvents) === terminals + 1,
          30_000,
        );
        t.assertions.assert(
          completedCount(siblingEvents) === completions + 1 &&
            existsSync(successMarker) &&
            readFileSync(successMarker, "utf8") === "ok\n",
          `Workflow 改进命令未成功退出：${command} events=${eventTrace(siblingEvents)}`,
        );
        rmSync(successMarker, { force: true });
      };
      await runImprovementCommand(
        [
          `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${templateSourceCommit} --tag gameplay --tag webgl2`,
          `"$GENEHUB_CLI" pm project space record --name review --purpose "Independently review gameplay candidates" --path spaces/review --workspace ${reviewSpace.id} --commit ${templateSourceCommit} --role review --tag gameplay`,
        ].join(" && "),
        "项目基线提交后，重新核验并记录两个 Agent Space 的精确来源锁。",
      );
      await runImprovementCommand(
        '"$GENEHUB_CLI" pm project improvement prepare-template --id fixture-template-v3',
        "生成一个惰性的模板迁移 bundle，不要覆盖活动 Workflow。",
      );
      const bundleReviewPrompt = `${t.env.workspace}/spaces/pm/workflow-candidates/fixture-template-v3/bundle/skills/project-workflow/prompts/review.md`;
      writeFileSync(
        bundleReviewPrompt,
        `${readFileSync(bundleReviewPrompt, "utf8")}\n项目自定义：Reviewer 必须给出中文验收影响。\n`,
      );
      await runImprovementCommand(
        '"$GENEHUB_CLI" pm project improvement propose --id fixture-template-v3 --target bundle --rationale "迁移模板且保留项目中文评审方法"',
        "把完整 bundle 的活动基线和候选摘要提交治理，不执行晋级。",
      );
      const proposedTemplate = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId, sessionId: duplicatePmId },
      });
      const proposedCandidate = proposedTemplate?.type === "projectStatus"
        ? proposedTemplate.data.improvementCandidates.find(
            (candidate) => candidate.id === "fixture-template-v3",
          )
        : undefined;
      t.assertions.assert(
        proposedCandidate?.status === "proposed" && Boolean(proposedCandidate.candidateDigest),
        `template migration proposal did not expose an exact digest: ${JSON.stringify(proposedTemplate)}`,
      );

      // Keep the CLI receipt outside the project Git root. Redirection creates
      // the file before `agent run` performs its exact-source cleanliness
      // check, so placing it under the project would correctly invalidate the
      // recorded human-owned Agent Space sources.
      const improvementReviewOutput = `${t.env.root}/pm-template-review-session.json`;
      const dispatchImprovementReview =
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${reviewSpace.id} ` +
        `--improvement fixture-template-v3 --no-wait "GENEHUB_FIXTURE_REVIEW_PASS" > ${improvementReviewOutput}`;
      await runImprovementCommand(
        dispatchImprovementReview,
        "在已验证的 review-only Agent Space 中派发绑定精确 bundle 摘要的独立 Reviewer。",
      );
      const improvementReviewReplies = readFileSync(improvementReviewOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{
          type?: string;
          data?: { sessionId?: string; status?: string; waited?: boolean };
        }>;
      const createdImprovementReview = improvementReviewReplies.find(
        (reply) => reply.type === "session.created",
      );
      const runningImprovementReview = improvementReviewReplies.find(
        (reply) => reply.type === "session.result",
      );
      const improvementReviewSessionId = createdImprovementReview?.data?.sessionId;
      t.assertions.assert(
        improvementReviewReplies.length === 2 &&
          Boolean(improvementReviewSessionId) &&
          runningImprovementReview?.data?.sessionId === improvementReviewSessionId &&
          runningImprovementReview?.data?.status === "running" &&
          runningImprovementReview?.data?.waited === false,
        `Workflow 改进 Reviewer 没有返回一致的非阻塞 WorkSession 事件：${JSON.stringify(improvementReviewReplies)}`,
      );
      let improvementReviewSnapshot: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        improvementReviewSnapshot = await opened.client.call({
          type: "session.get",
          payload: { sessionId: improvementReviewSessionId! },
        });
        return (
          improvementReviewSnapshot?.type === "snapshot" &&
          !["running", "waiting"].includes(improvementReviewSnapshot.data.summary.status)
        );
      }, 30_000);
      t.assertions.assert(
        improvementReviewSnapshot?.type === "snapshot" &&
          improvementReviewSnapshot.data.summary.kind === "work" &&
          improvementReviewSnapshot.data.summary.work?.improvementCandidateId ===
            "fixture-template-v3" &&
          improvementReviewSnapshot.data.summary.work?.improvementCandidateDigest ===
            proposedCandidate?.candidateDigest &&
          improvementReviewSnapshot.data.summary.work?.workflowPrompt?.includes(
            "项目自定义：Reviewer 必须给出中文验收影响。",
          ),
        `Reviewer WorkSession 未绑定精确中文 bundle：${JSON.stringify(improvementReviewSnapshot)}`,
      );
      await runImprovementCommand(
        `"$GENEHUB_CLI" pm project improvement review --id fixture-template-v3 --session ${improvementReviewSessionId} --evidence "review-only Space 已核对精确摘要绑定的整包图、提示词、evaluation 和回滚边界" --pass`,
        "登记独立 Reviewer 对精确 bundle 摘要的评审结论。",
      );
      const approvedTemplate = await opened.client.call({
        type: "pm.improvement.approve",
        payload: {
          workspaceId: opened.workspaceId,
          sessionId: duplicatePmId,
          candidateId: "fixture-template-v3",
          approved: true,
        },
      });
      t.assertions.assert(
        approvedTemplate?.type === "projectStatus" &&
          approvedTemplate.data.improvementCandidates.some(
            (candidate) => candidate.id === "fixture-template-v3" && candidate.status === "approved",
          ),
        `user approval did not bind the template candidate: ${JSON.stringify(approvedTemplate)}`,
      );
      await runImprovementCommand(
        '"$GENEHUB_CLI" pm project improvement promote --id fixture-template-v3',
        "晋级用户已批准且独立评审通过的精确 bundle。",
      );
      const promotedTemplate = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId, sessionId: duplicatePmId },
      });
      t.assertions.assert(
        promotedTemplate?.type === "projectStatus" &&
          !promotedTemplate.data.template.upgradeAvailable &&
          promotedTemplate.data.improvementCandidates.some(
            (candidate) =>
              candidate.id === "fixture-template-v3" &&
              candidate.status === "promoted" &&
              Boolean(candidate.promotedCommit),
          ) &&
          readFileSync(
            `${t.env.workspace}/spaces/pm/skills/project-workflow/prompts/review.md`,
            "utf8",
          ).includes("项目自定义") &&
          execFileSync("git", ["status", "--porcelain"], {
            cwd: t.env.workspace,
            encoding: "utf8",
          }).trim() === "",
        `template bundle was not promoted cleanly: ${JSON.stringify(promotedTemplate)}`,
      );

      // Reproduce the real Qwen failure where a candidate became dirty after
      // independent acceptance but before deterministic integration. The
      // fault is injected through the real filesystem while the daemon is
      // processing the public Reviewer result; the oracle is only the public
      // PM project projection. A pre-integration verification failure must be
      // durable evidence and must move the Run out of integrate instead of
      // being retried every supervisor sample.
      const integrationCandidatePath =
        implementationWorktree + "/integration-candidate.txt";
      writeFileSync(
        integrationCandidatePath,
        "accepted candidate for integration fault coverage\n",
      );
      execFileSync("git", ["add", "integration-candidate.txt"], {
        cwd: implementationWorktree,
      });
      execFileSync("git", ["commit", "-qm", "Create integration fault fixture candidate"], {
        cwd: implementationWorktree,
      });
      const createIntegrationCandidate = [
        '"$GENEHUB_CLI" pm project package transition --id failed-review-retry --to cancelled',
        '"$GENEHUB_CLI" pm project package put --id integration-dirty --title "Dirty integration candidate" --outcome "Persist final candidate verification failure" --space-tag gameplay --repository game --branch work/gameplay --node fix',
        '"$GENEHUB_CLI" pm project package transition --id integration-dirty --to ready',
        '"$GENEHUB_CLI" agent run --agent ' +
          workAgentId +
          " --workspace " +
          agentSpace.id +
          ' --work-package integration-dirty --no-wait "GENEHUB_FIXTURE_CANDIDATE_READY"',
      ].join(" && ");
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: createIntegrationCandidate } } },
        { text: "The integration fault fixture implementation is dispatched." },
      );
      await t.flows.main.sendPrompt(
        opened.client,
        duplicatePmId,
        "为集成故障覆盖创建一个可独立评审的候选。",
      );
      let integrationCandidateStatus:
        | Awaited<ReturnType<typeof opened.client.call>>
        | undefined;
      await t.tools.waitUntil(async () => {
        integrationCandidateStatus = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return (
          integrationCandidateStatus?.type === "projectStatus" &&
          integrationCandidateStatus.data.workPackages.some(
            (item) => item.id === "integration-dirty" && item.status === "candidate",
          )
        );
      }, 45_000);

      const dirtyArtifact =
        implementationWorktree + "/reviewer-side-effect.tmp";
      try {
        // The public Candidate projection can become visible a few
        // milliseconds before the Supervisor wake that observed it settles.
        // Wait for the PM Session itself to become idle before scripting and
        // sending the explicit Reviewer-dispatch instruction, otherwise the
        // script can be consumed by that wake or session.send correctly
        // rejects the overlapping turn.
        await t.tools.waitUntil(async () => {
          const snapshot = await opened.client.call({
            type: "session.get",
            payload: { sessionId: duplicatePmId },
          });
          return snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle";
        }, 30_000);
        const dispatchPassingReview =
          '"$GENEHUB_CLI" agent run --agent ' +
          workAgentId +
          " --workspace " +
          reviewSpace.id +
          ' --work-package integration-dirty --no-wait "GENEHUB_FIXTURE_DELAYED_REVIEW_PASS"';
        opened.mock.script(
          { tool: { name: "bash", arguments: { command: dispatchPassingReview } } },
          { text: "The independent passing Reviewer is dispatched." },
        );
        await t.flows.main.sendPrompt(
          opened.client,
          duplicatePmId,
          "为集成故障夹具派发独立 Reviewer。",
        );
        await t.tools.waitUntil(async () => {
          const sessions = await opened.client.call({
            type: "session.list",
            payload: { workspaceId: reviewSpace.id, includeArchived: true },
          });
          return (
            sessions?.type === "sessions" &&
            sessions.data.some(
              (session) =>
                session.kind === "work" &&
                session.work?.workPackageId === "integration-dirty",
            )
          );
        }, 10_000);
        writeFileSync(
          dirtyArtifact,
          "simulated post-review-authorization filesystem side effect\n",
        );

        let awaitingDeliveryDecision:
          | Awaited<ReturnType<typeof opened.client.call>>
          | undefined;
        await t.tools.waitUntil(async () => {
          awaitingDeliveryDecision = await opened.client.call({
            type: "pm.project.status",
            payload: { workspaceId: opened.workspaceId },
          });
          const run = awaitingDeliveryDecision?.type === "projectStatus"
            ? awaitingDeliveryDecision.data.workflowRuns.find(
                (item) => item.controllerSessionId === duplicatePmId,
              )
            : undefined;
          return Boolean(
            run?.activeNodes.includes("approve-delivery") &&
              run.availableEdges.some(
                (edge) => edge.id === "delivery-approved" && edge.satisfied,
              ),
          );
        }, 15_000);
        const deliveryRun = awaitingDeliveryDecision?.type === "projectStatus"
          ? awaitingDeliveryDecision.data.workflowRuns.find(
              (item) => item.controllerSessionId === duplicatePmId,
            )
          : undefined;
        if (!deliveryRun) {
          throw new Error("the reviewed bugfix Run disappeared before user delivery approval");
        }
        const approvedDelivery = await opened.client.call({
          type: "pm.workflow.transition",
          payload: {
            workspaceId: opened.workspaceId,
            sessionId: duplicatePmId,
            edgeId: "delivery-approved",
            expectedRevision: deliveryRun.revision,
            facts: [],
          },
        });
        t.assertions.assert(
          approvedDelivery?.type === "projectStatus",
          `explicit delivery approval did not return project status: ${JSON.stringify(approvedDelivery)}`,
        );

        let failedIntegration:
          | Awaited<ReturnType<typeof opened.client.call>>
          | undefined;
        await t.tools.waitUntil(async () => {
          failedIntegration = await opened.client.call({
            type: "pm.project.status",
            payload: { workspaceId: opened.workspaceId },
          });
          const packageStatus =
            failedIntegration?.type === "projectStatus"
              ? failedIntegration.data.workPackages.find(
                  (item) => item.id === "integration-dirty",
                )
              : undefined;
          return Boolean(packageStatus?.integrationError);
        }, 45_000);
        const failedPackage =
          failedIntegration?.type === "projectStatus"
            ? failedIntegration.data.workPackages.find(
                (item) => item.id === "integration-dirty",
              )
            : undefined;
        const failedRun =
          failedIntegration?.type === "projectStatus"
            ? failedIntegration.data.workflowRuns.find(
                (item) => item.controllerSessionId === duplicatePmId,
              )
            : undefined;
        t.assertions.assert(
          existsSync(dirtyArtifact) &&
            failedPackage?.status === "accepted" &&
            failedPackage.integrationError?.includes(
              "candidate worktree is not clean",
            ) === true &&
            failedRun?.activeNodes.includes("prepare-recovery") === true &&
            !failedRun.activeNodes.includes("integrate"),
          "pre-integration verification failure was not durable workflow evidence: " +
            "dirtyArtifact=" +
            existsSync(dirtyArtifact) +
            " status=" +
            JSON.stringify(failedIntegration),
        );
      } finally {
        rmSync(dirtyArtifact, { force: true });
      }

      // Keep several ordinary Agent runtimes live, then stop the real daemon
      // through its public CLI. This is deliberately different from the
      // managed-result assertion above: an interrupted/failed journey reaches
      // daemon shutdown while some Workers or Reviewers are still active, and
      // those processes must be drained before the CLI's cooperative stop
      // window expires rather than being orphaned onto init.
      const shutdownBaseline = new Set(activeFixtureAgentPids(t.env.root));
      const shutdownEvents: Array<Array<{ type?: string; raw: unknown }>> = [];
      for (let index = 0; index < 4; index += 1) {
        const created = await opened.client.call({
          type: "session.create",
          payload: {
            workspaceId: opened.workspaceId,
            agentId: workAgentId,
            modelId: null,
            modeId: null,
            title: `Shutdown fixture ${index + 1}`,
            cwd: null,
          },
        });
        t.assertions.assert(
          created?.type === "session",
          `shutdown fixture session.create returned ${created?.type}`,
        );
        if (created?.type !== "session") continue;
        const events = await t.flows.main.attachEventLog(opened.client, created.data.id);
        shutdownEvents.push(events);
        await t.flows.main.sendPrompt(
          opened.client,
          created.data.id,
          "GENEHUB_FIXTURE_CANDIDATE_READY",
        );
      }
      await t.tools.waitUntil(
        () => shutdownEvents.every((events) => terminalCount(events) === 1),
        20_000,
      );
      const shutdownOwned = activeFixtureAgentPids(t.env.root).filter(
        (pid) => !shutdownBaseline.has(pid),
      );
      t.assertions.assert(
        shutdownOwned.length === shutdownEvents.length && shutdownOwned.length === 4,
        `the shutdown fixture did not leave four live Agent runtimes: ${JSON.stringify(shutdownOwned)}`,
      );

      opened.client.close();
      const shutdownStartedAt = Date.now();
      const stopReply = JSON.parse(
        execFileSync(opened.daemon.genet, ["daemon", "stop"], {
          env: opened.daemon.env,
          encoding: "utf8",
        }),
      ) as { stopped?: boolean; running?: boolean; forced?: boolean };
      const shutdownMs = Date.now() - shutdownStartedAt;
      await t.tools.waitUntil(
        () =>
          shutdownOwned.every((pid) => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          }),
        5_000,
      );
      t.assertions.assert(
        stopReply.stopped === true &&
          stopReply.running === false &&
          stopReply.forced === false &&
          shutdownMs < 10_000,
        `daemon shutdown did not remain cooperative: reply=${JSON.stringify(stopReply)} durationMs=${shutdownMs}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

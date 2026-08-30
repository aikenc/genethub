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
      execFileSync("git", ["add", ".gitignore", "spaces/pm", "spaces/implementation", "skills/project-contract"], {
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
        '"$GENEHUB_CLI" pm project advance --to topology-verified',
      ].join(" && ");
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: initializeCommand } } },
        { text: "The local Git project and implementation Agent Space are verified." },
      );
      const terminalsBeforeInitialization = terminalCount(pmEvents);
      const completionsBeforeInitialization = completedCount(pmEvents);
      await t.flows.main.sendPrompt(opened.client, pm.id, "Initialize the local project and implementation topology.");
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
              command: '"$GENEHUB_CLI" workspace register-agent-space spaces/implementation/implementation.code-workspace',
            },
          },
        },
        { text: "The implementation Agent Space is registered." },
      );
      const terminalsBeforeRegistration = terminalCount(pmEvents);
      const completionsBeforeRegistration = completedCount(pmEvents);
      await t.flows.main.sendPrompt(opened.client, pm.id, "Register the implementation Agent Space.");
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
      t.assertions.assert(agentSpace !== undefined, "the PM CLI did not register an Agent Space");
      if (!agentSpace) return;
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
        "Reuse the project's already-registered implementation Agent Space idempotently.",
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
      await t.flows.main.sendPrompt(opened.client, pm.id, "Record the Space and activate the gameplay package.");
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
      await t.flows.main.sendPrompt(opened.client, pm.id, "Prove that Agent Space drift fails closed before dispatch.");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === driftTerminals + 1, 15_000);
      writeFileSync(manifestAbsolutePath, manifestBeforeDrift);
      const driftResultPath = `${t.env.workspace}/spaces/pm/${driftResult}`;
      t.assertions.assert(
        completedCount(pmEvents) === driftCompletions + 1 &&
          existsSync(driftResultPath) &&
          /Builder verification|PB017|changed/i.test(readFileSync(driftResultPath, "utf8")),
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
        "Prove that uncommitted root Provider source fails closed before dispatch.",
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
        "Prove that a committed Provider Skill cannot be re-recorded against a stale Builder lock.",
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
                `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${restoredSourceCommit} --tag gameplay --tag webgl2`,
              ].join(" && "),
            },
          },
        },
        { text: "The restored Provider source and Builder lock are recorded again." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "Restore the verified Agent Space evidence.");
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
        "Prove that a rejected WorkAgent cwd releases its reservation atomically.",
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
      await t.flows.main.sendPrompt(opened.client, pm.id, "Start the gameplay WorkAgent.");

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
      const atomicallyBound = JSON.parse(readFileSync(`${t.env.data}/pm-projects/${opened.workspaceId}.json`, "utf8")) as {
        workPackages?: Record<string, { status?: string; workSessionId?: string }>;
      };
      t.assertions.assert(
        atomicallyBound.workPackages?.["wp-gameplay"]?.status === "running" &&
          atomicallyBound.workPackages?.["wp-gameplay"]?.workSessionId === workId,
        `agent run did not atomically bind the WorkSession: ${JSON.stringify(atomicallyBound.workPackages?.["wp-gameplay"])}`,
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
      await t.flows.main.sendPrompt(opened.client, pm.id, "Bind the new WorkSession to its package.");
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
      await t.tools.waitUntil(() => {
        if (!existsSync(projectState)) return false;
        const state = JSON.parse(readFileSync(projectState, "utf8")) as {
          supervisor?: { wakePending?: boolean; wakeTurnId?: string };
        };
        return state.supervisor?.wakePending === true && Boolean(state.supervisor.wakeTurnId);
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

      const humanDecision = await opened.client.call({
        type: "pm.workflow.transition",
        payload: {
          workspaceId: opened.workspaceId,
          sessionId: pm.id,
          edgeId: "cancel",
          facts: [],
        },
      });
      t.assertions.assert(
        humanDecision?.type === "projectStatus" &&
          humanDecision.data.lifecycle === "active" &&
          humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.status === "cancelled" &&
          humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === pm.id)?.supervisor.mode ===
            "terminal" &&
          humanDecision.data.workflowRuns.find((item) => item.controllerSessionId === duplicatePmId)?.status ===
            "discussion" &&
          humanDecision.data.workPackages.find((item) => item.id === "wp-gameplay")?.status === "cancelled",
        `the user decision did not settle the failed attempt: ${JSON.stringify(humanDecision)}`,
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
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

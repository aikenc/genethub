import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync } from "node:fs";

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
      "a built-in PM uses the public CLI to initialize Git and Builder state, register a local Agent Space, and start a third-party-adapter WorkAgent in its DAG-bound worktree; users can observe and fork its WorkSession but cannot mutate either managed resource",
    catches: [
      "PM identity is trusted from request payload instead of the daemon child",
      "ordinary users can mutate WorkSessions or managed Agent Spaces",
      "PM-created WorkSessions are indistinguishable from ordinary conversations",
      "a PM blocks itself by omitting --no-wait while dispatching a WorkAgent",
      "multiline PM contracts are altered by shell expansion before reaching a WorkAgent",
      "the embedded Builder steals another process's active or stale build.lock",
      "a committed Provider Skill change can be re-recorded against a stale Builder lock",
      "a failed supervisor wake retries on every two-second sampler tick",
      "forking a WorkSession preserves its privileged role",
    ],
    tags: ["core", "authorization", "pm-agent-mvp"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 80_000,
    timeoutMs: 180_000,
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
          title: "Project manager",
        },
      });
      t.assertions.assert(createdPm?.type === "session", `pm.session.create returned ${createdPm?.type}`);
      if (createdPm?.type !== "session") return;
      const pm = createdPm.data;
      t.assertions.assert(pm.kind === "pm", `PM kind was ${pm.kind}`);
      t.assertions.assert(pm.capabilities?.archive === false && pm.capabilities.delete === false, "PM retention capabilities drifted");

      const duplicatePm = await opened.client.call({
        type: "pm.session.create",
        payload: { workspaceId: opened.workspaceId, modelId: MODEL, modeId: null, title: null },
      });
      t.assertions.assert(
        duplicatePm?.type === "session" && duplicatePm.data.id === pm.id,
        "the same Folder project minted a second PM session",
      );

      const pmEvents = await t.flows.main.attachEventLog(opened.client, pm.id);
      const initializeCommand = [
        "set -x",
        "exec > .genethub/pm-setup.log 2>&1",
        '"$GENEHUB_CLI" pm project init',
        '"$GENEHUB_CLI" pm project intent set --outcome "Deliver a controlled gameplay package" --acceptance "The WorkAgent session is observable, isolated, and PM-controlled"',
        "git init -q -b main",
        'git config user.name "GeneHub PM Fixture"',
        'git config user.email "pm-fixture@genehub.invalid"',
        "mkdir -p spaces repositories/game worktrees/implementation",
        "printf '%s\\n' '.genethub/' 'repositories/' 'worktrees/' 'spaces/*/.pipebuilder/' 'spaces/*/.agents/' 'spaces/*/.cursor/' 'spaces/*/.codebuddy/' 'spaces/*/.claude/' 'spaces/*/AGENTS.md' 'spaces/*/CLAUDE.md' > .gitignore",
        "git add .gitignore",
        'git commit -qm "Initialize PM project"',
        "git -C repositories/game init -q -b main",
        'git -C repositories/game config user.name "Fixture WorkAgent"',
        'git -C repositories/game config user.email "work-fixture@genehub.invalid"',
        "printf '%s\\n' '# Game baseline' > repositories/game/README.md",
        "git -C repositories/game add README.md",
        'git -C repositories/game commit -qm "Create business baseline"',
        'git -C repositories/game worktree add -q -b work/gameplay "$PWD/worktrees/implementation/game" main',
        '"$GENEHUB_CLI" pm project advance --to git-ready',
        '"$GENEHUB_CLI" agent-space init implementation',
        "mkdir -p skills/project-contract",
        "printf '%s\\n' '---' 'name: project-contract' 'description: Keep the gameplay contract deterministic.' '---' '' '# Project contract' '' 'Keep the game deterministic.' > skills/project-contract/SKILL.md",
        `printf '%s\\n' '{"schema":"pipespace.v1","name":"implementation","agents":["codex"],"skills":["project-contract"],"tags":[],"skillProviders":[{"type":"folder","path":"../../skills"}]}' > spaces/implementation/pipespace.json`,
        "mkdir -p spaces/implementation/.pipebuilder",
        `printf '{"pid":2147483647,"host":"%s","startedAt":"old"}\n' "$(tr -d '\r\n' < /etc/hostname)" > spaces/implementation/.pipebuilder/build.lock`,
        'if "$GENEHUB_CLI" agent-space build implementation --require-no-post-commands > .genethub/stale-builder-lock.json 2>&1; then exit 72; fi',
        "grep -q PB014 .genethub/stale-builder-lock.json || { cat .genethub/stale-builder-lock.json; exit 73; }",
        "test -f spaces/implementation/.pipebuilder/build.lock",
        "rm spaces/implementation/.pipebuilder/build.lock",
        "printf '%s\\n' '{\"folders\":[{\"name\":\"implementation\",\"path\":\".\"},{\"name\":\"game\",\"path\":\"../../worktrees/implementation/game\"}]}' > spaces/implementation/implementation.code-workspace",
        '"$GENEHUB_CLI" agent-space check implementation',
        '"$GENEHUB_CLI" agent-space explain implementation',
        '"$GENEHUB_CLI" agent-space build implementation --dry-run --require-no-post-commands',
        '"$GENEHUB_CLI" agent-space build implementation --require-no-post-commands',
        '"$GENEHUB_CLI" agent-space verify implementation',
        "git add spaces/implementation/pipespace.json spaces/implementation/implementation.code-workspace skills/project-contract/SKILL.md",
        'git commit -qm "Add implementation Agent Space"',
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
        `PM initialization left no Agent Space source: ${existsSync(`${t.env.workspace}/.genethub/pm-setup.log`) ? readFileSync(`${t.env.workspace}/.genethub/pm-setup.log`, "utf8") : "no setup log"}; snapshot=${JSON.stringify(initializationSnapshot)}`,
      );
      t.assertions.assert(
        existsSync(`${t.env.workspace}/spaces/implementation/.pipebuilder/lock.json`),
        `PM initialization left no Builder ownership lock: ${existsSync(`${t.env.workspace}/.genethub/pm-setup.log`) ? readFileSync(`${t.env.workspace}/.genethub/pm-setup.log`, "utf8") : "no setup log"}`,
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
          ? listedWorkspaces.data.find((workspace) => workspace.kind === "agentSpace")
          : undefined;
      t.assertions.assert(agentSpace !== undefined, "the PM CLI did not register an Agent Space");
      if (!agentSpace) return;
      t.assertions.assert(
        agentSpace.capabilities?.createSession === true &&
          agentSpace.capabilities.rename === false &&
          agentSpace.capabilities.remove === false,
        `unexpected Agent Space capabilities: ${JSON.stringify(agentSpace.capabilities)}`,
      );

      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: t.env.workspace,
        encoding: "utf8",
      }).trim();
      const activateCommand = [
        `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit ${sourceCommit}`,
        '"$GENEHUB_CLI" pm project advance --to workspaces-registered',
        '"$GENEHUB_CLI" pm project package put --id wp-gameplay --title "Gameplay package" --outcome "Produce the gameplay candidate" --space implementation --branch work/gameplay --worktree worktrees/implementation/game',
        '"$GENEHUB_CLI" pm project advance --to active',
        '"$GENEHUB_CLI" pm project package transition --id wp-gameplay --to ready',
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

      const publicProject = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(
        publicProject?.type === "projectStatus" &&
          publicProject.data.phase === "active" &&
          publicProject.data.agentSpaces[0]?.role === "implementation" &&
          publicProject.data.workPackages.some((item) => item.id === "wp-gameplay"),
        `public PM project projection drifted: ${JSON.stringify(publicProject)}`,
      );

      const driftTerminals = terminalCount(pmEvents);
      const driftCompletions = completedCount(pmEvents);
      const manifestPath = "spaces/implementation/pipespace.json";
      const driftResult = ".genethub/pm-space-drift-check.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: [
                `cp ${manifestPath} .genethub/pipespace.before-drift.json`,
                `printf '\n' >> ${manifestPath}`,
                `if "$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package wp-gameplay --no-wait "This dispatch must be rejected." > ${driftResult} 2>&1; then exit 71; fi`,
                `mv .genethub/pipespace.before-drift.json ${manifestPath}`,
              ].join(" && "),
            },
          },
        },
        { text: "Dispatch was rejected while the recorded Agent Space Builder identity drifted." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "Prove that Agent Space drift fails closed before dispatch.");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === driftTerminals + 1, 15_000);
      t.assertions.assert(
        completedCount(pmEvents) === driftCompletions + 1 &&
          existsSync(`${t.env.workspace}/${driftResult}`) &&
          /Builder verification|PB017|changed/i.test(readFileSync(`${t.env.workspace}/${driftResult}`, "utf8")),
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
      const sourceDriftResult = ".genethub/pm-project-source-drift-check.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: [
                "mkdir -p skills/uncommitted-provider",
                `printf '%s\\n' '---' 'name: uncommitted-provider' 'description: must invalidate recorded project evidence' '---' > skills/uncommitted-provider/SKILL.md`,
                `if "$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package wp-gameplay --no-wait "This dispatch must also be rejected." > ${sourceDriftResult} 2>&1; then exit 74; fi`,
                "rm skills/uncommitted-provider/SKILL.md",
                "rmdir skills/uncommitted-provider",
              ].join(" && "),
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
      t.assertions.assert(
        completedCount(pmEvents) === sourceDriftCompletions + 1 &&
          existsSync(`${t.env.workspace}/${sourceDriftResult}`) &&
          /PB017|ownership lock|planned artifacts|untracked|project source|source commit|differ/i.test(
            readFileSync(`${t.env.workspace}/${sourceDriftResult}`, "utf8"),
          ),
        `outer project source drift did not fail closed: ${eventTrace(pmEvents)}`,
      );

      const staleProviderTerminals = terminalCount(pmEvents);
      const staleProviderCompletions = completedCount(pmEvents);
      const staleProviderResult = ".genethub/pm-stale-provider-lock-check.log";
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: [
                "cp skills/project-contract/SKILL.md .genethub/project-contract.before",
                "printf '%s\\n' '---' 'name: project-contract' 'description: A changed contract that requires a rebuild.' '---' '' '# Changed contract' > skills/project-contract/SKILL.md",
                "git add skills/project-contract/SKILL.md",
                'git commit -qm "Change Provider Skill without rebuilding"',
                'staleSourceCommit="$(git rev-parse HEAD)"',
                `if "$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit "$staleSourceCommit" > ${staleProviderResult} 2>&1; then exit 75; fi`,
                `printf '%s\\n' 'stale-provider-rejected' >> ${staleProviderResult}`,
                "mv .genethub/project-contract.before skills/project-contract/SKILL.md",
                "git add skills/project-contract/SKILL.md",
                'git commit -qm "Restore Provider Skill fixture"',
                'restoredSourceCommit="$(git rev-parse HEAD)"',
                '"$GENEHUB_CLI" agent-space verify implementation',
                `"$GENEHUB_CLI" pm project space record --name implementation --purpose "Implement gameplay in an isolated worktree" --path spaces/implementation --workspace ${agentSpace.id} --commit "$restoredSourceCommit"`,
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
      const staleProviderOutput = existsSync(`${t.env.workspace}/${staleProviderResult}`)
        ? readFileSync(`${t.env.workspace}/${staleProviderResult}`, "utf8")
        : "missing stale Provider result";
      t.assertions.assert(
        completedCount(pmEvents) === staleProviderCompletions + 1 &&
          staleProviderOutput.includes("stale-provider-rejected"),
        `stale Provider lock was re-recorded: output=${staleProviderOutput} events=${eventTrace(pmEvents)}`,
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
        `"$GENEHUB_CLI" agent run --agent ${workAgentId} --workspace ${agentSpace.id} --work-package wp-gameplay --message - > .genethub/pm-work-dispatch.json <<'GENEHUB_PROMPT'`,
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
      const dispatchResult = `${t.env.workspace}/.genethub/pm-work-dispatch.json`;
      t.assertions.assert(
        existsSync(dispatchResult) && readFileSync(dispatchResult, "utf8").includes('"waited":false'),
        `PM dispatch was not forced non-blocking: ${existsSync(dispatchResult) ? readFileSync(dispatchResult, "utf8") : "missing CLI output"}`,
      );

      const bindTerminals = terminalCount(pmEvents);
      const bindCompletions = completedCount(pmEvents);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `"$GENEHUB_CLI" pm project package transition --id wp-gameplay --to running --session ${workId} > .genethub/pm-running-transition.json`,
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
                '"$GENEHUB_CLI" pm project package transition --id wp-gameplay --to cancelled && "$GENEHUB_CLI" pm project lifecycle --to completed',
            },
          },
        },
        { text: "The bounded supervisor retry safely closed the fixture project." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "Bind the new WorkSession to its package.");
      await t.tools.waitUntil(() => terminalCount(pmEvents) === bindTerminals + 1, 15_000);
      t.assertions.assert(
        completedCount(pmEvents) === bindCompletions + 1,
        `PM WorkSession binding turn failed: ${eventTrace(pmEvents)}`,
      );
      const runningTransition = `${t.env.workspace}/.genethub/pm-running-transition.json`;
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
      }, 15_000);
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
        | { updatedAtMs?: number; supervisor?: { wakePending?: boolean; wakeTurnId?: string; wakeRetryAtMs?: number } }
        | undefined;
      await t.tools.waitUntil(() => {
        if (!existsSync(projectState)) return false;
        failedWakeState = JSON.parse(readFileSync(projectState, "utf8")) as typeof failedWakeState;
        return (
          failedWakeState?.supervisor?.wakePending === true &&
          !failedWakeState.supervisor.wakeTurnId &&
          typeof failedWakeState.supervisor.wakeRetryAtMs === "number"
        );
      }, 15_000);
      const persistedRetryDelay =
        (failedWakeState?.supervisor?.wakeRetryAtMs ?? 0) - (failedWakeState?.updatedAtMs ?? 0);
      t.assertions.assert(
        persistedRetryDelay === 30_000,
        `first failed PM wake did not persist a 30-second retry: ${JSON.stringify(failedWakeState)}`,
      );
      const failedWakeObservedAt = Date.now();
      const requestsAfterFailedWake = opened.mock.requests.length;
      await t.tools.waitUntil(() => Date.now() - failedWakeObservedAt >= 5_000, 7_000);
      t.assertions.assert(
        opened.mock.requests.length === requestsAfterFailedWake,
        `failed PM supervisor wake retried on the two-second sampler: requests=${opened.mock.requests.length - requestsAfterFailedWake}`,
      );
      let completedAfterBackoff: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      await t.tools.waitUntil(async () => {
        completedAfterBackoff = await opened.client.call({
          type: "pm.project.status",
          payload: { workspaceId: opened.workspaceId },
        });
        return completedAfterBackoff?.type === "projectStatus" && completedAfterBackoff.data.lifecycle === "completed";
      }, 45_000);
      await t.tools.waitUntil(
        () => opened.mock.requests.length >= requestsAfterFailedWake + 2,
        15_000,
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

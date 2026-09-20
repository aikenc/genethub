import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

interface CliResult {
  status: number;
  envelope: Record<string, unknown>;
  data: Record<string, unknown>;
  text: string;
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fieldFromRequest(value: unknown, field: string): unknown {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = fieldFromRequest(value[index], field);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[field] !== undefined) return record[field];
    for (const child of Object.values(record).reverse()) {
      const found = fieldFromRequest(child, field);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  for (const candidate of [value, ...value.split("\n")]) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const found = fieldFromRequest(JSON.parse(trimmed) as unknown, field);
      if (found !== undefined) return found;
    } catch {
      // Tool output may contain diagnostics around the JSON envelope.
    }
  }
  const quoted = value.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
  if (quoted) return quoted[1];
  const numeric = value.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return numeric ? Number(numeric[1]) : undefined;
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

defineSpecialty(
  {
    id: "specialty.agent-space.workflow-package-build",
    title: "A Human-approved workflow build turns a cloned package into an authorized team",
    oracle:
      "cloning a Workflow package grants no authority: a normal Agent Session can materialize its Spaces only after the Human approves the daemon-issued build plan; rejection and direct CLI replay leave zero mutation, approval creates exactly five Builder-verified AgentSpaces under the package's own executor, and rebuilding the unchanged source is an identity-preserving no-op",
    catches: [
      "a cloned package directory is treated as authority to schedule Workers",
      "the specialty bypasses the Human and calls build apply as LocalUser",
      "ordinary chat or a copied CLI command is accepted as project-mutation authority",
      "rejecting the plan still leaves a partial AgentSpace tree",
      "the package is a daemon business constant rather than a directory the user cloned",
      "the five AgentSpaces are written but never Builder-verified or registered",
      "a repeated build creates duplicate Spaces or increments revisions",
      "a Worker Space that also mounts executor is mistaken for the package carrier",
    ],
    tags: ["core", "agent-space", "authorization", "workflow-package", "genet-cli", "workflow"],
    llm: { default: "mock" },
    expectedDurationMs: 45_000,
    timeoutMs: 180_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["agent", "daemon", "genet-cli", "workbench-client"],
    productInterfaces: [
      "request_user_input",
      "session.respondPermission",
      "genet workflow build",
      "genet workflow inspect",
    ],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      for (const [key, value] of [
        ["user.name", "Journey User"],
        ["user.email", "journey@example.com"],
        ["commit.gpgsign", "false"],
      ] as const) {
        const configured = spawnSync("git", ["config", "--global", key, value], {
          env: opened.daemon.env,
          encoding: "utf8",
        });
        t.assertions.assert(configured.status === 0, `could not configure isolated Git: ${configured.stderr}`);
      }

      const outer = path.join(opened.workspaceRoot, "outer-repository");
      mkdirSync(outer, { recursive: true });
      git(outer, ["init", "-q"], opened.daemon.env);
      git(outer, ["config", "user.name", "Outer Owner"], opened.daemon.env);
      git(outer, ["config", "user.email", "outer@example.com"], opened.daemon.env);
      git(outer, ["config", "commit.gpgsign", "false"], opened.daemon.env);
      writeFileSync(path.join(outer, ".gitignore"), "approve-project/\nreject-project/\n");
      writeFileSync(path.join(outer, "outer.txt"), "must remain byte-identical\n");
      git(outer, ["add", ".gitignore", "outer.txt"], opened.daemon.env);
      git(outer, ["commit", "-m", "outer baseline"], opened.daemon.env);
      const outerHead = git(outer, ["rev-parse", "HEAD"], opened.daemon.env);
      const outerIndex = git(outer, ["write-tree"], opened.daemon.env);
      const outerStatus = git(outer, ["status", "--porcelain=v1"], opened.daemon.env);

      const projects = new Map<string, { root: string; id: string }>();
      for (const marker of ["REJECT_BOOTSTRAP", "APPROVE_BOOTSTRAP"] as const) {
        const root = path.join(
          outer,
          marker === "REJECT_BOOTSTRAP" ? "reject-project" : "approve-project",
        );
        mkdirSync(root, { recursive: true });
        // The Agent's `git clone` step, performed by the fixture: cloning is
        // an ordinary command, not a platform capability.
        t.flows.main.clonePackage({ openRoot: t.openRoot, projectRoot: root });
        const reply = await opened.client.call({ type: "workspace.open", payload: { root } });
        t.assertions.assert(reply?.type === "workspace", `workspace.open failed for ${marker}`);
        projects.set(marker, { root, id: reply?.type === "workspace" ? reply.data.id : "" });
      }

      const stages = new Map<string, number>();
      let upgradeStage = 0;
      let blockerStage = 0;
      let bypassAttempted = false;
      let bypassRefused = false;
      let bypassDiagnostic = "";
      const respond = (request: unknown) => {
        const body = JSON.stringify(request);
        if (body.includes("你是小游戏项目的 Coder")) return { hang: true as const };
        if (body.includes("UPGRADE_BOOTSTRAP")) {
          const stage = upgradeStage++;
          if (stage === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow build --package game-delivery' } } };
          if (stage === 1) {
            const digest = fieldFromRequest(request, "planDigest");
            const revision = fieldFromRequest(request, "expectedRevision");
            if (typeof digest !== "string" || typeof revision !== "number") throw new Error("upgrade lost its bound management plan facts");
            return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow build --package game-delivery --apply --plan-digest ${shellArg(digest)} --revision ${revision} --action-id upgrade-authorized` } } };
          }
          return { text: "升级结果已回到原 PM。" };
        }
        if (body.includes("UPGRADE_BLOCKING_RUN")) {
          if (blockerStage++ === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow game-dev --task upgrade-conflict --message "等待母工作流升级" --no-wait' } } };
          return { text: "旧工作流仍在执行，由框架提供升级冲突和终止入口。" };
        }
        if (body.includes("AGENT_COMPONENT_BYPASS")) {
          if (bypassAttempted) {
            const code = fieldFromRequest(request, "code");
            const message = fieldFromRequest(request, "message");
            bypassDiagnostic = JSON.stringify({ code, message });
            bypassRefused = code === "forbidden" || (code === "unauthenticated" && message === "caller lacks the settings capability")
              || body.includes("approvalRequired");
            return { text: "直接修改结果已返回。" };
          }
          bypassAttempted = true;
          return {
            tool: {
              name: "bash",
              arguments: {
                command: '"$GENEHUB_CLI" space component set --component reviewer --revision 1',
              },
            },
          };
        }
        const marker = body.includes("REJECT_BOOTSTRAP")
          ? "REJECT_BOOTSTRAP"
          : body.includes("APPROVE_BOOTSTRAP")
            ? "APPROVE_BOOTSTRAP"
            : undefined;
        if (!marker) return { text: `unrecognized onboarding request: ${body.slice(-600)}` };
        if (body.includes("The user rejected the interrupted plan")) {
          return { text: "用户已拒绝接管；没有创建 Component 或 AgentSpace。" };
        }
        const stage = stages.get(marker) ?? 0;
        stages.set(marker, stage + 1);
        if (stage === 0) {
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space inspect' } } };
        }
        if (stage === 1) {
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow list' } } };
        }
        if (stage === 2) {
          return {
            tool: {
              name: "bash",
              arguments: { command: '"$GENEHUB_CLI" workflow build --package game-delivery' },
            },
          };
        }
        if (stage === 3) {
          const challengeId = fieldFromRequest(request, "challengeId");
          if (typeof challengeId !== "string") throw new Error(`plan omitted challengeId: ${body.slice(-3000)}`);
          return {
            tool: {
              name: "request_user_input",
              arguments: {
                questions: [
                  {
                    id: challengeId,
                    header: "接管项目",
                    question: "Agent authored text must not become authority",
                    options: [
                      { label: "yes", description: "agent option" },
                      { label: "no", description: "agent option" },
                    ],
                  },
                ],
              },
            },
          };
        }
        if (stage === 4) {
          const planDigest = fieldFromRequest(request, "planDigest");
          const revision = fieldFromRequest(request, "expectedRevision");
          if (typeof planDigest !== "string" || typeof revision !== "number") {
            throw new Error(`approved continuation lost plan facts: ${body.slice(-4000)}`);
          }
          return {
            tool: {
              name: "bash",
              arguments: {
                command: `"$GENEHUB_CLI" workflow build --package game-delivery --apply --plan-digest ${shellArg(
                  planDigest,
                )} --revision ${revision} --action-id bootstrap-approved && cat .pipebuilder/skills/project-manager/SKILL.md`,
              },
            },
          };
        }
        return { text: "PM 项目接管完成，团队和项目 Workflow 已就绪。" };
      };
      opened.mock.script(...Array.from({ length: 40 }, () => ({ respond })));

      const runInteraction = async (marker: string, optionId: "approve-once" | "reject") => {
        const project = projects.get(marker)!;
        const sessionId = await t.flows.main.createBuiltinSession(opened.client, project.id);
        const events = await t.flows.main.attachEventLog(opened.client, sessionId);
        await t.flows.main.sendPrompt(
          opened.client,
          sessionId,
          marker === "APPROVE_BOOTSTRAP"
            ? `${marker}: 搭建一套管线，用于开发小游戏。你会这么做？`
            : `${marker}: 请把这个普通空目录转换成 PM 驱动的小游戏项目`,
        );
        await t.tools.waitUntil(
          () =>
            events.some((event) => {
              const inner = t.flows.main.sessionEventOf(event);
              const request = inner?.request as { kind?: string } | undefined;
              return inner?.type === "permissionRequested" && request?.kind === "planApproval";
            }),
          120_000,
        );
        t.assertions.assert(!existsSync(path.join(project.root, "spaces")), "read-only plan materialized product Spaces");
        const requested = events.find((event) => {
          const inner = t.flows.main.sessionEventOf(event);
          const request = inner?.request as { kind?: string } | undefined;
          return inner?.type === "permissionRequested" && request?.kind === "planApproval";
        });
        const request = requested ? t.flows.main.sessionEventOf(requested)?.request : undefined;
        const requestId = (request as { id?: string; title?: string } | undefined)?.id;
        t.assertions.assert(
          (request as { title?: string } | undefined)?.title?.includes("建立执行团队") === true,
          "Workbench did not receive the daemon-authored plan title",
        );
        if (!requestId) throw new Error("PlanApproval omitted request id");
        const reply = await opened.client.call({
          type: "session.respondPermission",
          payload: { sessionId, requestId, outcome: { outcome: "selected", optionId } },
        });
        t.assertions.assert(reply?.type === "ack", `Human response failed: ${JSON.stringify(reply)}`);
        return { ...project, sessionId, events };
      };

      const rejected = await runInteraction("REJECT_BOOTSTRAP", "reject");
      await t.tools.waitUntil(
        () => rejected.events.filter((event) => event.type === "turnCompleted").length >= 1,
        120_000,
      );
      t.assertions.assert(!existsSync(path.join(rejected.root, "spaces")), "rejection left a partial team");
      t.assertions.assert(
        existsSync(path.join(rejected.root, ".genethub/workflows/game-delivery/workflow.md")),
        "rejection removed the cloned source; only authority was withheld",
      );

      const approveProject = projects.get("APPROVE_BOOTSTRAP")!;
      const cli = (args: string[]): CliResult => {
        const result = spawnSync(opened.daemon.genet, args, {
          cwd: approveProject.root,
          env: opened.daemon.env,
          encoding: "utf8",
        });
        let envelope: Record<string, unknown> = {};
        for (const line of result.stdout.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            envelope = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // Diagnostics are allowed around the one JSON answer.
          }
        }
        return {
          status: result.status ?? -1,
          envelope,
          data: (envelope.data ?? {}) as Record<string, unknown>,
          text: `${result.stdout}\n${result.stderr}`,
        };
      };

      // A cloned package is discoverable and compiles, yet owns nothing: its
      // Spaces are unbuilt and unregistered until a Human authorizes them.
      const available = cli(["workflow", "list", "--workspace", approveProject.id]);
      const packages = (available.data.packages ?? []) as Array<{
        id: string;
        built: boolean;
        compileError: string | null;
        spaces: Array<{ path: string; registered: boolean }>;
      }>;
      const discovered = packages.find((entry) => entry.id === "game-delivery");
      t.assertions.assert(
        available.status === 0 && !!discovered && !discovered.compileError,
        `cloned package is not discoverable or does not compile: ${available.text}`,
      );
      t.assertions.assert(
        discovered!.built === false && discovered!.spaces.every((space) => !space.registered),
        "a cloned package reported authority before any Human approved it",
      );
      const terminalPlan = cli([
        "workflow", "build", "--workspace", approveProject.id, "--package", "game-delivery",
      ]);
      const copied = cli([
        "workflow", "build", "--workspace", approveProject.id, "--package", "game-delivery", "--apply",
        "--plan-digest", String(terminalPlan.data.planDigest),
        "--revision", String(terminalPlan.data.expectedRevision),
        "--action-id", "copied-terminal-command",
      ]);
      t.assertions.assert(copied.status !== 0, "a copied LocalUser CLI command bypassed Session approval");
      t.assertions.assert(
        ((copied.envelope.error ?? {}) as Record<string, unknown>).code === "approvalRequired",
        `unapproved apply did not expose its stable failure code: ${copied.text}`,
      );
      t.assertions.assert(!existsSync(path.join(approveProject.root, "spaces")), "unapproved apply materialized product Spaces");

      const approved = await runInteraction("APPROVE_BOOTSTRAP", "approve-once");
      await t.tools.waitUntil(
        () => existsSync(path.join(approved.root, "spaces/game-delivery--executor/pipespace.json")),
        120_000,
      );
      await t.tools.waitUntil(
        () => approved.events.filter((event) => event.type === "turnCompleted").length >= 1,
        120_000,
      );

      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "workspace.list failed after bootstrap");
      const allSpaces = listed?.type === "workspaces" ? listed.data : [];
      // Product Space names carry the package prefix, which is exactly what
      // lets two packages own a Space of the same local name in one project.
      const names = ["executor", "coder", "reviewer", "workflow-manager", "workflow-reviewer"];
      const spaces = allSpaces.filter((space) =>
        names.some((name) => space.name === `game-delivery--${name}` || space.name === name),
      );
      t.assertions.assert(spaces.length === 5, `build did not create exactly five team Spaces: ${allSpaces.map((s) => s.name).join(",")}`);
      const byName = new Map(spaces.map((space) => [space.name.replace("game-delivery--", ""), space]));
      const executor = byName.get("executor")!;
      // Product directories carry the package prefix, which is what lets two
      // packages own a Space of the same name in one project.
      for (const name of ["executor", "coder", "reviewer", "workflow-manager", "workflow-reviewer"]) {
        t.assertions.assert(
          existsSync(path.join(approved.root, "spaces", `game-delivery--${name}`, ".pipebuilder", "lock.json")),
          `${name} was not Builder-verified`,
        );
      }
      t.assertions.assert(
        executor.agentSpace?.parentWorkspaceId === approveProject.id &&
          executor.agentSpace.components.some((component) => component.componentId === "executor"),
        "Executor is not the project scheduling boundary",
      );
      for (const name of ["coder", "reviewer", "workflow-manager", "workflow-reviewer"]) {
        t.assertions.assert(
          byName.get(name)?.agentSpace?.parentWorkspaceId === executor.id,
          `${name} is not a direct Executor child`,
        );
      }

      // Build writes only inside this project; it never initializes a
      // repository, so the enclosing one must be untouched byte for byte.
      t.assertions.assert(git(outer, ["rev-parse", "HEAD"], opened.daemon.env) === outerHead, "outer HEAD moved");
      t.assertions.assert(git(outer, ["write-tree"], opened.daemon.env) === outerIndex, "outer index changed");
      t.assertions.assert(git(outer, ["status", "--porcelain=v1"], opened.daemon.env) === outerStatus, "outer worktree changed");
      t.assertions.assert(readFileSync(path.join(outer, "outer.txt"), "utf8") === "must remain byte-identical\n", "outer file changed");

      const sessionList = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: approveProject.id, includeArchived: false },
      });
      const controller = sessionList?.type === "sessions"
        ? sessionList.data.find((session) => session.id === approved.sessionId)
        : undefined;
      if (!controller) throw new Error("approved PM Session disappeared before no-op replay");
      const built = cli(["workflow", "list", "--workspace", approveProject.id]);
      const builtPackage = ((built.data.packages ?? []) as Array<{
        id: string;
        built: boolean;
        drifted: boolean;
        sourceDigest: string;
      }>).find((entry) => entry.id === "game-delivery");
      t.assertions.assert(
        built.status === 0 && builtPackage?.built === true && builtPackage.drifted === false,
        `healthy package was not reported as built and undrifted: ${built.text}`,
      );
      // Rebuilding unchanged source must preserve team identity: the plan
      // digest is bound to the source bytes, so it does not move either.
      const before = spaces.map((space) => `${space.id}:${space.agentSpace?.revision}`).sort().join(",");
      const replanned = cli([
        "workflow", "build", "--workspace", approveProject.id, "--package", "game-delivery",
      ]);
      t.assertions.assert(
        replanned.status === 0 && replanned.data.sourceDigest === builtPackage!.sourceDigest,
        `replanning an unchanged package moved its source identity: ${replanned.text}`,
      );
      const afterReplan = await opened.client.call({ type: "workspace.list" });
      const afterReplanSpaces = afterReplan?.type === "workspaces"
        ? afterReplan.data.filter((space) => spaces.some((known) => known.id === space.id))
        : [];
      t.assertions.assert(
        afterReplanSpaces.map((space) => `${space.id}:${space.agentSpace?.revision}`).sort().join(",") === before,
        "a read-only replan changed team identity or revisions",
      );

      const completedBefore = approved.events.filter((event) => event.type === "turnCompleted").length;
      await t.flows.main.sendPrompt(
        opened.client,
        approved.sessionId,
        "AGENT_COMPONENT_BYPASS: 直接给项目根添加 Reviewer Component",
      );
      await t.tools.waitUntil(
        () => approved.events.filter((event) => event.type === "turnCompleted").length > completedBefore,
        120_000,
      );
      t.assertions.assert(bypassAttempted && bypassRefused, `direct Component probe did not reach the approval boundary: ${bypassDiagnostic}`);
      const afterBypass = await opened.client.call({ type: "workspace.list" });
      const projectAfterBypass = afterBypass?.type === "workspaces"
        ? afterBypass.data.find((workspace) => workspace.id === approveProject.id)
        : undefined;
      t.assertions.assert(
        projectAfterBypass?.agentSpace?.components.every((component) => component.componentId !== "reviewer") === true,
        "an Agent mutated Component state without an approved ChangePlan",
      );

      const inspected = cli(["workflow", "inspect", "--workspace", approveProject.id, "--package", "game-delivery"]);
      t.assertions.assert(inspected.status === 0, `built package is not inspectable: ${inspected.text}`);
      t.assertions.assert(
        (inspected.data.workflows as Array<{ id: string }>).some((flow) => flow.id === "game-dev"),
        `the package's flows are not the compiled catalog: ${inspected.text}`,
      );

      // Upgrading is a source edit in the package's own directory followed by
      // a rebuild: the platform implements no merge and holds no receipt, so
      // "what changed" is whatever the working tree now says.
      const packageRoot = path.join(approved.root, ".genethub/workflows/game-delivery");
      const coderPrompt = path.join(packageRoot, "prompts/coder.md");
      const upgradedPrompt = `${readFileSync(coderPrompt, "utf8")}\n改进后的实现方法。\n`;
      writeFileSync(coderPrompt, upgradedPrompt);
      const drifted = cli(["workflow", "list", "--workspace", approveProject.id]);
      const driftedPackage = ((drifted.data.packages ?? []) as Array<{ id: string; sourceDigest: string }>)
        .find((entry) => entry.id === "game-delivery");
      t.assertions.assert(
        driftedPackage!.sourceDigest !== builtPackage!.sourceDigest,
        "editing package source did not change its reported identity",
      );

      // A Run in flight blocks rebuilding the carriers it is executing on.
      const blockerEvents = await t.flows.main.attachEventLog(opened.client, approved.sessionId);
      await t.flows.main.sendPrompt(opened.client, approved.sessionId, "UPGRADE_BLOCKING_RUN: 启动旧版本任务，然后等待我的升级要求。");
      await t.tools.waitUntil(() => blockerEvents.some(event => event.type === "turnCompleted" || event.type === "turnFailed"), 40_000);
      const oldRuns = await opened.client.call({ type: "workflow.history", payload: { workspaceId: approveProject.id, limit: 50 } });
      const conflictingRun = oldRuns?.type === "workflowRuns" ? oldRuns.data.find(run => run.status === "running") : undefined;
      t.assertions.assert(Boolean(conflictingRun), "the blocking task did not start before the rebuild");
      const blockedPlan = cli(["workflow", "build", "--workspace", approveProject.id, "--package", "game-delivery"]);
      t.assertions.assert(
        blockedPlan.status === 0 && (blockedPlan.data.conflictRuns as string[]).includes(conflictingRun!.id),
        `rebuild preparation hid its active-Run conflict: ${blockedPlan.text}`,
      );
      const blockedApply = cli(["workflow", "build", "--workspace", approveProject.id, "--package", "game-delivery", "--apply",
        "--plan-digest", String(blockedPlan.data.planDigest), "--revision", String(blockedPlan.data.expectedRevision), "--action-id", "blocked-upgrade"]);
      t.assertions.assert(blockedApply.status !== 0, `rebuild apply accepted an active-Run conflict: ${blockedApply.text}`);

      // This is the same bounded read-then-retry semantics as the task panel.
      // A running Worker may update the Run between `workflow get` and the
      // direct cancellation request; only that CAS conflict or the brief
      // mechanical-reconciler lock retries.
      let cancelled: Awaited<ReturnType<typeof opened.client.call>> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latestConflict = await opened.client.call({type:"workflow.get",payload:{workspaceId:approveProject.id,runId:conflictingRun!.id}});
        t.assertions.assert(latestConflict?.type === "workflowRun","cannot refresh conflicting Run");
        try {
          cancelled = await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: approveProject.id, runId: conflictingRun!.id, expectedRevision: latestConflict!.type === "workflowRun" ? latestConflict.data.revision : -1 } });
          break;
        } catch (cause) {
          const retryable = cause instanceof Error && (cause.message.includes("Workflow revision 冲突") || cause.message === "Workflow Run 正由另一个请求修改");
          if (!retryable || attempt === 2) throw cause;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      t.assertions.assert(cancelled?.type === "workflowRun" && cancelled.data.status === "cancelling", "the framework cancellation entry was unavailable");
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "workflow.get", payload: { workspaceId: approveProject.id, runId: conflictingRun!.id } });
        return reply?.type === "workflowRun" && reply.data.status === "cancelled";
      }, 35_000);

      // Conflict markers left by a real `git pull` make the YAML unparseable,
      // so a half-merged upgrade cannot be built or activated. That is the
      // whole upgrade gate: there is no platform merge to bypass.
      const conflictedFlow = path.join(packageRoot, "flows/game-dev.yaml");
      const resolvedFlow = readFileSync(conflictedFlow, "utf8");
      writeFileSync(conflictedFlow, `<<<<<<< HEAD\n${resolvedFlow}=======\n${resolvedFlow}>>>>>>> origin/main\n`);
      const conflicted = cli(["workflow", "build", "--workspace", approveProject.id, "--package", "game-delivery"]);
      t.assertions.assert(conflicted.status !== 0, "a package with merge conflict markers was buildable");
      const conflictedList = cli(["workflow", "list", "--workspace", approveProject.id]);
      t.assertions.assert(
        !!((conflictedList.data.packages ?? []) as Array<{ id: string; compileError: string | null }>)
          .find((entry) => entry.id === "game-delivery")?.compileError,
        `list hid the unresolved merge instead of reporting it: ${conflictedList.text}`,
      );
      writeFileSync(conflictedFlow, resolvedFlow);

      const upgradeEvents = await t.flows.main.attachEventLog(opened.client, approved.sessionId);
      const upgradeInput = await opened.client.call({ type: "session.send", payload: {
        sessionId: approved.sessionId, messageId: "u_upgrade_after_cancel",
        text: "UPGRADE_BOOTSTRAP: 用新的包源重建执行团队，保留我的项目定制。", attachments: [],
        artifactPreviewBaseUrl: null, continuesRound: null,
      } });
      t.assertions.assert(upgradeInput?.type === "ack", "upgrade input was not accepted alongside the cancellation notice");
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: approved.sessionId } });
        if (reply?.type !== "snapshot") return false;
        if (reply.data.summary.inputSummary?.error) throw new Error(reply.data.summary.inputSummary.error);
        return upgradeStage >= 3 && !reply.data.summary.inputSummary?.pendingMessageIds.includes("u_upgrade_after_cancel");
      }, 90_000);
      t.assertions.assert(!upgradeEvents.some(event => t.flows.main.sessionEventOf(event)?.type === "permissionRequested"), "project-bound PM was asked to authorize its own routine rebuild again");
      t.assertions.assert(!upgradeEvents.some(event => event.type === "turnFailed"), "authorized rebuild turn failed");
      const upgraded = cli(["workflow", "list", "--workspace", approveProject.id]);
      const upgradedPackage = ((upgraded.data.packages ?? []) as Array<{ id: string; built: boolean; drifted: boolean }>)
        .find((entry) => entry.id === "game-delivery");
      t.assertions.assert(
        upgraded.status === 0 && upgradedPackage?.built === true && upgradedPackage.drifted === false,
        `rebuilt project is not reported healthy: ${upgraded.text}`,
      );
      t.assertions.assert(readFileSync(coderPrompt, "utf8") === upgradedPrompt, "the rebuild rewrote the user's package source");

      t.note(`project=${approveProject.id} executor=${executor.id} package=game-delivery`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { connectProductClient, daemonEndpoint, defineSpecialty } from "../../framework/public.ts";

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
    id: "specialty.agent-space.bootstrap-pack",
    title: "A Human-approved Bootstrap Pack atomically takes over an ordinary folder",
    oracle:
      "a normal Agent Session can only apply the daemon-issued PM takeover plan after the Human approves its native PlanApproval; rejection and direct CLI replay leave zero mutation, approval creates an independent Git repository and exactly five Builder-verified AgentSpaces, and the same Pack then returns an identity-preserving no-op",
    catches: [
      "the old specialty bypasses the Human and calls bootstrap apply as LocalUser",
      "ordinary chat or a copied CLI command is accepted as project-mutation authority",
      "rejecting the plan still initializes Git or leaves a partial AgentSpace tree",
      "a nested empty folder inherits or stages into the outer repository",
      "the Pack is a daemon business constant rather than a versioned resource bundle",
      "the five AgentSpaces are written but never Builder-verified or registered",
      "a repeated PM request creates duplicate Spaces or increments revisions",
      "bootstrap silently replaces the user's Git commit identity",
    ],
    tags: ["core", "agent-space", "authorization", "bootstrap-pack", "genet-cli", "workflow"],
    llm: { default: "mock" },
    expectedDurationMs: 45_000,
    timeoutMs: 180_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["agent", "daemon", "genet-cli", "workbench-client"],
    productInterfaces: [
      "request_user_input",
      "session.respondPermission",
      "genet space bootstrap",
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
          if (stage === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1' } } };
          if (stage === 1) {
            const digest = fieldFromRequest(request, "planDigest");
            const revision = fieldFromRequest(request, "expectedRevision");
            if (typeof digest !== "string" || typeof revision !== "number") throw new Error("upgrade lost its bound management plan facts");
            return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest ${shellArg(digest)} --expected-revision ${revision} --action-id upgrade-authorized` } } };
          }
          return { text: "升级结果已回到原 PM。" };
        }
        if (body.includes("UPGRADE_BLOCKING_RUN")) {
          if (blockerStage++ === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow game-feature --task upgrade-conflict --message "等待母工作流升级" --no-wait' } } };
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
          return { text: "用户已拒绝接管；没有创建 Git、Pack、Component 或 AgentSpace。" };
        }
        const stage = stages.get(marker) ?? 0;
        stages.set(marker, stage + 1);
        if (stage === 0) {
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space inspect' } } };
        }
        if (stage === 1) {
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space bootstrap list' } } };
        }
        if (stage === 2) {
          return {
            tool: {
              name: "bash",
              arguments: { command: '"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1' },
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
                command: `"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest ${shellArg(
                  planDigest,
                )} --expected-revision ${revision} --action-id bootstrap-approved && cat .pipebuilder/skills/project-manager/SKILL.md`,
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
        t.assertions.assert(!existsSync(path.join(project.root, ".git")), "read-only plan created Git");
        t.assertions.assert(!existsSync(path.join(project.root, "pipespace.json")), "read-only plan wrote Pack files");
        const requested = events.find((event) => {
          const inner = t.flows.main.sessionEventOf(event);
          const request = inner?.request as { kind?: string } | undefined;
          return inner?.type === "permissionRequested" && request?.kind === "planApproval";
        });
        const request = requested ? t.flows.main.sessionEventOf(requested)?.request : undefined;
        const requestId = (request as { id?: string; title?: string } | undefined)?.id;
        t.assertions.assert(
          (request as { title?: string } | undefined)?.title?.includes("交给 PM 团队") === true,
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
      t.assertions.assert(!existsSync(path.join(rejected.root, ".git")), "rejection created Git");
      t.assertions.assert(!existsSync(path.join(rejected.root, "spaces")), "rejection left a partial team");

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

      const available = cli(["space", "bootstrap", "list"]);
      const packs = (available.data.packs ?? []) as Array<{ id: string; intentMatches: string[] }>;
      t.assertions.assert(
        available.status === 0 &&
          packs.some((pack) => pack.id === "game-delivery-v1" && pack.intentMatches.includes("game-workflow-review")),
        `Pack is not discoverable: ${available.text}`,
      );
      const terminalPlan = cli([
        "space", "bootstrap", "plan", "--workspace", approveProject.id,
        "--pack", "game-delivery-v1", "--agent", "opencode", "--model", "mock",
      ]);
      const copied = cli([
        "space", "bootstrap", "apply", "--workspace", approveProject.id,
        "--pack", "game-delivery-v1", "--agent", "opencode", "--model", "mock",
        "--plan-digest", String(terminalPlan.data.planDigest),
        "--expected-revision", String(terminalPlan.data.expectedRevision),
        "--action-id", "copied-terminal-command",
      ]);
      t.assertions.assert(copied.status !== 0, "a copied LocalUser CLI command bypassed Session approval");
      t.assertions.assert(
        ((copied.envelope.error ?? {}) as Record<string, unknown>).code === "approvalRequired",
        `unapproved apply did not expose its stable failure code: ${copied.text}`,
      );
      t.assertions.assert(!existsSync(path.join(approveProject.root, ".git")), "unapproved apply mutated the project");

      const approved = await runInteraction("APPROVE_BOOTSTRAP", "approve-once");
      await t.tools.waitUntil(() => existsSync(path.join(approved.root, "pipespace.json")), 120_000);
      await t.tools.waitUntil(
        () => approved.events.filter((event) => event.type === "turnCompleted").length >= 1,
        120_000,
      );

      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "workspace.list failed after bootstrap");
      const allSpaces = listed?.type === "workspaces" ? listed.data : [];
      const spaces = allSpaces.filter((space) =>
        ["executor", "coder", "reviewer", "workflow-manager", "workflow-reviewer"].includes(space.name),
      );
      t.assertions.assert(spaces.length === 5, `bootstrap did not create exactly five team Spaces`);
      const byName = new Map(spaces.map((space) => [space.name, space]));
      const executor = byName.get("executor")!;
      for (const name of ["executor", "coder", "reviewer", "workflow-manager", "workflow-reviewer"]) {
        t.assertions.assert(
          existsSync(path.join(approved.root, "spaces", name, ".pipebuilder", "lock.json")),
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

      const projectCommit = git(approved.root, ["rev-parse", "HEAD"], opened.daemon.env);
      t.assertions.assert(projectCommit.length === 40, "bootstrap did not create its exact commit");
      t.assertions.assert(
        git(approved.root, ["log", "-1", "--format=%an <%ae>"], opened.daemon.env) ===
          "Journey User <journey@example.com>",
        "bootstrap ignored the user identity shown in its plan",
      );
      t.assertions.assert(git(approved.root, ["status", "--porcelain=v1"], opened.daemon.env) === "", "new project is dirty");
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
      const rendererArgs = ["--agent", controller.agentId];
      if (controller.modelId) rendererArgs.push("--model", controller.modelId);
      const currentPlan = cli([
        "space", "bootstrap", "plan", "--workspace", approveProject.id,
        "--pack", "game-delivery-v1", ...rendererArgs,
      ]);
      t.assertions.assert(currentPlan.data.current === true, `healthy Pack was not recognized as current: ${currentPlan.text}`);
      const before = spaces.map((space) => `${space.id}:${space.agentSpace?.revision}`).sort().join(",");
      const repeated = cli([
        "space", "bootstrap", "apply", "--workspace", approveProject.id,
        "--pack", "game-delivery-v1", ...rendererArgs,
        "--plan-digest", String(currentPlan.data.planDigest),
        "--expected-revision", String(currentPlan.data.expectedRevision),
        "--action-id", "current-no-op",
      ]);
      t.assertions.assert(repeated.status === 0 && repeated.data.status === "current", `repeat was not a no-op: ${repeated.text}`);
      const repeatedSpaces = (repeated.data.spaces ?? []) as typeof spaces;
      t.assertions.assert(
        repeatedSpaces.map((space) => `${space.id}:${space.agentSpace?.revision}`).sort().join(",") === before,
        "no-op apply changed team identity or revisions",
      );
      t.assertions.assert(git(approved.root, ["rev-parse", "HEAD"], opened.daemon.env) === projectCommit, "no-op created a commit");

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

      const inspected = cli(["workflow", "inspect", "--workspace", approveProject.id]);
      t.assertions.assert(inspected.status === 0, `installed workflow is not inspectable: ${inspected.text}`);
      t.assertions.assert(
        readFileSync(path.join(approved.root, ".genethub/workflow/project.yaml"), "utf8").includes(
          "defaultWorkflow: game-project",
        ),
        "Pack did not install the game delivery DCG",
      );
      // Historical source + persisted Pack identity fixture, installed only
      // while the daemon is stopped; all upgrade actions use production APIs.
      const legacy = JSON.parse(readFileSync(path.join(t.openRoot, "testing/fixtures/bootstrap/game-delivery-v1.json"), "utf8")) as { packDigest: string; files: Record<string, string>; absentFiles: string[] };
      const removed = await opened.client.call({ type: "workspace.remove", payload: { workspaceId: byName.get("workflow-reviewer")!.id } });
      t.assertions.assert(removed?.type === "workspaces" && !removed.data.some((space) => space.id === byName.get("workflow-reviewer")!.id), "could not prepare the legacy four-Space fixture");
      for (const relative of legacy.absentFiles) rmSync(path.join(approved.root, relative), { force: true });
      rmSync(path.join(approved.root, "spaces", "workflow-reviewer"), { recursive: true, force: true });
      for (const [relative, content] of Object.entries(legacy.files)) writeFileSync(path.join(approved.root, relative), content);
      const coderPrompt = path.join(approved.root, ".genethub/workflow/prompts/coder.md");
      writeFileSync(coderPrompt, "\nUser customization: retain accessible keyboard controls.\n", { flag: "a" });
      const customized = readFileSync(coderPrompt, "utf8");
      for (const member of [projectAfterBypass!, ...spaces.filter((space) => space.name !== "workflow-reviewer")]) {
        const built = await opened.client.call({ type: "agentSpace.builder", payload: { workspaceId: approveProject.id, targetWorkspaceId: member.id, spaceName: member.name, operation: { kind: "build", dryRun: false, requireNoPostCommands: true } } });
        t.assertions.assert(built?.type === "agentSpaceBuilder" && built.data.status === "ok", "legacy source fixture did not build");
        const component = member.agentSpace!.components[0]!;
        await opened.client.call({ type: "agentSpace.configure", payload: { workspaceId: member.id, expectedRevision: member.agentSpace!.revision, operation: { kind: "setComponent", componentId: component.componentId, enabled: component.enabled, role: component.role ?? null } } });
      }
      git(approved.root, ["add", ".pipebuilder", ".agents", ".claude", ".cursor", ".codebuddy", "AGENTS.md", ".genethub/workflow", "spaces"], opened.daemon.env);
      git(approved.root, ["commit", "-m", "historical v1 fixture with user customization"], opened.daemon.env);
      const currentStatus = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: approveProject.id } });
      if (currentStatus?.type !== "workflowProject") throw new Error("legacy candidate did not compile");
      const legacyActivation = await opened.client.call({ type: "workflow.activate", payload: { workspaceId: approveProject.id, candidateDigest: null, expectedRevision: currentStatus.data.activationRevision } });
      if (legacyActivation?.type !== "workflowProject") throw new Error("legacy candidate did not activate");
      opened.client.close();
      opened.daemon.stop();
      const configPath = path.join(t.env.data, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const legacyIds = new Set([approveProject.id, ...spaces.filter((space) => space.name !== "workflow-reviewer").map((space) => space.id)]);
      for (const space of config.agentSpaces) if (legacyIds.has(space.workspaceId)) {
        space.bootstrapPack.version = 1;
        space.bootstrapPack.digest = legacy.packDigest;
      }
      writeFileSync(configPath, JSON.stringify(config));
      const receiptPath = path.join(approved.root, ".genethub/bootstrap-packs/game-delivery-v1.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.packVersion = 1; receipt.packDigest = legacy.packDigest;
      receipt.spaces = receipt.spaces.filter((space: { name: string }) => space.name !== "workflow-reviewer");
      writeFileSync(receiptPath, JSON.stringify(receipt));
      cli(["daemon", "start"]);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
      const pmSkill = path.join(approved.root, ".pipebuilder/skills/project-manager/SKILL.md");
      const originalPm = readFileSync(pmSkill, "utf8");
      writeFileSync(pmSkill, originalPm + "\nCustom PM decision policy.\n");
      git(approved.root, ["add", ".pipebuilder/skills/project-manager/SKILL.md"], opened.daemon.env);
      git(approved.root, ["commit", "-m", "custom PM conflict"], opened.daemon.env);
      const conflict = cli(["space", "bootstrap", "plan", "--workspace", approveProject.id, "--pack", "game-delivery-v1"]);
      t.assertions.assert(conflict.status !== 0 && readFileSync(pmSkill, "utf8").includes("Custom PM decision policy."), "upgrade overwrote a conflicting customization");
      writeFileSync(pmSkill, originalPm);
      git(approved.root, ["add", ".pipebuilder/skills/project-manager/SKILL.md"], opened.daemon.env);
      git(approved.root, ["commit", "-m", "resolve PM upgrade conflict"], opened.daemon.env);
      const upgradePlan = cli(["space", "bootstrap", "plan", "--workspace", approveProject.id, "--pack", "game-delivery-v1", ...rendererArgs]);
      t.assertions.assert(upgradePlan.status === 0 && upgradePlan.data.current === false, `legacy upgrade preflight failed: ${upgradePlan.text}`);
      const blockerEvents = await t.flows.main.attachEventLog(opened.client, approved.sessionId);
      await t.flows.main.sendPrompt(opened.client, approved.sessionId, "UPGRADE_BLOCKING_RUN: 启动旧版本任务，然后等待我的升级要求。");
      await t.tools.waitUntil(() => blockerEvents.some(event => event.type === "turnCompleted" || event.type === "turnFailed"), 40_000);
      const oldRuns = await opened.client.call({ type: "workflow.history", payload: { workspaceId: approveProject.id, limit: 50 } });
      const conflictingRun = oldRuns?.type === "workflowRuns" ? oldRuns.data.find(run => run.status === "running") : undefined;
      t.assertions.assert(Boolean(conflictingRun), "legacy task did not start before upgrade");
      const blockedPlan = cli(["space", "bootstrap", "plan", "--workspace", approveProject.id, "--pack", "game-delivery-v1", ...rendererArgs]);
      t.assertions.assert(blockedPlan.status === 0 && (blockedPlan.data.conflictRuns as string[]).includes(conflictingRun!.id)
        && (blockedPlan.data.recoveryActions as string[]).some(action => action.includes("workflow cancel")), "upgrade preparation hid its conflict and recovery action");
      const blockedApply = cli(["space", "bootstrap", "apply", "--workspace", approveProject.id, "--pack", "game-delivery-v1", ...rendererArgs,
        "--plan-digest", String(blockedPlan.data.planDigest), "--expected-revision", String(blockedPlan.data.expectedRevision), "--action-id", "blocked-upgrade"]);
      t.assertions.assert(blockedApply.status !== 0 && blockedApply.text.includes("activeRunConflict"), `upgrade apply did not report the active conflict: ${blockedApply.text}`);
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
      t.assertions.assert(cancelled?.type === "workflowRun" && cancelled.data.status === "cancelling", "old Pack could not use the framework cancellation entry");
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "workflow.get", payload: { workspaceId: approveProject.id, runId: conflictingRun!.id } });
        return reply?.type === "workflowRun" && reply.data.status === "cancelled";
      }, 35_000);
      const upgradeEvents = await t.flows.main.attachEventLog(opened.client, approved.sessionId);
      // A cancellation notice can start a PM turn after any idle snapshot.
      // Use the same durable admission as the UI, then observe this input's
      // responsibility instead of mistaking an earlier notice for its answer.
      const upgradeInput = await opened.client.call({ type: "session.send", payload: {
        sessionId: approved.sessionId, messageId: "u_upgrade_after_cancel",
        text: "UPGRADE_BOOTSTRAP: 升级内置专家，保留我的项目定制。", attachments: [],
        artifactPreviewBaseUrl: null, continuesRound: null,
      } });
      t.assertions.assert(upgradeInput?.type === "ack", "upgrade input was not accepted alongside the cancellation notice");
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: approved.sessionId } });
        if (reply?.type !== "snapshot") return false;
        if (reply.data.summary.inputSummary?.error) throw new Error(reply.data.summary.inputSummary.error);
        return upgradeStage >= 3 && !reply.data.summary.inputSummary?.pendingMessageIds.includes("u_upgrade_after_cancel");
      }, 90_000);
      t.assertions.assert(!upgradeEvents.some(event => t.flows.main.sessionEventOf(event)?.type === "permissionRequested"), "project-bound PM was asked to authorize its own routine upgrade again");
      t.assertions.assert(!upgradeEvents.some(event => event.type === "turnFailed"), "authorized upgrade turn failed");
      const upgraded = cli(["space", "bootstrap", "plan", "--workspace", approveProject.id, "--pack", "game-delivery-v1"]);
      t.assertions.assert(upgraded.status === 0 && upgraded.data.current === true, `upgraded project was not idempotent: ${upgraded.text}`);
      t.assertions.assert(readFileSync(coderPrompt, "utf8") === customized, "upgrade changed a user-owned workflow prompt");
      const afterUpgrade = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: approveProject.id } });
      t.assertions.assert(afterUpgrade?.type === "workflowProject" && afterUpgrade.data.workflows.some((workflow) => workflow.id === "workflow-review") && afterUpgrade.data.activationRevision === legacyActivation.data.activationRevision + 1, "upgrade omitted reviewer routing or lost activation history");
      t.note(`project=${approveProject.id} executor=${executor.id} commit=${projectCommit.slice(0, 12)}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

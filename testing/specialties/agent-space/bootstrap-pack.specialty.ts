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
    id: "specialty.agent-space.bootstrap-pack",
    title: "A Human-approved Bootstrap Pack atomically takes over an ordinary folder",
    oracle:
      "a normal Agent Session can only apply the daemon-issued PM takeover plan after the Human approves its native PlanApproval; rejection and direct CLI replay leave zero mutation, approval creates an independent Git repository and exactly four Builder-verified AgentSpaces, and the same Pack then returns an identity-preserving no-op",
    catches: [
      "the old specialty bypasses the Human and calls bootstrap apply as LocalUser",
      "ordinary chat or a copied CLI command is accepted as project-mutation authority",
      "rejecting the plan still initializes Git or leaves a partial AgentSpace tree",
      "a nested empty folder inherits or stages into the outer repository",
      "the Pack is a daemon business constant rather than a versioned resource bundle",
      "the four AgentSpaces are written but never Builder-verified or registered",
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
      const respond = (request: unknown) => {
        const body = JSON.stringify(request);
        if (body.includes("AGENT_COMPONENT_BYPASS")) {
          if (
            body.includes("approvalRequired") ||
            body.includes("必须先使用 --plan") ||
            body.includes('"code":"forbidden"')
          ) {
            return { text: "直接修改已被内核拒绝；必须先向用户展示变更计划。" };
          }
          return {
            tool: {
              name: "bash",
              arguments: {
                command: '"$GENEHUB_CLI" space component set --component reviewer',
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
      const packs = (available.data.packs ?? []) as Array<{ id: string; description: string }>;
      t.assertions.assert(
        available.status === 0 &&
          packs.some((pack) => pack.id === "game-delivery-v1" && pack.description.includes("WorkflowManager")),
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
        ["executor", "coder", "reviewer", "workflow-manager"].includes(space.name),
      );
      t.assertions.assert(spaces.length === 4, `bootstrap did not create exactly four team Spaces`);
      const byName = new Map(spaces.map((space) => [space.name, space]));
      const executor = byName.get("executor")!;
      for (const name of ["executor", "coder", "reviewer", "workflow-manager"]) {
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
      for (const name of ["coder", "reviewer", "workflow-manager"]) {
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
      t.note(`project=${approveProject.id} executor=${executor.id} commit=${projectCommit.slice(0, 12)}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

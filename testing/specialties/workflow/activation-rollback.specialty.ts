import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

defineSpecialty(
  {
    id: "specialty.workflow.activation-failure-rolls-back",
    title: "A failed project role activation leaves no managed Session or ref lease",
    oracle:
      "after a project-owned role names an unavailable Agent, public workflow dispatch fails cleanly and the same target branch can be dispatched successfully as soon as the role is corrected",
    catches: [
      "failed activation leaves a hidden managed Session",
      "failed activation leaves a target-ref lease until TTL expiry",
      "a failed Run is exposed as a successful dispatch",
      "recovery depends on deleting private runtime files",
    ],
    tags: ["core", "workflow", "root-chat", "session", "authorization", "git"],
    llm: { default: "mock" },
    expectedDurationMs: 45_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
    productInterfaces: ["@genehub/workbench/client", "genet workflow", ".genethub/workflow"],
  },
  async (t) => {
    t.data.git.init(t.env.workspace);
    writeFileSync(path.join(t.env.workspace, "README.md"), "# Activation rollback fixture\n");
    git(t.env.workspace, ["add", "README.md", ".keep"]);
    git(t.env.workspace, ["commit", "-m", "initial fixture"]);
    const initialBranch = git(t.env.workspace, ["branch", "--show-current"]);

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const initialized = spawnSync(
        opened.daemon.genet,
        ["workflow", "init", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash"],
        { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" },
      );
      t.assertions.assert(
        initialized.status === 0,
        `workflow init failed: ${initialized.stderr || initialized.stdout}`,
      );
      git(opened.workspaceRoot, ["add", ".genethub"]);
      git(opened.workspaceRoot, ["commit", "-m", "initialize workflow"]);

      const rolePath = path.join(opened.workspaceRoot, ".genethub/workflow/roles/worker.yaml");
      const validRole = readFileSync(rolePath, "utf8");
      t.assertions.assert(validRole.includes("agentId: genet"), "fixture role does not use genet");
      writeFileSync(rolePath, validRole.replace("agentId: genet", "agentId: unavailable-agent"));
      git(opened.workspaceRoot, ["add", rolePath]);
      git(opened.workspaceRoot, ["commit", "-m", "configure unavailable worker"]);

      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                'if "$GENEHUB_CLI" workflow dispatch --kind business --complexity simple --task must-fail --message "不得创建 Worker" --wait --timeout 10; then echo "unexpected success"; exit 9; fi',
            },
          },
        },
        { text: "项目配置中的 Agent 不可用，未启动任何受管会话。" },
      );
      const failedRoot = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const failedEvents = await t.flows.main.attachEventLog(opened.client, failedRoot);
      await t.flows.main.sendPrompt(
        opened.client,
        failedRoot,
        "请按项目工作流派发一次任务，并如实报告配置错误。",
      );
      await t.tools.waitUntil(
        () =>
          failedEvents.some((event) => event.type === "turnCompleted") ||
          failedEvents.some((event) => event.type === "turnFailed"),
        30_000,
      );
      t.assertions.assert(
        failedEvents.some((event) => event.type === "turnCompleted"),
        "root Agent did not report the activation failure",
      );
      const afterFailure = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(afterFailure?.type === "sessions", "session.list failed after activation");
      t.assertions.assert(
        afterFailure?.type === "sessions" &&
          !afterFailure.data.some((session) => session.managed?.parentSessionId === failedRoot),
        "failed activation left a managed Session",
      );

      writeFileSync(rolePath, validRole);
      git(opened.workspaceRoot, ["add", rolePath]);
      git(opened.workspaceRoot, ["commit", "-m", "restore available worker"]);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" workflow dispatch --kind business --complexity simple --task succeeds-after-rollback --message "在 recovered.txt 写入 recovered 并提交。" --wait --timeout 60',
            },
          },
        },
        { tool: { name: "write", arguments: { path: "recovered.txt", content: "recovered\n" } } },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                'git add recovered.txt && git commit -m "complete recovered task" && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks=rollback-specialty',
            },
          },
        },
        { text: "恢复后的 Worker 已提交并上报证据。" },
        { text: "配置修正后，任务已通过同一项目流程完成。" },
      );
      const recoveredRoot = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const recoveredEvents = await t.flows.main.attachEventLog(opened.client, recoveredRoot);
      await t.flows.main.sendPrompt(opened.client, recoveredRoot, "配置已经修正，请重新派发任务。");
      await t.tools.waitUntil(
        () =>
          recoveredEvents.some((event) => event.type === "turnCompleted") ||
          recoveredEvents.some((event) => event.type === "turnFailed"),
        90_000,
      );
      t.assertions.assert(
        recoveredEvents.some((event) => event.type === "turnCompleted") &&
          !recoveredEvents.some((event) => event.type === "turnFailed"),
        "dispatch after activation rollback did not complete",
      );

      const afterRecovery = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(afterRecovery?.type === "sessions", "session.list failed after recovery");
      const recoveredWorker =
        afterRecovery?.type === "sessions"
          ? afterRecovery.data.find(
              (session) => session.managed?.parentSessionId === recoveredRoot,
            )
          : undefined;
      t.assertions.assert(Boolean(recoveredWorker), "corrected dispatch did not create its Worker");
      t.assertions.fileEquals(opened.workspaceRoot, "recovered.txt", "recovered\n");
      t.assertions.assert(
        git(opened.workspaceRoot, ["branch", "--show-current"]) === initialBranch,
        "recovered dispatch changed branches",
      );
      t.assertions.assert(
        git(opened.workspaceRoot, ["status", "--porcelain"]) === "",
        "activation recovery left the project dirty",
      );
      t.note(
        `failedRoot=${failedRoot} recoveredRoot=${recoveredRoot} worker=${recoveredWorker?.id} branch=${initialBranch}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

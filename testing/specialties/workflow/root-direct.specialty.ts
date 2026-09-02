import { existsSync, writeFileSync } from "node:fs";
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
    id: "specialty.workflow.root-chat-direct-change",
    title: "Root Chat delegates a simple task to one managed Worker on the current branch",
    oracle:
      "a normal root Session initializes project-owned Workflow source, dispatches one read-only managed Session, and publishes its verified current-branch commit without review, PM, approval, branch, or merge stages",
    catches: [
      "a separate PM product entry is required",
      "the kernel silently inserts review or approval",
      "managed Sessions are hidden from the ordinary session list",
      "a human can mutate a read-only managed Session",
      "a managed Worker can recursively dispatch another Workflow",
      "the worker cannot identify its bound run or report evidence",
      "the direct flow creates a branch or accepts fabricated commit evidence",
      ".genehub and .genethub split project configuration",
    ],
    tags: ["core", "workflow", "root-chat", "session", "authorization", "git"],
    llm: { default: "mock" },
    expectedDurationMs: 45_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
    productInterfaces: ["@genehub/workbench/client", "genet workflow"],
  },
  async (t) => {
    t.data.git.init(t.env.workspace);
    writeFileSync(path.join(t.env.workspace, "README.md"), "# Workflow fixture\n");
    git(t.env.workspace, ["add", "README.md", ".keep"]);
    git(t.env.workspace, ["commit", "-m", "initial fixture"]);
    const initialBranch = git(t.env.workspace, ["branch", "--show-current"]);

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" workflow init --agent genet --model deepseek/deepseek-v4-flash && git add .genethub && git commit -m "initialize project workflow"',
            },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" workflow dispatch --kind business --complexity simple --task simple-fix --message "在 result.txt 写入 workflow-direct 并提交。" --wait --timeout 60',
            },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                'output=$("$GENEHUB_CLI" workflow dispatch --workflow direct-change --task nested-forbidden --message "受管 Worker 不得再次派发" --no-wait 2>&1); status=$?; if [ "$status" -eq 0 ]; then echo "managed Worker unexpectedly dispatched a nested Workflow"; exit 9; fi; printf "%s" "$output" | grep -q "受管子会话不能派发新的 Workflow"',
            },
          },
        },
        {
          tool: {
            name: "write",
            arguments: { path: "result.txt", content: "workflow-direct\n" },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                'git add result.txt && git commit -m "complete simple fix" && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks=mock-specialty',
            },
          },
        },
        { text: "实现与提交证据已经完成。" },
        { text: "简单任务已经通过项目直达流程交付。" },
      );

      const rootSessionId = await t.flows.main.createBuiltinSession(
        opened.client,
        opened.workspaceId,
      );
      const rootEvents = await t.flows.main.attachEventLog(opened.client, rootSessionId);
      await t.flows.main.sendPrompt(
        opened.client,
        rootSessionId,
        "请初始化这个项目的工作流，然后把这个简单修改直接交给 Worker 完成。",
      );
      try {
        await t.tools.waitUntil(
          () =>
            opened.mock.requests.length >= 2 ||
            rootEvents.some((event) => event.type === "turnCompleted") ||
            rootEvents.some((event) => event.type === "turnFailed"),
          20_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} while waiting for workflow init; events=${JSON.stringify(
            rootEvents.slice(-8).map((event) => event.raw),
          ).slice(-4000)}`,
        );
      }
      try {
        await t.tools.waitUntil(
          () =>
            rootEvents.some((event) => event.type === "turnCompleted") ||
            rootEvents.some((event) => event.type === "turnFailed"),
          100_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; root events=${rootEvents
            .map((event) => event.type)
            .join(",")}; mock requests=${opened.mock.requests.length}; tail=${JSON.stringify(
            rootEvents.slice(-8).map((event) => event.raw),
          ).slice(-4000)}`,
        );
      }
      t.assertions.assert(
        rootEvents.some((event) => event.type === "turnCompleted") &&
          !rootEvents.some((event) => event.type === "turnFailed"),
        `root turn did not complete: ${rootEvents.map((event) => event.type).join(",")}`,
      );

      const listed = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(listed?.type === "sessions", `session.list returned ${listed?.type}`);
      const sessions = listed?.type === "sessions" ? listed.data : [];
      const root = sessions.find((session) => session.id === rootSessionId);
      const managed = sessions.find(
        (session) => session.managed?.parentSessionId === rootSessionId,
      );
      t.assertions.assert(root?.managed === undefined, "the root Chat became a managed PM entry");
      t.assertions.assert(Boolean(managed), "the managed Worker is absent from session.list");
      t.assertions.assert(managed?.workspaceId === opened.workspaceId, "Worker left the root Workspace");
      t.assertions.assert(managed?.managed?.role === "worker", "project role label was not preserved");
      t.assertions.assert(
        managed?.managed?.userInteraction === "readOnly",
        "managed Worker is not human read-only",
      );

      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "session.send",
            payload: {
              sessionId: managed?.id ?? "missing",
              text: "人类不应直接续写这个 Worker。",
              attachments: [],
              artifactPreviewBaseUrl: null,
              continuesRound: null,
            },
          }),
        "forbidden",
      );

      const ordinarySessionId = await t.flows.main.createBuiltinSession(
        opened.client,
        opened.workspaceId,
      );
      const listedAgain = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(listedAgain?.type === "sessions", "second session.list failed");
      const ordinary =
        listedAgain?.type === "sessions"
          ? listedAgain.data.find((session) => session.id === ordinarySessionId)
          : undefined;
      t.assertions.assert(ordinary?.managed === undefined, "ordinary Session inherited managed state");

      const runId = managed?.managed?.workflowRunId ?? "missing";
      const runReply = await opened.client.call({
        type: "workflow.get",
        payload: { workspaceId: opened.workspaceId, runId },
      });
      t.assertions.assert(runReply?.type === "workflowRun", `workflow.get returned ${runReply?.type}`);
      const run = runReply?.type === "workflowRun" ? runReply.data : undefined;
      t.assertions.assert(run?.status === "completed", `Workflow status is ${run?.status}`);
      t.assertions.assert(
        run?.nodes.map((node) => `${node.id}:${node.status}`).join(",") ===
          "implement:completed,publish:completed",
        `unexpected direct graph: ${JSON.stringify(run?.nodes)}`,
      );

      t.assertions.fileEquals(opened.workspaceRoot, "result.txt", "workflow-direct\n");
      t.assertions.assert(
        existsSync(path.join(opened.workspaceRoot, ".genethub/workflow/project.yaml")),
        "project Workflow source was not created",
      );
      t.assertions.assert(
        !existsSync(path.join(opened.workspaceRoot, ".genehub")),
        "a second .genehub configuration root was created",
      );
      t.assertions.assert(
        git(opened.workspaceRoot, ["branch", "--show-current"]) === initialBranch,
        "direct flow changed branches",
      );
      t.assertions.assert(
        git(opened.workspaceRoot, ["branch", "--format=%(refname:short)"]) === initialBranch,
        "direct flow created a hidden branch",
      );
      t.assertions.assert(
        git(opened.workspaceRoot, ["rev-list", "--count", "HEAD"]) === "3",
        "expected only the initial, Workflow initialization, and Worker commits",
      );
      t.assertions.assert(
        git(opened.workspaceRoot, ["status", "--porcelain"]) === "",
        "the direct flow left the project dirty",
      );

      const requestText = JSON.stringify(opened.mock.requests);
      t.assertions.assert(
        requestText.includes("你仍是当前目录的普通对话 Agent") &&
          requestText.includes("你是当前项目直达流程中的实现 Worker"),
        "root or Worker Workflow contract was not delivered in Chinese",
      );
      t.note(
        `root=${rootSessionId} worker=${managed?.id} run=${runId} branch=${initialBranch} commits=3`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

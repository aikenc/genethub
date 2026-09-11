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
    title: "DCG activation and rollback preserve the last runnable project method",
    oracle:
      "project source remains only a Candidate until an ordinary root Session activates it with CAS; a broken active Candidate fails without leaks, and rollback to the immutable prior digest makes the same target branch runnable again",
    catches: [
      "editing live source silently hot-switches new Runs",
      "activation accepts a stale revision",
      "rollback recompiles broken live source instead of loading immutable history",
      "failed activation leaves a hidden managed Session",
      "failed activation leaves a target-ref lease until TTL expiry",
      "a failed Run is exposed as a successful dispatch",
      "recovery depends on deleting private runtime files",
    ],
    tags: ["core", "workflow", "root-chat", "session", "authorization", "git", "session-control-fixes"],
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

      const genesisReply = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(genesisReply?.type === "workflowProject", "genesis inspect failed");
      const genesis = genesisReply?.type === "workflowProject" ? genesisReply.data : undefined;
      const initialDigest = genesis?.activeDigest;
      t.assertions.assert(
        Boolean(initialDigest) && genesis?.candidateDigest === initialDigest,
        "genesis did not activate the compiled Candidate",
      );
      t.assertions.assert(
        genesis?.activationRevision === 1 && genesis.activationHistory.length === 1,
        `unexpected genesis activation: ${JSON.stringify(genesis)}`,
      );

      const rolePath = path.join(opened.workspaceRoot, ".genethub/workflow/roles/worker.yaml");
      const validRole = readFileSync(rolePath, "utf8");
      t.assertions.assert(validRole.includes("agentId: genet"), "fixture role does not use genet");
      writeFileSync(rolePath, validRole.replace("agentId: genet", "agentId: unavailable-agent"));
      git(opened.workspaceRoot, ["add", rolePath]);
      git(opened.workspaceRoot, ["commit", "-m", "configure unavailable worker"]);

      const candidateReply = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(candidateReply?.type === "workflowProject", "Candidate inspect failed");
      const candidate = candidateReply?.type === "workflowProject" ? candidateReply.data : undefined;
      const unavailableDigest = candidate?.candidateDigest;
      t.assertions.assert(
        Boolean(unavailableDigest) && unavailableDigest !== initialDigest,
        "source edit did not produce a distinct immutable Candidate",
      );
      t.assertions.assert(
        candidate?.activeDigest === initialDigest &&
          candidate?.activationRevision === 1 &&
          candidate?.sourceChanged,
        "editing project source hot-switched or rewrote the active DCG",
      );

      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: { command: '"$GENEHUB_CLI" workflow activate --revision 1' },
          },
        },
        { text: "候选 DCG 已按 revision 1 晋级。" },
      );
      const activationRoot = await t.flows.main.createBuiltinSession(
        opened.client,
        opened.workspaceId,
      );
      const activationEvents = await t.flows.main.attachEventLog(opened.client, activationRoot);
      await t.flows.main.sendPrompt(opened.client, activationRoot, "请激活当前 DCG 候选。");
      await t.tools.waitUntil(
        () =>
          activationEvents.some((event) => event.type === "turnCompleted") ||
          activationEvents.some((event) => event.type === "turnFailed"),
        30_000,
      );
      t.assertions.assert(
        activationEvents.some((event) => event.type === "turnCompleted") &&
          !activationEvents.some((event) => event.type === "turnFailed"),
        "ordinary root Session could not activate the current Candidate",
      );
      const activatedReply = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      const activated = activatedReply?.type === "workflowProject" ? activatedReply.data : undefined;
      t.assertions.assert(
        activated?.activeDigest === unavailableDigest &&
          activated?.activationRevision === 2 &&
          activated?.activationHistory.length === 2 &&
          !activated?.sourceChanged,
        `Candidate activation did not advance exactly once: ${JSON.stringify(activated)}`,
      );

      const staleActivation = spawnSync(
        opened.daemon.genet,
        ["workflow", "activate", "--candidate", initialDigest ?? "missing", "--revision", "1"],
        { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" },
      );
      t.assertions.assert(staleActivation.status !== 0, "stale activation revision was accepted");
      t.assertions.assert(
        `${staleActivation.stderr}\n${staleActivation.stdout}`.includes("revision 冲突"),
        "stale activation did not return an explicit CAS conflict",
      );

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

      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `"$GENEHUB_CLI" workflow activate --candidate ${initialDigest} --revision 2`,
            },
          },
        },
        { text: "已经回滚到上一个可运行的 DCG Candidate。" },
      );
      const rollbackRoot = await t.flows.main.createBuiltinSession(
        opened.client,
        opened.workspaceId,
      );
      const rollbackEvents = await t.flows.main.attachEventLog(opened.client, rollbackRoot);
      await t.flows.main.sendPrompt(opened.client, rollbackRoot, "请回滚到上一个可运行的 DCG。");
      await t.tools.waitUntil(
        () =>
          rollbackEvents.some((event) => event.type === "turnCompleted") ||
          rollbackEvents.some((event) => event.type === "turnFailed"),
        30_000,
      );
      t.assertions.assert(
        rollbackEvents.some((event) => event.type === "turnCompleted") &&
          !rollbackEvents.some((event) => event.type === "turnFailed"),
        "ordinary root Session could not roll back to an immutable Candidate",
      );
      const rolledBackReply = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      const rolledBack =
        rolledBackReply?.type === "workflowProject" ? rolledBackReply.data : undefined;
      t.assertions.assert(
        rolledBack?.activeDigest === initialDigest &&
          rolledBack?.candidateDigest === unavailableDigest &&
          rolledBack?.activationRevision === 3 &&
          rolledBack?.activationHistory.length === 3 &&
          rolledBack?.sourceChanged,
        `rollback did not restore immutable history: ${JSON.stringify(rolledBack)}`,
      );

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
        { text: "回滚后，任务已通过恢复的项目流程完成。" },
      );
      const recoveredRoot = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const recoveredEvents = await t.flows.main.attachEventLog(opened.client, recoveredRoot);
      await t.flows.main.sendPrompt(opened.client, recoveredRoot, "DCG 已回滚，请重新派发任务。");
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
      // Result acceptance precedes verified Worker retirement. Observe the Run
      // terminal before asserting its immutable activation and cleanup facts.
      let recoveredRun: import("@genehub/proto").WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({
          type: "workflow.get",
          payload: {
            workspaceId: opened.workspaceId,
            runId: recoveredWorker?.managed?.workflowRunId ?? "missing",
          },
        });
        recoveredRun = reply?.type === "workflowRun" ? reply.data : undefined;
        return Boolean(recoveredRun && ["completed", "blocked", "failed", "cancelled"].includes(recoveredRun.status));
      }, 30_000);
      t.assertions.assert(
        recoveredRun?.status === "completed" &&
          recoveredRun.dcgDigest === initialDigest &&
          recoveredRun.activationRevision === 3 &&
          recoveredRun.executorTurns === 0,
        `recovered Run did not pin the rolled-back DCG: ${JSON.stringify(recoveredRun)}`,
      );
      const closedWorker = await opened.client.call({ type: "session.get", payload: { sessionId: recoveredWorker!.id } });
      t.assertions.assert(closedWorker?.type === "snapshot" && closedWorker.data.summary.status === "closed",
        "recovered Run completed before its Worker retired");
      t.assertions.fileEquals(opened.workspaceRoot, "recovered.txt", "recovered\n");
      t.assertions.assert(
        git(opened.workspaceRoot, ["branch", "--show-current"]) === initialBranch,
        "recovered dispatch changed branches",
      );

      writeFileSync(rolePath, validRole);
      git(opened.workspaceRoot, ["add", rolePath]);
      git(opened.workspaceRoot, ["commit", "-m", "restore project source"]);
      const restoredReply = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      const restored = restoredReply?.type === "workflowProject" ? restoredReply.data : undefined;
      t.assertions.assert(
        restored?.candidateDigest === initialDigest &&
          restored?.activeDigest === initialDigest &&
          restored?.activationRevision === 3 &&
          !restored?.sourceChanged,
        `restoring source changed activation history: ${JSON.stringify(restored)}`,
      );
      t.assertions.assert(
        git(opened.workspaceRoot, ["status", "--porcelain"]) === "",
        "activation recovery left the project dirty",
      );
      t.note(
        `activationRoot=${activationRoot} failedRoot=${failedRoot} rollbackRoot=${rollbackRoot} recoveredRoot=${recoveredRoot} worker=${recoveredWorker?.id} revision=3 branch=${initialBranch}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

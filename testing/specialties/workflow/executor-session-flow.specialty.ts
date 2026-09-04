import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    id: "specialty.workflow.executor-session-flow",
    title: "Executor Session drives Coder and Reviewer with structured messages",
    oracle:
      "one ordinary PM turn discovers and applies the game Bootstrap Pack, commits its project assets, and dispatches the project DCG; one non-LLM Executor Session owns the Run snapshot and structured timeline while Coder and Reviewer execute in their attached AgentSpaces",
    catches: [
      "the PM has to know a hard-coded Pack id that cannot be discovered",
      "bootstrap leaves the project dirty so the first Coder cannot obtain its write lease",
      "the PM remains the direct parent of Worker Sessions",
      "role labels do not resolve to the Coder and Reviewer AgentSpaces",
      "Worker Sessions bind to their role but start in the project root and load the PM Skill",
      "Executor state remains only in daemon-private runtime",
      "mechanical DCG transitions consume Executor LLM turns",
      "FlowMessages are chat text or omit the Coder-to-Reviewer transition",
    ],
    tags: ["core", "workflow", "executor", "flow-message", "agent-space", "bootstrap-pack"],
    llm: { default: "mock" },
    expectedDurationMs: 55_000,
    timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
    productInterfaces: ["genet space bootstrap", "genet workflow", "genet session flow"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const projectRoot = path.join(opened.workspaceRoot, "asteroid-garden");
      mkdirSync(projectRoot, { recursive: true });
      t.data.git.init(projectRoot);
      writeFileSync(path.join(projectRoot, "README.md"), "# Asteroid Garden\n");
      git(projectRoot, ["add", "README.md"]);
      git(projectRoot, ["commit", "-m", "initial game project"]);

      const projectReply = await opened.client.call({
        type: "workspace.open",
        payload: { root: projectRoot },
      });
      t.assertions.assert(projectReply?.type === "workspace", "workspace.open did not return the project");
      const projectId = projectReply?.type === "workspace" ? projectReply.data.id : "";

      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const gameHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Asteroid Garden</title><style>body{margin:0;background:#08152b;color:#fff;font:16px sans-serif;text-align:center}canvas{background:#10264c;border:2px solid #79e8ff;margin:20px}</style></head><body><h1>Asteroid Garden</h1><p>方向键移动，收集星种</p><canvas id="game" width="640" height="360"></canvas><script>const c=document.querySelector('#game'),x=c.getContext('2d');let px=320,score=0;addEventListener('keydown',e=>{px+=e.key==='ArrowLeft'?-20:e.key==='ArrowRight'?20:0;score++;draw()});function draw(){x.fillStyle='#10264c';x.fillRect(0,0,c.width,c.height);x.fillStyle='#79e8ff';x.fillRect(px,300,28,28);x.fillStyle='#fff';x.fillText('星种 '+score,20,30)}draw()</script></body></html>`;
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" space bootstrap list && "$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1 && "$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 && git add . && git commit -m "bootstrap game delivery team"',
            },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                '"$GENEHUB_CLI" workflow dispatch --kind game --complexity project --task asteroid-garden --message "制作一个可玩的太空花园小游戏，方向键移动、收集星种并显示得分。" --wait --timeout 120',
            },
          },
        },
        {
          tool: {
            name: "write",
            arguments: { path: path.join(projectRoot, "index.html"), content: gameHtml },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                `cd ${JSON.stringify(projectRoot)} && git add index.html && git commit -m "build asteroid garden" && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks="index-html-static-smoke" && sleep 2`,
            },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                `cd ${JSON.stringify(projectRoot)} && test -s index.html && grep -q "<canvas" index.html && grep -q "ArrowLeft" index.html && rejected=$("$GENEHUB_CLI" workflow complete --evidence review=rejected --evidence checks="canvas-input-smoke" 2>&1); status=$?; test "$status" -ne 0 && printf "%s" "$rejected" | grep -q "必须等于" && "$GENEHUB_CLI" workflow complete --evidence review=approved --evidence checks="canvas-input-smoke"`,
            },
          },
        },
        { text: "节点已完成。" },
        { text: "评审已通过。" },
        { text: "节点已完成。" },
        { text: "小游戏已经由 Coder 实现并由 Reviewer 验收。" },
      );

      const pmSessionId = await t.flows.main.createBuiltinSession(opened.client, projectId);
      const pmEvents = await t.flows.main.attachEventLog(opened.client, pmSessionId);
      await t.flows.main.sendPrompt(
        opened.client,
        pmSessionId,
        "请搭建小游戏开发团队，并完成一个可以用方向键收集星种的太空花园小游戏。",
      );
      await t.tools.waitUntil(
        () =>
          pmEvents.some((event) => event.type === "turnCompleted") ||
          pmEvents.some((event) => event.type === "turnFailed"),
        140_000,
      );
      t.assertions.assert(
        pmEvents.some((event) => event.type === "turnCompleted") &&
          !pmEvents.some((event) => event.type === "turnFailed"),
        `PM turn failed: ${JSON.stringify(pmEvents.slice(-10).map((event) => event.raw)).slice(-6000)}`,
      );

      const listed = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: null, includeArchived: false },
      });
      t.assertions.assert(listed?.type === "sessions", `session.list returned ${listed?.type}`);
      const sessions = listed?.type === "sessions" ? listed.data : [];
      const workers = sessions.filter((session) => session.managed?.workflowRunId);
      t.assertions.assert(
        workers.length === 2,
        `expected Coder and Reviewer, got ${JSON.stringify(workers)}; PM events=${JSON.stringify(
          pmEvents.map((event) => event.raw),
        ).slice(-12000)}; requests=${JSON.stringify(opened.mock.requests).slice(-8000)}`,
      );
      const coder = workers.find((session) => session.managed?.role === "coder");
      const reviewer = workers.find((session) => session.managed?.role === "reviewer");
      t.assertions.assert(Boolean(coder && reviewer), "Coder or Reviewer Session is missing");
      const runId = coder?.managed?.workflowRunId ?? "missing";

      const runReply = await opened.client.call({
        type: "workflow.get",
        payload: { workspaceId: projectId, runId },
      });
      t.assertions.assert(runReply?.type === "workflowRun", `workflow.get returned ${runReply?.type}`);
      const run = runReply?.type === "workflowRun" ? runReply.data : undefined;
      t.assertions.assert(
        run?.status === "completed",
        `Run ended as ${run?.status}; run=${JSON.stringify(run)}; sessions=${JSON.stringify(sessions)}; PM=${JSON.stringify(
          pmEvents.map((event) => event.raw),
        ).slice(-12000)}`,
      );
      t.assertions.assert(run?.executorTurns === 0, "deterministic Executor used an LLM turn");
      t.assertions.assert(Boolean(run?.executorSessionId), "Run has no Executor Session");
      t.assertions.assert(
        coder?.managed?.parentSessionId === run?.executorSessionId &&
          reviewer?.managed?.parentSessionId === run?.executorSessionId,
        "Workers are not children of the Executor Session",
      );

      const spacesReply = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(spacesReply?.type === "workspaces", "workspace.list failed");
      const spaces = spacesReply?.type === "workspaces" ? spacesReply.data : [];
      const coderSpace = spaces.find((space) => space.name === "coder");
      const reviewerSpace = spaces.find((space) => space.name === "reviewer");
      const executorSpace = spaces.find((space) => space.name === "executor");
      t.assertions.assert(coder?.workspaceId === coderSpace?.id, "Coder did not run in Coder AgentSpace");
      t.assertions.assert(
        reviewer?.workspaceId === reviewerSpace?.id,
        "Reviewer did not run in Reviewer AgentSpace",
      );
      const sessionMeta = (spaceRoot: string, sessionId: string) =>
        JSON.parse(
          readFileSync(
            path.join(spaceRoot, ".genethub", "sessions", sessionId, "meta.json"),
            "utf8",
          ),
        ) as { cwd?: string; managedSystemPrompt?: string };
      const coderMeta = sessionMeta(coderSpace?.root ?? "missing", coder?.id ?? "missing");
      const reviewerMeta = sessionMeta(
        reviewerSpace?.root ?? "missing",
        reviewer?.id ?? "missing",
      );
      t.assertions.assert(
        path.resolve(coderMeta.cwd ?? "missing") === path.resolve(coderSpace?.root ?? "missing"),
        "Coder Session cwd is not the Coder AgentSpace root",
      );
      t.assertions.assert(
        path.resolve(reviewerMeta.cwd ?? "missing") ===
          path.resolve(reviewerSpace?.root ?? "missing"),
        "Reviewer Session cwd is not the Reviewer AgentSpace root",
      );
      t.assertions.assert(
        coderMeta.managedSystemPrompt?.includes(
          `任务工作目录（JSON 字符串）是 ${JSON.stringify(projectRoot)}`,
        ) === true,
        "Coder Session did not receive the distinct project task cwd",
      );
      t.assertions.assert(
        run?.executorWorkspaceId === executorSpace?.id,
        "Run did not reuse the Executor AgentSpace",
      );

      const flowReply = await opened.client.call({
        type: "session.flow",
        payload: { sessionId: run?.executorSessionId ?? "missing" },
      });
      t.assertions.assert(flowReply?.type === "sessionFlow", `session.flow returned ${flowReply?.type}`);
      const flow = flowReply?.type === "sessionFlow" ? flowReply.data : undefined;
      const kinds = flow?.messages.map((message) => message.kind) ?? [];
      t.assertions.assert(
        kinds.join(",") ===
          "run.requested,node.assigned,node.completed,node.assigned,node.completed,run.completed",
        `unexpected FlowMessage timeline: ${JSON.stringify(kinds)}`,
      );
      t.assertions.assert(flow?.run.status === "completed", "Executor flow snapshot is not terminal");

      const executorRoot = path.join(projectRoot, "spaces", "executor");
      const flowRoot = path.join(
        executorRoot,
        ".genethub",
        "sessions",
        run?.executorSessionId ?? "missing",
        "components",
        "executor",
      );
      for (const file of ["manifest.json", "inbox.jsonl", "journal.jsonl", "outbox.jsonl"]) {
        t.assertions.assert(existsSync(path.join(flowRoot, file)), `Executor flow omitted ${file}`);
      }
      t.assertions.assert(
        readFileSync(path.join(flowRoot, "journal.jsonl"), "utf8").includes("run.completed"),
        "the on-disk Executor journal is incomplete",
      );
      t.assertions.assert(existsSync(path.join(projectRoot, "index.html")), "game entry was not produced");
      t.assertions.assert(git(projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      t.note(
        `pm=${pmSessionId} executor=${run?.executorSessionId} coder=${coder?.id} reviewer=${reviewer?.id} run=${runId}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
